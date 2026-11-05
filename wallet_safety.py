"""Checks public launch descriptions only, before executing any wallet code.

This is a fail-closed check for known environment-mixing patterns, not a sandbox
or proof that an arbitrary third-party launcher is safe. Never read sessions.
"""
import hashlib
import json
import os
from pathlib import Path
import re
import shlex
import shutil
from runtime_paths import wallet_environment

class WalletSafetyError(ValueError):
    code='WALLET_LAUNCHER_UNSAFE'

STORE_OPTION=re.compile(r'(?i)^--?(?:baw[-_])?(?:home|data[-_]?dir|config[-_]?dir|session[-_]?(?:dir|file|path)|credential[-_]?(?:dir|file)|user[-_]?data[-_]?dir)(?:=|$)')
SESSION_ENV=re.compile(r'(?i)^(?:BAW|BINANCE(?:_AGENTIC(?:_WALLET)?)?)_(?:HOME|DATA_DIR|CONFIG_DIR|SESSION(?:_FILE|_DIR|_PATH)?|CREDENTIALS?(?:_FILE|_DIR)?)$')
TEXT_SUFFIXES={'.sh','.ps1','.cmd','.bat','.py','.js','.mjs'}

def validate_description(entry):
    command=entry.get('command',[])
    if not command:raise WalletSafetyError('缺少原有钱包入口')
    for arg in command[1:]:
        if STORE_OPTION.search(arg) or re.match(r'(?i)^(?:BAW_\w+|HOME|USERPROFILE)=',arg):
            raise WalletSafetyError('禁止用主机工具重定向钱包登录目录；请使用原账号池入口及原账号选择参数')
    if Path(command[0]).stem.casefold() in {'docker','podman','npm','npx','pip','uv','env'}:
        raise WalletSafetyError('请绑定原账号池启动脚本及其账号锁，不直接执行容器或临时下载钱包 CLI')
    for key,value in wallet_environment().items():
        if value and SESSION_ENV.fullmatch(key):
            raise WalletSafetyError('当前进程含钱包会话目录重定向变量；请从原环境启动入口，不把共享会话交给其他 CLI')

def launcher_sources(entry):
    # Inspect only explicitly named public script files and known public bridge
    # modules they reference. Never follow arbitrary paths from script contents.
    result={}
    for arg in entry['command']:
        p=Path(arg)
        if p.is_absolute() and p.suffix.lower() in TEXT_SUFFIXES:
            _source(p,result)
    for name,text in list(result.items()):
        p=Path(name)
        for leaf in ['wallet.ps1','wallet_mac.py']:
            q=p.parent/leaf
            if leaf in text and q.is_file():_source(q,result)
    return result

def _source(p,result):
    if p.is_symlink() or not p.is_file() or p.stat().st_size>300_000:
        raise WalletSafetyError('钱包公开入口不是可核验的普通文件，请使用原入口，勿改写或复制登录文件')
    if any(x.casefold() in {'.baw','keystore','keystores'} or x.casefold().startswith('.env') for x in p.parts):
        raise WalletSafetyError('不能把钱包凭据路径当作启动脚本')
    result[str(p)]=p.read_text(encoding='utf-8-sig',errors='strict')

def inspect_launcher(entry):
    validate_description(entry)
    sources=launcher_sources(entry)
    for text in sources.values():
        # A host wrapper redirecting HOME/BAW_HOME into a container's account
        # directory is precisely the unsafe pattern this guard must stop.
        redirection=re.search(r'(?i)BAW_(?:HOME|DATA_DIR|CONFIG_DIR|SESSION(?:_DIR|_FILE)?)|(?:\$env:|export\s+)(?:HOME|USERPROFILE)\s*=|os\.environ\[\s*[\'\"](?:HOME|USERPROFILE)[\'\"]\s*\]\s*=|--(?:data-dir|config-dir|session-dir|session-file|home)\b',text)
        host_cli=re.search(r'(?i)\bbaw(?:\.(?:ps1|cmd|exe|mjs|js))?\b|binance[-_/]agentic[-_/]wallet',text)
        if redirection and host_cli:
            raise WalletSafetyError('检测到钱包 CLI 与登录目录重定向混用；即使 wallet status 也可能改写登录状态，已阻止调用。请使用原容器/原版本入口')
    return {name:hashlib.sha256(text.encode()).hexdigest() for name,text in sources.items()}

def original_runtime(target):
    """Resolve once from the original launcher, not the dashboard's Python/Node."""
    env=wallet_environment();suffix=target.suffix.lower()
    if suffix not in {'.py','.js','.mjs'}:return None
    with target.open(encoding='utf-8-sig') as f:first=f.readline(512).strip()
    if first.startswith('#!'):
        words=shlex.split(first[2:])
        if words and Path(words[0]).name=='env':words=words[1:]
        if len(words)!=1:raise WalletSafetyError('请在公开清单中明确原解释器和脚本路径，不猜测复杂 shebang')
        executable=words[0] if Path(words[0]).is_absolute() else shutil.which(words[0],path=env['PATH'])
    else:
        names=['python','python3'] if os.name=='nt' else ['python3','python']
        executable=next((p for n in (names if suffix=='.py' else ['node']) if (p:=shutil.which(n,path=env['PATH']))),None)
    if not executable or not Path(executable).is_file():
        raise WalletSafetyError('未找到钱包原解释器；请在公开清单明确原环境解释器路径，不使用看板便携运行时替代')
    p=Path(executable).absolute()
    from runtime_paths import ROOT
    if p.resolve().is_relative_to((ROOT/'portable').resolve()):raise WalletSafetyError('不能使用看板便携解释器运行原钱包')
    return str(p)

def bind_environment(entry):
    hashes=inspect_launcher(entry)
    runtime=original_runtime(Path(entry['command'][0]))
    return dict(entry,execution={'schema':1,'platform':os.name,'runtime':runtime,'sourceHashes':hashes,'executables':executable_identity(entry,runtime),'environmentFingerprint':environment_fingerprint()})

def environment_fingerprint():
    # Store a digest, not HOME, Docker endpoints or any environment values.
    # A restart from another shell/context must not silently select a session.
    env=wallet_environment()
    names=['PATH','HOME','USERPROFILE','DOCKER_HOST','DOCKER_CONTEXT','BAW_DOCKER_CONTEXT','WSL_DISTRO_NAME']
    return hashlib.sha256(json.dumps([env.get(n) for n in names],ensure_ascii=True).encode()).hexdigest()

def executable_identity(entry,runtime):
    paths=[Path(entry['command'][0]),*([Path(runtime)] if runtime else [])]
    return {str(p):{'resolved':str(p.resolve()),'size':p.stat().st_size,'mtimeNs':p.stat().st_mtime_ns} for p in paths}

def verify_environment_binding(entry):
    hashes=inspect_launcher(entry);bound=entry.get('execution')
    if bound is None:
        raise WalletSafetyError('旧钱包绑定尚未核验原运行环境；请停止本安装后用 --recheck-wallets 更新绑定，不重新登录')
    if bound.get('schema')!=1 or bound.get('platform')!=os.name or bound.get('sourceHashes')!=hashes:
        raise WalletSafetyError('钱包入口或平台发生变化，已停止调用；先核对原环境，再 --recheck-wallets，不切换 CLI 或重置登录')
    if bound.get('environmentFingerprint')!=environment_fingerprint():
        raise WalletSafetyError('钱包启动环境或 Docker 选择发生变化，已停止调用；请回到原环境核验，不尝试其他会话')
    runtime=bound.get('runtime')
    if runtime!=original_runtime(Path(entry['command'][0])):
        raise WalletSafetyError('钱包原解释器已变化，已停止调用；核对环境后重查绑定，不使用其他版本尝试登录')
    if bound.get('executables')!=executable_identity(entry,runtime):
        raise WalletSafetyError('钱包入口或解释器文件已更新；先核对原运行环境后重查绑定，未调用钱包')
