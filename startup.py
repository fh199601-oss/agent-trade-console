"""Recipient-local login startup and shortcuts. Never package generated files."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import plistlib
import shlex
import subprocess
import sys
import webbrowser
from urllib.parse import urlsplit

ROOT=Path(__file__).resolve().parent
sys.path.insert(0,str(ROOT))
ENV_NAMES=('PATH','HOME','USERPROFILE','DOCKER_HOST','DOCKER_CONTEXT','BAW_DOCKER_CONTEXT','WSL_DISTRO_NAME')
PROXY_NAMES=('HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','NO_PROXY','http_proxy','https_proxy','all_proxy','no_proxy')

def identity(root=ROOT):
    value=str(root.resolve())
    if sys.platform=='win32':value=value.lower()
    return hashlib.sha256(value.encode()).hexdigest()[:16]

def support_directory(root=ROOT):
    if sys.platform=='win32':base=Path(os.environ.get('LOCALAPPDATA',str(Path.home()/'AppData/Local')))
    elif sys.platform=='darwin':base=Path.home()/'Library/Application Support'
    else:base=Path(os.environ.get('XDG_STATE_HOME',str(Path.home()/'.local/state')))
    return base/'AgentTradeConsole'/'startup'/identity(root)

def read(path):
    return json.loads(path.read_text(encoding='utf-8')) if path.is_file() else None

def write_private(path,data):
    path.parent.mkdir(parents=True,exist_ok=True,mode=0o700)
    if path.is_symlink():raise RuntimeError('启动配置不能是符号链接')
    temp=path.with_name(path.name+'.tmp')
    with temp.open('wb') as f:
        os.chmod(temp,0o600);f.write(data);f.flush();os.fsync(f.fileno())
    os.replace(temp,path)

def capture_environment():
    from runtime_paths import wallet_environment
    source=wallet_environment();result={name:source.get(name) for name in ENV_NAMES}
    for name in ('DOCKER_HOST',*PROXY_NAMES):
        value=source.get(name)
        if value and name.lower()!='no_proxy':
            p=urlsplit(value)
            if p.username or p.password or p.query or p.fragment:
                raise RuntimeError('启动环境含带认证信息的网络地址，未保存；请使用不含凭据的原环境配置')
        if name in PROXY_NAMES:result[name]=value
    return result

def restore_environment(saved):
    values=saved.get('environment',{})
    if set(values)-set(ENV_NAMES+PROXY_NAMES):raise RuntimeError('启动环境字段无效')
    # Preserve the original identity, never redirect a different OS user.
    for name in ('HOME','USERPROFILE'):
        if values.get(name) and os.environ.get(name) and Path(values[name]).resolve()!=Path(os.environ[name]).resolve():
            raise RuntimeError('启动配置属于另一系统用户，未调用钱包')
    for name,value in values.items():
        if value is None:os.environ.pop(name,None)
        elif isinstance(value,str):os.environ[name]=value
        else:raise RuntimeError('启动环境值无效')
    os.environ['ATC_WALLET_PATH']=values.get('PATH') or ''
    os.environ['AGENT_TRADE_HOME']=saved['dataDir']

def known_folder(guid):
    """Windows Known Folders respect redirected/OneDrive Desktop and Startup."""
    import ctypes,uuid
    from ctypes import wintypes
    class GUID(ctypes.Structure):
        _fields_=[('Data1',wintypes.DWORD),('Data2',wintypes.WORD),('Data3',wintypes.WORD),('Data4',ctypes.c_ubyte*8)]
    value=GUID.from_buffer_copy(uuid.UUID(guid).bytes_le);out=ctypes.c_wchar_p()
    shell=ctypes.WinDLL('shell32',use_last_error=True);ole=ctypes.WinDLL('ole32')
    shell.SHGetKnownFolderPath.argtypes=[ctypes.POINTER(GUID),wintypes.DWORD,wintypes.HANDLE,ctypes.POINTER(ctypes.c_wchar_p)]
    shell.SHGetKnownFolderPath.restype=ctypes.c_long
    ole.CoTaskMemFree.argtypes=[ctypes.c_void_p]
    if shell.SHGetKnownFolderPath(ctypes.byref(value),0,None,ctypes.byref(out))!=0:raise RuntimeError('无法读取 Windows 启动目录')
    try:return Path(out.value)
    finally:ole.CoTaskMemFree(out)

def platform_folders():
    if sys.platform=='win32':return {'desktop':known_folder('B4BFCC3A-DB2C-424C-B029-7FE99A87C641'),'login':known_folder('B97D20BB-F46A-4C97-BA10-5E3608430854')}
    if sys.platform=='darwin':return {'desktop':Path.home()/'Desktop','login':Path.home()/'Library/LaunchAgents'}
    raise RuntimeError('登录自启仅支持 Mac 和 Windows；仍可直接运行 setup.py start')

def python_path():
    exe=Path(sys.executable)
    if sys.platform=='win32':
        hidden=exe.with_name('pythonw.exe')
        if not hidden.is_file():raise RuntimeError('缺少静默 Python 入口，请使用完整便携包')
        return str(hidden)
    return str(exe)

def windows_launcher(command):
    value=subprocess.list2cmdline(command).replace('"','""')
    # UTF-16 BOM is understood by Windows Script Host for non-ASCII paths.
    return ('Option Explicit\r\nDim shell\r\nSet shell = CreateObject("WScript.Shell")\r\nshell.Run "'+value+'", 0, False\r\n').encode('utf-16')

def configure(cfg,enabled,*,root=ROOT,data_dir=None,support=None,folders=None,register=True):
    from runtime_paths import LOCAL
    support=support or support_directory(root);settings=support/'startup.json'
    old=read(settings);folders=folders or platform_folders();label='local.agent-trade-console.'+identity(root)
    if old and old.get('installationId')!=cfg['installationId']:raise RuntimeError('自启配置属于另一安装，未覆盖')
    env=capture_environment() if enabled or not old else old['environment']
    py=python_path();command=[py,str(root/'startup.py')]
    desktop=folders['desktop']/('AGENT-'+identity(root)[:6]+('.vbs' if sys.platform=='win32' else '.command'))
    login=folders['login']/(label+('.vbs' if sys.platform=='win32' else '.plist'))
    open_command=[*command,'open','--config',str(settings)]
    login_command=[*command,'run','--config',str(settings)]
    if sys.platform=='win32':desktop_data=windows_launcher(open_command);login_data=windows_launcher(login_command)
    else:
        desktop_data=('#!/bin/sh\nexec '+shlex.join(open_command)+'\n').encode()
        login_data=plistlib.dumps({'Label':label,'ProgramArguments':login_command,'WorkingDirectory':str(support),'RunAtLoad':True,'AbandonProcessGroup':True,'StandardOutPath':str(support/'startup.log'),'StandardErrorPath':str(support/'startup.log'),'Umask':63,'LimitLoadToSessionType':'Aqua'})
    hashes=old.get('artifacts',{}) if old else {}
    def owned(path):
        if path.exists() and (path.is_symlink() or hashlib.sha256(path.read_bytes()).hexdigest()!=hashes.get(str(path))):
            raise RuntimeError('同名启动文件已被修改，未覆盖或删除：'+path.name)
    owned(desktop);owned(login)
    saved={'schema':1,'installationId':cfg['installationId'],'root':str(root.resolve()),'dataDir':str((data_dir or LOCAL).resolve()),'enabled':bool(enabled),'environment':env,'label':label,'artifacts':{}}
    support.mkdir(parents=True,exist_ok=True,mode=0o700)
    if sys.platform=='darwin' and register and login.exists():
        subprocess.run(['/bin/launchctl','bootout',f'gui/{os.getuid()}/{label}'],capture_output=True,timeout=15)
    write_private(desktop,desktop_data)
    if sys.platform!='win32':desktop.chmod(0o700)
    saved['artifacts'][str(desktop)]=hashlib.sha256(desktop_data).hexdigest()
    if enabled:
        write_private(login,login_data);saved['artifacts'][str(login)]=hashlib.sha256(login_data).hexdigest()
    elif login.exists():login.unlink()
    write_private(settings,json.dumps(saved,ensure_ascii=False,indent=2).encode())
    activation=None
    if enabled and sys.platform=='darwin' and register:
        r=subprocess.run(['/bin/launchctl','bootstrap',f'gui/{os.getuid()}',str(login)],capture_output=True,timeout=15)
        if r.returncode:activation='登录项已保存，当前系统会话未加载；可先用桌面入口，下次图形登录时启动。'
    return {'enabled':bool(enabled),'desktop':str(desktop),'config':str(settings),**({'notice':activation} if activation else {})}

def status():
    saved=read(support_directory()/'startup.json')
    return {'enabled':bool(saved and saved.get('enabled')),'configured':bool(saved)}

def after_install(cfg,choice=None):
    if choice=='skip':return {'enabled':False,'skipped':True}
    saved=read(support_directory()/'startup.json')
    if choice=='status':return status()
    if choice is None and saved:return status()
    # A failed OS integration does not prevent access to the working dashboard.
    try:return configure(cfg,choice!='off')
    except (OSError,RuntimeError,subprocess.SubprocessError) as e:return {'enabled':False,'error':str(e)}

def run_saved(config,open_browser=False,manual=False):
    saved=read(config)
    if not saved or saved.get('schema')!=1 or Path(saved.get('root','')).resolve()!=ROOT:raise RuntimeError('原安装目录已移动，请在新目录重新运行安装器')
    if not manual and not open_browser and not saved.get('enabled'):return {'success':True,'disabled':True}
    restore_environment(saved)
    import setup
    from wallet_bridge import account_lock
    with account_lock({'command':[str(ROOT/'setup.py')]},timeout=120):
        cfg=setup.read(setup.CONFIG)
        if not cfg or cfg.get('installationId')!=saved['installationId']:raise RuntimeError('原安装绑定不匹配，未重新查找钱包')
        setup.verify_release()
        # No discover/recheck/install, no login, dependency updates or task resume.
        url,state=setup.start(cfg)
        result={'success':True,'url':url,'mode':state['mode'],'walletCount':len(state['wallets']),'submittedTransactions':0}
        setup.save(setup.LOCAL/'last-launch.json',result)
    if open_browser:webbrowser.open(url)
    return result

def main():
    if hasattr(sys.stdout,'reconfigure'):sys.stdout.reconfigure(encoding='utf-8')
    p=argparse.ArgumentParser();p.add_argument('action',choices=['run','open']);p.add_argument('--config',type=Path,required=True);p.add_argument('--no-browser',action='store_true');args=p.parse_args()
    try:
        result=run_saved(args.config,open_browser=args.action=='open' and not args.no_browser,manual=args.action=='open')
    except Exception:
        # Never dump provider errors, environment or saved wallet metadata.
        result={'success':False,'error':'启动未完成，请从原安装目录运行 Start 入口检查；未重新绑定钱包或执行交易。'}
    if sys.stdout:print(json.dumps(result,ensure_ascii=False))
    if not result['success']:
        try:
            write_private(args.config.parent/'startup-error.json',json.dumps(result,ensure_ascii=False).encode())
            if args.action=='open' and not args.no_browser:
                page=args.config.parent/'startup-error.html'
                write_private(page,('<!doctype html><meta charset="utf-8"><title>AGENT 启动</title><h1>AGENT 交易台</h1><p>'+result['error']+'</p>').encode())
                webbrowser.open(page.as_uri())
        except OSError:pass
    return 0 if result['success'] else 1

if __name__=='__main__':sys.exit(main())
