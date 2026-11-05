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
from concurrent.futures import ThreadPoolExecutor, as_completed
# Embedded Windows Python intentionally omits the script directory. Resolve
# only this entry's own directory, independent of cwd/PYTHONPATH/user sites.
sys.path.insert(0,str(Path(__file__).resolve().parent))
from wallet_bridge import invoke, account_lock, bsc_address, BridgeError, check_environment
from runtime_paths import LOCAL, hidden_process_options, runtime_environment, configure_stdio
from wallet_sources import entries_at, read_entrypoints, entry_from_argument, MAP_NAME, SCRIPT, MAX_WALLETS, public_path
from wallet_safety import bind_environment, WalletSafetyError

ROOT=Path(__file__).resolve().parent
CONFIG=LOCAL/'install.json'
SERVICE=LOCAL/'runtime/service.json'
IGNORE={'node_modules','vendor','runtime','local','.git','.baw','.ssh','.aws','.config','.cache','Library','AppData','Windows','Program Files','__pycache__','releases','venv','.venv'}
progress=lambda message:None

class ScanResults(list):
    def __init__(self,values=(),truncated=False):
        super().__init__(values);self.truncated=truncated

def default_scan_roots():
    roots=[Path.home()/n for n in ('Documents','Desktop','Projects')]
    for name in ('OneDrive','OneDriveConsumer','OneDriveCommercial'):
        if os.environ.get(name): roots.extend(Path(os.environ[name])/n for n in ('Documents','Desktop'))
    return list(dict.fromkeys(roots))

def read(path,default=None):
    if not path.is_file(): return default
    return json.loads(path.read_text(encoding='utf-8-sig'))

def save(path,data):
    path.parent.mkdir(parents=True,exist_ok=True,mode=0o700)
    temp=path.with_name(path.name+'.'+str(uuid4())+'.tmp')
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
    found=set();visited=set();count=0;deadline=time.monotonic()+3;ignored={x.casefold() for x in IGNORE}
    for root in roots:
        root=Path(root).expanduser()
        if not root.is_dir() or root.is_symlink() or root.name.casefold() in ignored: continue
        # A specific public pool may live under AppData/Library. Those broad
        # trees are not search roots, but their names aren't credential stores.
        try: public_path(root.absolute())
        except ValueError: continue
        for current,dirs,files in os.walk(root,followlinks=False):
            p=Path(current)
            if p in visited: dirs[:]=[];continue
            visited.add(p);count+=1
            depth=len(p.relative_to(root).parts)
            dirs[:]=sorted(d for d in dirs if not d.startswith('.') and d.casefold() not in ignored and not (p/d).is_symlink() and depth<5)
            if count>6000 or time.monotonic()>deadline: return ScanResults(sorted(found),truncated=True)
            if MAP_NAME in files or any(SCRIPT.fullmatch(f) for f in files):
                found.add(p.resolve())
                dirs[:]=[]
    return ScanResults(sorted(found))

def verify_entries(entries,timeout=30,workers=4):
    if not 1<=workers<=8 or not 1<=timeout<=120: raise ValueError('验证并发为 1–8，总限时为 1–120 秒')
    if len(entries)>MAX_WALLETS or len({e['account'] for e in entries})!=len(entries):raise ValueError('钱包编号重复或数量超过 200')
    verified=[];issues=[];deadline=time.monotonic()+timeout;done=0
    def remaining():
        seconds=deadline-time.monotonic()
        if seconds<=0:
            e=BridgeError('本次钱包验证时间已用完；请单独重查此账号，不反复重装');e.code='WALLET_CHECK_BUDGET';raise e
        return seconds
    def check(entry):
        try:
            with account_lock(entry,timeout=min(3,remaining())):
                remaining();entry=bind_environment(entry);check_environment(entry)
                status=invoke(entry,['wallet','status'],timeout=min(12,remaining()))
                if status.get('success') is not True or not isinstance(status.get('data'),dict):
                    return None,{'account':entry['account'],'code':'WALLET_STATUS_FAILED','message':'原入口未返回可核验状态；先检查运行环境，不切换 CLI、自动重登或重置会话'}
                if status['data'].get('status')!='CONNECTED':
                    return None,{'account':entry['account'],'code':'WALLET_DISCONNECTED','message':'原入口返回未连接；请先核对原账号池是否同样离线，不因安装失败自动注销或重新登录'}
                address=bsc_address(invoke(entry,['wallet','address'],timeout=min(12,remaining())))
                if entry.get('address') and address.lower()!=entry['address'].lower():
                    return None,{'account':entry['account'],'code':'ADDRESS_MISMATCH'}
                return dict(entry,address=address),None
        except (BridgeError,WalletSafetyError) as e:
            return None,{'account':entry['account'],'code':getattr(e,'code','READ_ONLY_CHECK_FAILED'),'message':str(e)}
        except (ValueError,TypeError,KeyError,OSError):
            return None,{'account':entry['account'],'code':'INVALID_ENTRY_RESPONSE','message':'入口未返回兼容的公开钱包状态；检查适配器，不要解析登录文件'}
    with ThreadPoolExecutor(max_workers=workers) as pool:
        for future in as_completed([pool.submit(check,entry) for entry in entries]):
            entry,issue=future.result();done+=1
            if entry:verified.append(entry)
            if issue:issues.append(issue)
            progress(f'只读核验钱包 {done}/{len(entries)} · 已接入 {len(verified)} · 待处理 {len(issues)}')
    if len({e['address'].lower() for e in verified})!=len(verified): raise RuntimeError('多个编号返回同一钱包，不能当成独立钱包绑定')
    return sorted(verified,key=lambda e:e['account']),sorted(issues,key=lambda e:e['account'])

def discover(wallet_dir=None,scan_roots=None,*,wallet_map=None,wallet_entries=None,timeout=30,workers=4):
    if wallet_map:return verify_entries(read_entrypoints(wallet_map),timeout,workers)
    if wallet_entries:return verify_entries([entry_from_argument(x) for x in wallet_entries],timeout,workers)
    dirs=[Path(wallet_dir)] if wallet_dir else find_wallet_dirs(scan_roots if scan_roots is not None else default_scan_roots())
    if getattr(dirs,'truncated',False):return [],[{'code':'WALLET_SEARCH_LIMIT','candidates':[str(p) for p in dirs],'hint':'目录搜索已达到时间或数量预算；直接使用已有入口路径/公开清单，不继续扩大搜索或改用默认钱包。'}]
    if len(dirs)>1: return [],[{'code':'CHOOSE_WALLET_DIRECTORY','candidates':[str(p) for p in dirs]}]
    if dirs:
        entries=entries_at(dirs[0])
        if not entries:return [],[{'code':'WALLET_ADAPTER_REQUIRED','hint':'目录没有标准编号入口；让安装 AI 将已有启动命令写入 wallet-entrypoints.json，再用 --wallet-map 直接接入。不要解析钱包存储。'}]
        return verify_entries(entries,timeout,workers)
    return [],[{'code':'NO_WALLET_ENTRY','hint':'请提供原钱包公开启动入口或接入清单；不会尝试主机默认 CLI、其他版本或读取登录目录。'}]

def node_and_npm():
    bundled=ROOT/'portable/node'/('node.exe' if os.name=='nt' else 'bin/node')
    node=str(bundled) if bundled.is_file() else shutil.which('node')
    npm=shutil.which('npm',path=runtime_environment()['PATH'])
    if node and (ROOT/'PORTABLE.json').is_file(): return node,npm
    if not node or not npm: raise RuntimeError('需要 Node.js 24+ 和 npm。请让 AI 从 nodejs.org 或本机包管理器安装后重试。')
    r=subprocess.run([node,'--version'],capture_output=True,text=True,timeout=10,**hidden_process_options())
    m=re.fullmatch(r'v(\d+)\.\d+\.\d+\s*',r.stdout)
    if r.returncode or not m or int(m[1])<24: raise RuntimeError('需要 Node.js 24+；不要删除或覆盖已有钱包环境')
    return node,npm

def dependencies(node,npm):
    package=ROOT/'trade-console/package-lock.json'
    if (ROOT/'PORTABLE.json').is_file():
        # Every bundled runtime/dependency file is included in MANIFEST.json.
        if not (ROOT/'trade-console/node_modules/ethers/package.json').is_file():raise RuntimeError('便携包依赖不完整，请重新解压官方发行包')
        return
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
    env=runtime_environment()
    with (LOCAL/'dependency-install.log').open('w') as log:
        os.chmod(LOCAL/'dependency-install.log',0o600)
        result=subprocess.run(command,cwd=ROOT/'trade-console',env=env,stdout=log,stderr=log,timeout=240,**hidden_process_options())
    if result.returncode: raise RuntimeError('依赖安装失败，查看 '+str(LOCAL/'dependency-install.log')+'；不需要提供任何密钥')
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

def start(cfg,live=True):
    running=current(cfg)
    if not live: raise RuntimeError('用户运行入口仅提供真实交易模式；预览接口仍不提交交易')
    desired='LIVE'
    if running:
        if running[1]['mode']!=desired: raise RuntimeError('当前服务模式不同。先运行 python3 setup.py stop，再启动所需模式')
        return running[0],running[1]
    cfg=dict(cfg,liveEnabled=bool(live));save(CONFIG,cfg)
    runtime=LOCAL/'runtime';runtime.mkdir(exist_ok=True,mode=0o700)
    command=[cfg['node'],str(ROOT/'trade-console/server.mjs')]
    env=runtime_environment()
    options={'start_new_session':True} if os.name!='nt' else hidden_process_options()
    with (runtime/'service.log').open('a') as log:
        os.chmod(runtime/'service.log',0o600)
        child=subprocess.Popen(command,cwd=ROOT,env=env,stdin=subprocess.DEVNULL,stdout=log,stderr=log,**options)
    for _ in range(100):
        running=current(cfg)
        if running:return running
        if child.poll() is not None: raise RuntimeError('服务启动失败；查看 '+str(runtime/'service.log'))
        time.sleep(.1)
    raise RuntimeError('服务仍未就绪，未连接其他安装的服务')

def main():
    parser=argparse.ArgumentParser(description='安装并只读接入本机钱包，启动真实交易看板；安装不下单，交易仍需本人操作')
    parser.add_argument('action',choices=['install','start','stop','status','discover','verify'],nargs='?',default='install')
    parser.add_argument('--wallet-dir',help='已有账号池目录或工作区；识别公开清单与编号脚本，跳过全盘搜索')
    parser.add_argument('--wallet-map',help='AI 生成的 wallet-entrypoints.json 公开启动清单，跳过搜索')
    parser.add_argument('--wallet-entry',action='append',help='编号=完整启动脚本路径，可重复；跳过搜索')
    parser.add_argument('--recheck-wallets',action='store_true',help='重查已保存的入口；正常启动不重复安装核验')
    parser.add_argument('--wallet-timeout',type=float,default=30,help='全部钱包核验的总时间预算，默认 30 秒')
    parser.add_argument('--wallet-workers',type=int,default=4,help='独立钱包只读验证并发，默认 4，范围 1–8')
    parser.add_argument('--scan-root',action='append',help='限定公开钱包入口目录搜索，可重复')
    parser.add_argument('--no-wallet',action='store_true',help='启动空钱包看板，不搜索和调用本机钱包')
    parser.add_argument('--live',action='store_true',help=argparse.SUPPRESS)
    args=parser.parse_args()
    os.umask(0o077)
    try:
        progress('正在检查发行文件完整性…');count=verify_release()
        if args.action=='verify':return {'success':True,'verifiedFiles':count}
        if sum(bool(x) for x in [args.no_wallet,args.wallet_dir,args.wallet_map,args.wallet_entry])>1:raise RuntimeError('请选择一种钱包接入方式，不要混用参数')
        explicit=bool(args.wallet_dir or args.wallet_map or args.wallet_entry or args.no_wallet or args.scan_root)
        if args.action=='discover':
            if args.wallet_map or args.wallet_entry or args.wallet_dir:
                rows=read_entrypoints(args.wallet_map) if args.wallet_map else [entry_from_argument(x) for x in args.wallet_entry] if args.wallet_entry else entries_at(args.wallet_dir)
                return {'success':True,'entries':[{'account':r['account'],'entrypoint':r['command'][0]} for r in rows],'credentialsRead':False,'walletCommands':0,'next':'使用相同路径参数执行 install，只读核验后自动打开看板。'}
            dirs=find_wallet_dirs(args.scan_root or default_scan_roots())
            return {'success':True,'directories':[str(p) for p in dirs],'scanComplete':not getattr(dirs,'truncated',False),'credentialsRead':False}
        cfg=read(CONFIG)
        if args.action=='stop':return {'success':True,**(stop(cfg) if cfg else {'stopped':True,'alreadyStopped':True})}
        if args.action=='status':
            running=current(cfg) if cfg else None
            return {'success':True,'running':bool(running),'url':running[0] if running else None,'mode':running[1]['mode'] if running else None}
        node,npm=node_and_npm()
        LOCAL.mkdir(parents=True,exist_ok=True,mode=0o700)
        if args.action=='install':
            if cfg and current(cfg):
                if explicit or args.recheck_wallets:raise RuntimeError('重新绑定前请先停止本安装的服务，不修改运行中的钱包配置')
                url,state=current(cfg)
                if state['mode']!='LIVE':
                    stop(cfg)
                else:return {'success':True,'url':url,'mode':state['mode'],'walletCount':len(state['wallets']),'issues':cfg.get('issues',[]),'alreadyInstalled':True,'dataDir':str(LOCAL)}
            progress('正在准备运行环境…');dependencies(node,npm)
            progress('正在只读检查钱包入口；不会登录、签名或交易…')
            started=time.monotonic()
            environment_upgrade=bool(cfg and any(not w.get('execution') for w in cfg.get('wallets',[])))
            if cfg and cfg.get('wallets') and not explicit:
                wallets,issues=verify_entries(cfg['wallets'],args.wallet_timeout,args.wallet_workers) if args.recheck_wallets or environment_upgrade else (cfg['wallets'],cfg.get('issues',[]))
            else:wallets,issues=([],[]) if args.no_wallet else discover(args.wallet_dir,args.scan_root,wallet_map=args.wallet_map,wallet_entries=args.wallet_entry,timeout=args.wallet_timeout,workers=args.wallet_workers)
            if cfg and cfg.get('wallets') and not explicit:
                # A transient Docker/login failure must not erase saved bindings.
                verified={w['account']:w for w in wallets}
                wallets=[verified.get(w['account'],w) for w in cfg['wallets']]
            python=str(Path(sys.executable).with_name('python.exe')) if Path(sys.executable).name.lower()=='pythonw.exe' else sys.executable
            check_info={'elapsedMs':round((time.monotonic()-started)*1000),'budgetSeconds':args.wallet_timeout,'workers':args.wallet_workers,'environmentUpgrade':environment_upgrade,'savedBindingsReused':bool(cfg and cfg.get('wallets') and not explicit and not args.recheck_wallets and not environment_upgrade)}
            cfg={'schema':1,'installationId':cfg['installationId'] if cfg else str(uuid4()),'python':python,'node':node,'wallets':wallets,'issues':issues,'walletCheck':check_info,'liveEnabled':True,**({'openFourScript':cfg['openFourScript']} if cfg and cfg.get('openFourScript') else {})}
            save(CONFIG,cfg)
        elif not cfg:raise RuntimeError('请先运行 python3 setup.py')
        # Starting after moving the unpacked folder uses the currently available runtime.
        python=str(Path(sys.executable).with_name('python.exe')) if Path(sys.executable).name.lower()=='pythonw.exe' else sys.executable
        cfg=dict(cfg,python=python,node=node)
        if not current(cfg):save(CONFIG,cfg)
        progress('正在启动本地看板…');url,state=start(cfg)
        return {'success':True,'url':url,'mode':state['mode'],'walletCount':len(state['wallets']),'issues':cfg.get('issues',[]),'walletCheck':cfg.get('walletCheck',{}),'dataDir':str(LOCAL),'submittedTransactions':0,'next':'打开 url；有未接入账号时按 issues 定点处理，不要反复全盘搜索或重装。'}
    except Exception as e:
        return {'success':False,'error':str(e),'submittedTransactions':0}

if __name__=='__main__':
    configure_stdio()
    try:
        with account_lock({'command':[str(ROOT/'setup.py')]},timeout=10):result=main()
    except BridgeError:
        result={'success':False,'error':'另一个安装/启停操作正在进行，稍后重试；未更改钱包','submittedTransactions':0}
    print(json.dumps(result,ensure_ascii=False,indent=2));sys.exit(0 if result.get('success') else 1)
