"""Installation-local runtime paths; no wallet stores are opened here."""
import hashlib
import os
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parent

def data_directory(root=ROOT):
    override = os.environ.get('AGENT_TRADE_HOME')
    if override:
        p=Path(override)
        if not p.is_absolute(): raise RuntimeError('AGENT_TRADE_HOME 必须是完整路径')
        return p
    # Existing installations keep their orders, bindings and installation ID.
    if (root/'local/install.json').is_file(): return root/'local'
    if sys.platform=='win32': base=Path(os.environ.get('LOCALAPPDATA',str(Path.home()/'AppData/Local')))
    elif sys.platform=='darwin': base=Path.home()/'Library/Application Support'
    else: base=Path(os.environ.get('XDG_STATE_HOME',str(Path.home()/'.local/state')))
    identity=str(root.resolve())
    if sys.platform=='win32': identity=identity.lower()
    return base/'AgentTradeConsole'/hashlib.sha256(identity.encode()).hexdigest()[:16]

LOCAL=data_directory()

def configure_stdio():
    # Embedded Python ignores PYTHONIOENCODING; JSONL must still be UTF-8.
    # pythonw has no console streams, which is expected for desktop startup.
    for name in ('stdin','stdout','stderr'):
        stream=getattr(sys,name,None)
        if hasattr(stream,'reconfigure'):stream.reconfigure(encoding='utf-8')

def hidden_process_options():
    if sys.platform!='win32': return {}
    import subprocess
    startup=subprocess.STARTUPINFO()
    startup.dwFlags |= subprocess.STARTF_USESHOWWINDOW
    startup.wShowWindow=0
    return {'creationflags':subprocess.CREATE_NO_WINDOW,'startupinfo':startup}

def runtime_environment():
    env=dict(os.environ,NODE_USE_ENV_PROXY='1',PYTHONIOENCODING='utf-8')
    node=ROOT/'portable/node'
    python=ROOT/'portable/python'
    additions=[node,node/'bin',python,python/'bin',Path(sys.executable).parent]
    env['PATH']=os.pathsep.join(str(p) for p in additions if p.is_dir())+os.pathsep+env.get('PATH','')
    return env
