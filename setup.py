#!/usr/bin/env python3
"""Portable installer. No credential files, transactions, or remote uploads."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import time
from urllib.request import build_opener, ProxyHandler, Request
from uuid import uuid4
from wallet_bridge import invoke, account_lock, bsc_address, BridgeError

ROOT=Path(__file__).resolve().parent
LOCAL=ROOT/'local'
CONFIG=LOCAL/'install.json'
SERVICE=LOCAL/'runtime/service.json'
IGNORE={'node_modules','vendor','runtime','local','.git','.baw','.ssh','.aws','.config','.cache','Library','AppData','Windows','Program Files','__pycache__','releases','venv','.venv'}

def read(path,default=None):
    if not path.is_file(): return default
    return json.loads(path.read_text(encoding='utf-8-sig'))

def save(path,data):
    path.parent.mkdir(parents=True,exist_ok=True,mode=0o700)
    temp=path.with_suffix('.tmp')
    with temp.open('w',encoding='utf-8') as f:
        os.chmod(temp,0o600);json.dump(data,f,ensure_ascii=False,indent=2);f.flush();os.fsync(f.fileno())
    os.replace(temp,path)

def verify_release():
    manifest=read(ROOT/'MANIFEST.json')
    if not manifest: raise RuntimeError('缺少文件清单，不能安装')
    for name,want in manifest['files'].items():
        p=ROOT/name
        if p.is_symlink() or not p.is_file() or hashlib.sha256(p.read_bytes()).hexdigest()!=want:
            raise RuntimeError('发布文件校验失败：'+name)
    return len(manifest['files'])

def find_wallet_dirs(roots):
    """Bounded filename scan; never descend into hidden or credential directories."""
    found=set();visited=set();count=0
    for root in roots:
        root=Path(root).expanduser()
        if not root.is_dir() or root.is_symlink(): continue
        for current,dirs,files in os.walk(root,followlinks=False):
            p=Path(current)
            if p in visited: dirs[:]=[];continue
            visited.add(p);count+=1
            depth=len(p.relative_to(root).parts)
            dirs[:]=sorted(d for d in dirs if not d.startswith('.') and d not in IGNORE and not (p/d).is_symlink() and depth<5)
            if count>6000: return sorted(found)
            if p.name=='wallet-containers' and 'accounts.json' in files:
                if any(re.fullmatch(r'account[1-5]\.(sh|ps1)',f) for f in files): found.add(p.resolve())
                dirs[:]=[]
    return sorted(found)

def entries_at(directory):
    directory=Path(directory).expanduser().resolve()
    if (directory/'wallet-containers').is_dir(): directory=directory/'wallet-containers'
    mapping=read(directory/'accounts.json',{})
    if not isinstance(mapping,dict): raise RuntimeError('accounts.json 不是公开地址映射')
    entries=[]
    for n in range(1,6):
        expected=mapping.get('account'+str(n))
        if not expected: continue
        if not isinstance(expected,str) or not re.fullmatch(r'0x[0-9a-fA-F]{40}',expected):
            raise RuntimeError('公开地址映射格式不符；不解析其他钱包数据文件')
        script=directory/('account'+str(n)+('.ps1' if os.name=='nt' else '.sh'))
        if not script.is_file() or script.is_symlink(): raise RuntimeError('缺少本系统对应的编号钱包入口')
        entries.append({'account':n,'address':expected,'kind':'numbered','command':[str(script)],'cwd':str(directory.parent)})
    return entries

def verify_entries(entries):
    verified=[];issues=[]
    for entry in entries:
        try:
            with account_lock(entry,timeout=15):
                status=invoke(entry,['wallet','status'],timeout=30)
                if status.get('success') is not True or status.get('data',{}).get('status')!='CONNECTED':
                    issues.append({'account':entry['account'],'code':'LOGIN_REQUIRED'});continue
                address=bsc_address(invoke(entry,['wallet','address'],timeout=30))
                if entry.get('address') and address.lower()!=entry['address'].lower():
                    issues.append({'account':entry['account'],'code':'ADDRESS_MISMATCH'});continue
                verified.append(dict(entry,address=address))
        except BridgeError:
            issues.append({'account':entry['account'],'code':'READ_ONLY_CHECK_FAILED'})
    if len({e['address'].lower() for e in verified})!=len(verified): raise RuntimeError('多个编号返回同一钱包，不能当成独立钱包绑定')
    return verified,issues

def discover(wallet_dir=None,scan_roots=None):
    dirs=[Path(wallet_dir)] if wallet_dir else find_wallet_dirs(scan_roots if scan_roots is not None else [Path.home()/'Documents',Path.home()/'Desktop',Path.home()/'Projects'])
    if len(dirs)>1: return [],[{'code':'CHOOSE_WALLET_DIRECTORY','candidates':[str(p) for p in dirs]}]
    if dirs:
        entries=entries_at(dirs[0])
        if not entries:return [],[{'code':'NO_PUBLIC_BINDINGS'}]
        return verify_entries(entries)
    baw=shutil.which('baw')
    if baw:
        return verify_entries([{'account':1,'kind':'official-cli','command':[str(Path(baw).absolute())],'cwd':str(ROOT)}])
    return [],[{'code':'NO_WALLET_ENTRY','hint':'安装官方 Binance Agentic Wallet CLI，按官方技能通过 App 登录；不导入私钥。'}]

def node_and_npm():
    node=shutil.which('node');npm=shutil.which('npm')
    if not node or not npm: raise RuntimeError('需要 Node.js 24+ 和 npm。请让 AI 从 nodejs.org 或本机包管理器安装后重试。')
    r=subprocess.run([node,'--version'],capture_output=True,text=True,timeout=10)
    m=re.fullmatch(r'v(\d+)\.\d+\.\d+\s*',r.stdout)
    if r.returncode or not m or int(m[1])<24: raise RuntimeError('需要 Node.js 24+；不要删除或覆盖已有钱包环境')
    return node,npm

def dependencies(node,npm):
    package=ROOT/'trade-console/package-lock.json'
    for item in read(package)['packages'].values():
        url=item.get('resolved','')
        if url and not url.startswith('https://registry.npmjs.org/'): raise RuntimeError('依赖来源不是预期的 npm 官方仓库')
    marker=LOCAL/'dependencies.json';want=hashlib.sha256(package.read_bytes()).hexdigest()
    if read(marker,{}).get('sha256')==want and (ROOT/'trade-console/node_modules/ethers/package.json').is_file():return
    # npm uses a blank package-local config; no publishing credentials are needed.
    config=LOCAL/'empty-npmrc';config.write_text('',encoding='utf-8');os.chmod(config,0o600)
    command=[npm,'ci','--ignore-scripts','--no-audit','--no-fund','--registry=https://registry.npmjs.org/','--userconfig='+str(config)]
    if os.name=='nt':
        from wallet_bridge import launch_args
        command=launch_args({'command':[npm]},command[1:])
    env=dict(os.environ,NODE_USE_ENV_PROXY='1')
    with (LOCAL/'dependency-install.log').open('w') as log:
        os.chmod(LOCAL/'dependency-install.log',0o600)
        result=subprocess.run(command,cwd=ROOT/'trade-console',env=env,stdout=log,stderr=log,timeout=240)
    if result.returncode: raise RuntimeError('依赖安装失败，查看 local/dependency-install.log；不需要提供任何密钥')
    save(marker,{'sha256':want})

def http(url,payload=None,token=None):
    headers={'content-type':'application/json'}
    if token: headers['x-console-token']=token
    req=Request(url,data=None if payload is None else json.dumps(payload).encode(),headers=headers)
    with build_opener(ProxyHandler({})).open(req,timeout=3) as r:return json.load(r)

def current(cfg):
    service=read(SERVICE,{})
    if service.get('installationId')!=cfg.get('installationId'):return None
    port=service.get('port')
    if not isinstance(port,int) or not 1<=port<=65535:return None
    url='http://127.0.0.1:'+str(port)
    try: state=http(url+'/api/bootstrap')
    except (OSError,ValueError):return None
    if state.get('service')!='agent-trade-console' or state.get('installationId')!=cfg['installationId']:return None
    return url,state

def stop(cfg):
    running=current(cfg)
    if not running:return {'stopped':True,'alreadyStopped':True}
    url,state=running
    http(url+'/api/shutdown',{},state['token'])
    for _ in range(50):
        if not current(cfg):return {'stopped':True}
        time.sleep(.1)
    raise RuntimeError('服务尚未停止，不强制杀进程或中断待核对原单')

def start(cfg,live=False):
    running=current(cfg)
    desired='LIVE' if live else 'SIMULATION'
    if running:
        if running[1]['mode']!=desired: raise RuntimeError('当前服务模式不同。先运行 python3 setup.py stop，再启动所需模式')
        return running[0],running[1]
    cfg=dict(cfg,liveEnabled=bool(live));save(CONFIG,cfg)
    runtime=LOCAL/'runtime';runtime.mkdir(exist_ok=True,mode=0o700)
    command=[cfg['node'],str(ROOT/'trade-console/server.mjs')]+(['--live'] if live else [])
    env=dict(os.environ,NODE_USE_ENV_PROXY='1')
    options={'start_new_session':True} if os.name!='nt' else {'creationflags':subprocess.CREATE_NEW_PROCESS_GROUP|subprocess.DETACHED_PROCESS}
    with (runtime/'service.log').open('a') as log:
        os.chmod(runtime/'service.log',0o600)
        child=subprocess.Popen(command,cwd=ROOT,env=env,stdin=subprocess.DEVNULL,stdout=log,stderr=log,**options)
    for _ in range(100):
        running=current(cfg)
        if running:return running
        if child.poll() is not None: raise RuntimeError('服务启动失败；查看 local/runtime/service.log')
        time.sleep(.1)
    raise RuntimeError('服务仍未就绪，未连接其他安装的服务')

def main():
    parser=argparse.ArgumentParser(description='默认安装、只读绑定钱包、启动模拟看板，输出 JSON 和本机网址')
    parser.add_argument('action',choices=['install','start','stop','status','discover','verify'],nargs='?',default='install')
    parser.add_argument('--wallet-dir',help='已有 wallet-containers 目录；只读取 accounts.json 公开地址映射')
    parser.add_argument('--scan-root',action='append',help='限定公开钱包入口目录搜索，可重复')
    parser.add_argument('--no-wallet',action='store_true',help='启动空钱包看板，不搜索和调用本机钱包')
    parser.add_argument('--live',action='store_true',help='仅收到使用者另行明确指令后启用真实交易；默认模拟')
    args=parser.parse_args()
    os.umask(0o077)
    try:
        count=verify_release()
        if args.action=='verify':return {'success':True,'verifiedFiles':count}
        if args.live and args.action!='start':raise RuntimeError('--live 仅用于 start；安装过程不启用真实交易')
        if args.no_wallet and args.wallet_dir:raise RuntimeError('--no-wallet 与 --wallet-dir 不能同时使用')
        if args.action=='discover':
            dirs=find_wallet_dirs(args.scan_root or [Path.home()/'Documents',Path.home()/'Desktop',Path.home()/'Projects'])
            return {'success':True,'directories':[str(p) for p in dirs],'credentialsRead':False}
        cfg=read(CONFIG)
        if args.action=='stop':return {'success':True,**(stop(cfg) if cfg else {'stopped':True,'alreadyStopped':True})}
        if args.action=='status':
            running=current(cfg) if cfg else None
            return {'success':True,'running':bool(running),'url':running[0] if running else None,'mode':running[1]['mode'] if running else None}
        node,npm=node_and_npm()
        LOCAL.mkdir(exist_ok=True,mode=0o700)
        if args.action=='install':
            if cfg and current(cfg):
                if args.wallet_dir or args.no_wallet or args.scan_root:raise RuntimeError('重新绑定前请先停止本安装的服务，不修改运行中的钱包配置')
                url,state=current(cfg)
                return {'success':True,'url':url,'mode':state['mode'],'walletCount':len(state['wallets']),'alreadyInstalled':True}
            dependencies(node,npm)
            if cfg and cfg.get('wallets') and not (args.wallet_dir or args.no_wallet or args.scan_root):
                wallets,issues=verify_entries(cfg.get('wallets',[]))
            else:wallets,issues=([],[]) if args.no_wallet else discover(args.wallet_dir,args.scan_root)
            cfg={'schema':1,'installationId':cfg['installationId'] if cfg else str(uuid4()),'python':sys.executable,'node':node,'wallets':wallets,'issues':issues,'liveEnabled':False,**({'openFourScript':cfg['openFourScript']} if cfg and cfg.get('openFourScript') else {})}
            save(CONFIG,cfg)
        elif not cfg:raise RuntimeError('请先运行 python3 setup.py')
        # Starting after moving the unpacked folder uses the currently available runtime.
        cfg=dict(cfg,python=sys.executable,node=node)
        if not current(cfg):save(CONFIG,cfg)
        url,state=start(cfg,args.live)
        return {'success':True,'url':url,'mode':state['mode'],'walletCount':len(state['wallets']),'issues':cfg.get('issues',[]),'submittedTransactions':0,'next':'打开 url；没有钱包时按 START_HERE.md 接入后重新安装。'}
    except Exception as e:
        return {'success':False,'error':str(e),'submittedTransactions':0}

if __name__=='__main__':
    try:
        with account_lock({'command':[str(ROOT/'setup.py')]},timeout=10):result=main()
    except BridgeError:
        result={'success':False,'error':'另一个安装/启停操作正在进行，稍后重试；未更改钱包','submittedTransactions':0}
    print(json.dumps(result,ensure_ascii=False,indent=2));sys.exit(0 if result.get('success') else 1)
