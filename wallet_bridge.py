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
from contextlib import contextmanager

ROOT = Path(__file__).resolve().parent
READS = {('wallet', n) for n in ('status','address','settings','agent-id','balance','gas-price','tx-history','tx-lock')}
READS |= {('market-order','quote'),('market-order','list'),('contract-call','preview')}
WRITES = {('contract-call','execute'),('market-order','swap')}

class BridgeError(Exception):
    def __init__(self, message, dispatched=False):
        super().__init__(message)
        self.dispatched = dispatched

def launch_args(entry, args):
    command = entry['command']
    if not isinstance(command,list) or not command or not all(isinstance(x,str) and x for x in command):
        raise BridgeError('钱包入口配置无效')
    target=Path(command[0])
    if not target.is_absolute() or not target.is_file():
        raise BridgeError('钱包入口不存在；重新运行安装器绑定')
    # No shell interpolation. PowerShell single-quoted strings escape embedded quotes.
    if target.suffix.lower() in ('.ps1','.cmd','.bat'):
        ps=shutil.which('pwsh') or shutil.which('powershell')
        if not ps: raise BridgeError('此钱包入口需要 PowerShell')
        literal=lambda s: "'"+s.replace("'","''")+"'"
        script='& '+ ' '.join(map(literal,command+args))+'; exit $LASTEXITCODE'
        return [ps,'-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',base64.b64encode(script.encode('utf-16le')).decode('ascii')]
    if target.suffix.lower()=='.sh':
        return [shutil.which('sh') or '/bin/sh',*command,*args]
    return [*command,*args]

@contextmanager
def account_lock(entry, timeout=90):
    # Shared between installations. Existing numbered launcher still supplies its
    # original cross-chat lock; this outer lock also serializes host CLI sessions.
    key=hashlib.sha256(json.dumps(entry['command'],ensure_ascii=True).encode()).hexdigest()
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
    env=dict(os.environ,NODE_USE_ENV_PROXY='1')
    if sys.platform=='darwin' and entry.get('kind')=='numbered': env['BAW_DOCKER_CONTEXT']='colima'
    try:
        r=subprocess.run(launch_args(entry,args),cwd=entry['cwd'],env=env,capture_output=True,text=True,timeout=timeout)
    except subprocess.TimeoutExpired: raise BridgeError('钱包命令超时；写操作只跟踪原单，禁止自动重试',True)
    except OSError: raise BridgeError('钱包入口无法启动，请检查依赖及权限')
    if len(r.stdout)>8_000_000: raise BridgeError('钱包响应过大',True)
    # Never print stderr or raw output: it may contain upstream authentication data.
    try:
        parsed=json.loads(r.stdout.strip())
    except (ValueError,TypeError): raise BridgeError('钱包未返回标准 JSON；请检查入口的 --json 支持',True)
    if not isinstance(parsed,dict): raise BridgeError('钱包响应格式无效',True)
    if r.returncode and parsed.get('success') is True: raise BridgeError('钱包返回状态不一致',True)
    return parsed

def bsc_address(response):
    rows=response.get('data',{}).get('addresses',[]) if response.get('success') is True else []
    selected=[r.get('address','') for r in rows if isinstance(r,dict) and str(r.get('binanceChainId'))=='56']
    import re
    if len(selected)!=1 or not re.fullmatch(r'0x[0-9a-fA-F]{40}',selected[0]):
        raise BridgeError('未获得唯一 BSC 公开地址，不能绑定')
    return selected[0]

def dispatch(entry,args,live=False):
    if not isinstance(args,list) or len(args)<2 or not all(isinstance(x,str) for x in args):
        raise BridgeError('钱包参数无效')
    action=tuple(args[:2])
    if action not in READS|WRITES: raise BridgeError('此入口不允许登录、导出、转账或其他未实现的命令')
    writing=action in WRITES
    if writing and not live: raise BridgeError('模拟模式禁止签名和提交')
    with account_lock(entry):
        if writing:
            current=bsc_address(invoke(entry,['wallet','address']))
            if current.lower()!=entry['address'].lower(): raise BridgeError('钱包地址改变；已停止，不发送交易')
        return invoke(entry,args)

def main():
    cfg=json.loads((ROOT/'local/install.json').read_text())
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
            result=dispatch(entry,req['args'],live)
        except Exception as e:
            result={'success':False,'error':{'code':'LOCAL_BRIDGE_ERROR','message':str(e) if isinstance(e,BridgeError) else '钱包桥接请求无效','commandDispatched':getattr(e,'dispatched',False)}}
        print(json.dumps({'id':req.get('id'),'result':result},ensure_ascii=False),flush=True)

if __name__=='__main__': main()
