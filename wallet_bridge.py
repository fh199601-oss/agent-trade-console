"""JSONL bridge. Reuses the recipient's launcher; never opens a wallet store."""
import base64
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time
import threading
import signal
import re
from contextlib import contextmanager
sys.path.insert(0,str(Path(__file__).resolve().parent))
from runtime_paths import LOCAL, hidden_process_options, runtime_environment, configure_stdio

ROOT = Path(__file__).resolve().parent
READS = {('wallet', n) for n in ('status','address','settings','agent-id','balance','gas-price','tx-history','tx-lock')}
READS |= {('market-order','quote'),('market-order','list'),('contract-call','preview')}
WRITES = {('contract-call','execute'),('market-order','swap')}
_environment_cache={}
_environment_locks={}
_environment_guard=threading.Lock()

class BridgeError(Exception):
    def __init__(self, message, dispatched=False):
        super().__init__(message)
        self.dispatched = dispatched

def check_environment(entry):
    """Recognized legacy Docker wrappers only; never start/repair Docker here."""
    if entry.get('kind')!='numbered': return
    target=Path(entry['command'][0]);context=None
    source=target.parent/('wallet.ps1' if target.suffix.lower()=='.ps1' else 'wallet_mac.py')
    if source.is_file() and not source.is_symlink() and source.stat().st_size<300_000:
        text=source.read_text(encoding='utf-8-sig',errors='replace')
        if "'desktop-linux'" in text and 'docker' in text.lower():context='desktop-linux'
        elif sys.platform=='darwin' and 'BAW_DOCKER_CONTEXT' in text and 'colima' in text:context='colima'
    if not context:return
    with _environment_guard: lock=_environment_locks.setdefault(context,threading.Lock())
    with lock:
        cached=_environment_cache.get(context)
        if cached and cached[0]>time.monotonic():
            if cached[1]:return
            e=BridgeError('现有编号钱包环境未就绪，请启动原环境后重查；未修改 Docker。');e.code='WALLET_ENVIRONMENT_NOT_READY';raise e
        ready=_docker_ready(context)
        _environment_cache[context]=(time.monotonic()+(30 if ready else 5),ready)
    if not ready:
        e=BridgeError('现有编号钱包需要 Docker（'+context+'），引擎未就绪；请先启动原钱包环境，再重试接入。看板不会反复启动或修改 Docker。')
        e.code='WALLET_ENVIRONMENT_NOT_READY';raise e

def _docker_ready(context):
    docker=shutil.which('docker',path=runtime_environment()['PATH'])
    ready=False
    if docker:
        try:
            r=subprocess.run([docker,'--context',context,'info','--format','{{.ServerVersion}}'],capture_output=True,timeout=4,**hidden_process_options())
            ready=r.returncode==0
        except (OSError,subprocess.TimeoutExpired):pass
    return ready

def launch_args(entry, args):
    command = entry['command']
    if not isinstance(command,list) or not command or not all(isinstance(x,str) and x for x in command):
        raise BridgeError('钱包入口配置无效')
    target=Path(command[0])
    if not target.is_absolute() or not target.is_file():
        raise BridgeError('钱包入口不存在；重新运行安装器绑定')
    if command.count('{args}')>1:raise BridgeError('钱包参数占位符重复')
    expanded=[part for item in command for part in (list(args) if item=='{args}' else [item])] if '{args}' in command else [*command,*args]
    # No shell interpolation. PowerShell single-quoted strings escape embedded quotes.
    if target.suffix.lower() in ('.ps1','.cmd','.bat'):
        ps=shutil.which('pwsh') or shutil.which('powershell')
        if not ps: raise BridgeError('此钱包入口需要 PowerShell')
        literal=lambda s: "'"+s.replace("'","''")+"'"
        # A quoted '-Account' becomes a positional value for .ps1 scripts.
        # Emit only strictly validated option names as syntax; all values stay
        # quoted, including apostrophes, $(), semicolons and script paths.
        psarg=lambda s:s if target.suffix.lower()=='.ps1' and re.fullmatch(r'-[A-Za-z][A-Za-z0-9_]*',s) else literal(s)
        script="[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false); $OutputEncoding = [Console]::OutputEncoding; & "+literal(expanded[0])+' '+ ' '.join(map(psarg,expanded[1:]))+'; exit $LASTEXITCODE'
        return [ps,'-NoLogo','-NoProfile','-NonInteractive','-WindowStyle','Hidden','-EncodedCommand',base64.b64encode(script.encode('utf-16le')).decode('ascii')]
    if target.suffix.lower()=='.sh':
        if os.name=='nt':raise BridgeError('Windows 请使用原生钱包入口或显式的 WSL 入口清单，不自动切换环境')
        return [shutil.which('sh') or '/bin/sh',*expanded]
    if target.suffix.lower()=='.py':return [sys.executable,*expanded]
    if target.suffix.lower() in ('.js','.mjs'):
        node=shutil.which('node',path=runtime_environment()['PATH'])
        if not node:raise BridgeError('缺少 Node 运行环境，请使用完整便携包')
        return [node,*expanded]
    return expanded

@contextmanager
def account_lock(entry, timeout=90):
    # Shared between installations. Existing numbered launcher still supplies its
    # original cross-chat lock; this outer lock also serializes host CLI sessions.
    identity=['lockGroup',entry['lockGroup']] if entry.get('lockGroup') else entry['command']
    key=hashlib.sha256(json.dumps(identity,ensure_ascii=True).encode()).hexdigest()
    root=Path.home()/'.cache/agent-trade-console/locks'
    root.mkdir(parents=True,exist_ok=True,mode=0o700)
    p=root/(key+'.lock')
    with p.open('a+b') as f:
        os.chmod(p,0o600)
        f.seek(0,2)
        if f.tell()==0: f.write(b'0');f.flush()
        start=time.monotonic()
        while True:
            try:
                if os.name=='nt':
                    import msvcrt
                    f.seek(0);msvcrt.locking(f.fileno(),msvcrt.LK_NBLCK,1)
                else:
                    import fcntl
                    fcntl.flock(f,fcntl.LOCK_EX|fcntl.LOCK_NB)
                break
            except (OSError,BlockingIOError):
                if time.monotonic()-start>=timeout: raise BridgeError('钱包正被其他进程使用，本次未发送命令')
                time.sleep(.05)
        try: yield
        finally:
            if os.name=='nt':
                f.seek(0);msvcrt.locking(f.fileno(),msvcrt.LK_UNLCK,1)
            else: fcntl.flock(f,fcntl.LOCK_UN)

def invoke(entry,args,timeout=100):
    args=list(args)
    if '--json' not in args: args.append('--json')
    env=runtime_environment()
    if sys.platform=='darwin' and entry.get('kind')=='numbered': env['BAW_DOCKER_CONTEXT']='colima'
    try:
        r=run_command(launch_args(entry,args),cwd=entry['cwd'],env=env,timeout=timeout)
    except subprocess.TimeoutExpired:
        e=BridgeError('钱包入口超时，已结束本次调用；写操作只跟踪原单，禁止自动重试',True);e.code='WALLET_ENTRY_TIMEOUT';raise e
    except OSError: raise BridgeError('钱包入口无法启动，请检查依赖及权限')
    if len(r.stdout)>8_000_000: raise BridgeError('钱包响应过大',True)
    # Never print stderr or raw output: it may contain upstream authentication data.
    try:
        parsed=json.loads(r.stdout.strip())
    except (ValueError,TypeError): raise BridgeError('钱包未返回标准 JSON；请检查入口的 --json 支持',True)
    if not isinstance(parsed,dict): raise BridgeError('钱包响应格式无效',True)
    if r.returncode and parsed.get('success') is True: raise BridgeError('钱包返回状态不一致',True)
    return parsed

def run_command(command,*,cwd,env,timeout):
    # Killing only Python/PowerShell can leave its child CLI holding stdout and
    # an account lock. Bound the whole invocation, never a shared wallet daemon.
    options=hidden_process_options()
    if os.name!='nt':options['start_new_session']=True
    child=subprocess.Popen(command,cwd=cwd,env=env,stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,encoding='utf-8-sig',errors='replace',**options)
    try:
        out,err=child.communicate(timeout=timeout)
        return subprocess.CompletedProcess(command,child.returncode,out,err)
    except subprocess.TimeoutExpired:
        if os.name=='nt':
            try:subprocess.run(['taskkill','/PID',str(child.pid),'/T','/F'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=3,**hidden_process_options())
            except (OSError,subprocess.TimeoutExpired):child.kill()
        else:
            try:os.killpg(child.pid,signal.SIGKILL)
            except ProcessLookupError:pass
        try:child.communicate(timeout=1)
        except subprocess.TimeoutExpired:
            child.stdout.close();child.stderr.close()
        raise

def bsc_address(response):
    data=response.get('data') if response.get('success') is True else None
    rows=data.get('addresses',[]) if isinstance(data,dict) else []
    if not isinstance(rows,list):raise BridgeError('钱包未返回地址列表，不能绑定')
    selected=[r.get('address','') for r in rows if isinstance(r,dict) and str(r.get('binanceChainId'))=='56']
    import re
    if len(selected)!=1 or not re.fullmatch(r'0x[0-9a-fA-F]{40}',selected[0]):
        raise BridgeError('未获得唯一 BSC 公开地址，不能绑定')
    return selected[0]

def dispatch(entry,args,live=False,*,read_only_timeout_ms=None,background=False):
    if not isinstance(args,list) or len(args)<2 or not all(isinstance(x,str) for x in args):
        raise BridgeError('钱包参数无效')
    action=tuple(args[:2])
    if action not in READS|WRITES: raise BridgeError('此入口不允许登录、导出、转账或其他未实现的命令')
    writing=action in WRITES
    if writing and not live: raise BridgeError('当前进程不允许签名和提交')
    timeout=100
    if not writing and read_only_timeout_ms is not None:
        if type(read_only_timeout_ms) not in (int,float) or not 100<=read_only_timeout_ms<=30000:raise BridgeError('只读请求限时无效')
        timeout=read_only_timeout_ms/1000
    with account_lock(entry,timeout=0 if background and not writing else min(90,timeout)):
        check_environment(entry)
        if writing:
            current=bsc_address(invoke(entry,['wallet','address']))
            if current.lower()!=entry['address'].lower(): raise BridgeError('钱包地址改变；已停止，不发送交易')
        return invoke(entry,args,timeout=timeout)

def main():
    cfg=json.loads((LOCAL/'install.json').read_text(encoding='utf-8'))
    account=int(sys.argv[1])
    entry=next(w for w in cfg['wallets'] if w['account']==account)
    # Bound to server startup mode, not a UI value or a website's instructions.
    live=cfg.get('liveEnabled') is True
    print(json.dumps({'ready':True}),flush=True)
    for line in sys.stdin:
        req={}
        try:
            if len(line)>200_000: raise BridgeError('钱包请求过大')
            req=json.loads(line)
            result=dispatch(entry,req['args'],live,read_only_timeout_ms=req.get('readOnlyTimeoutMs'),background=req.get('background') is True)
        except Exception as e:
            result={'success':False,'error':{'code':getattr(e,'code','LOCAL_BRIDGE_ERROR'),'message':str(e) if isinstance(e,BridgeError) else '钱包桥接请求无效','commandDispatched':getattr(e,'dispatched',False)}}
        print(json.dumps({'id':req.get('id'),'result':result},ensure_ascii=False),flush=True)

if __name__=='__main__':
    configure_stdio()
    main()
