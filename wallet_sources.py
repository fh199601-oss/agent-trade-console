"""Public entrypoint descriptions only. Never parse a wallet/session store."""
import json
import os
from pathlib import Path
import re

MAX_WALLETS = 200
MAP_NAME = 'wallet-entrypoints.json'
SECRET_DIRS = {'.baw', '.ssh', '.aws', 'keystore', 'keystores'}
SUFFIXES = {'.ps1', '.cmd', '.bat', '.exe', '.py', '.js', '.mjs', '.sh', ''}
SCRIPT = re.compile(r'account([1-9][0-9]{0,2})\.(sh|ps1|cmd|bat|py|mjs|js|exe)$', re.I)
ADDRESS = re.compile(r'0x[0-9a-fA-F]{40}$')

def public_path(value, base=None):
    p = Path(value).expanduser()
    if not p.is_absolute():
        if base is None: raise ValueError('钱包路径须为完整路径')
        p = base / p
    for item in [p, p.resolve()]:
        if any(x.casefold() in SECRET_DIRS or x.casefold().startswith('.env') for x in item.parts):
            raise ValueError('请选择钱包的公开启动入口，不读取凭据目录')
    return p.resolve()

def read_public_json(p):
    if p.is_symlink() or not p.is_file() or p.stat().st_size > 256_000:
        raise ValueError('公开接入清单不存在、过大或不是普通文件')
    return json.loads(p.read_text(encoding='utf-8-sig'))

def normalize_entry(row, base):
    if not isinstance(row, dict) or set(row) - {'account', 'address', 'command', 'cwd', 'lockGroup'}:
        raise ValueError('接入清单只允许账号编号、公开地址、启动命令、工作目录和锁分组；不要放凭据')
    n = row.get('account')
    if type(n) is not int or not 1 <= n <= MAX_WALLETS: raise ValueError('账号编号须为 1–200 的整数')
    command = row.get('command')
    if not isinstance(command, list) or not 1 <= len(command) <= 32 or any(not isinstance(x, str) or not x or len(x) > 4096 or '\x00' in x or '\n' in x or '\r' in x for x in command):
        raise ValueError('command 必须是参数数组，不能是拼接的 Shell 命令')
    if command.count('{args}') > 1: raise ValueError('{args} 最多出现一次')
    if any(re.search(r'(?i)^(--?)(private[-_]?key|mnemonic|seed|password|secret|access[-_]?token|api[-_]?key)(=|$)|^0x[0-9a-f]{64}$|^eyJ[\w-]+\.', x) for x in command):
        raise ValueError('启动参数不得包含私钥、登录令牌或密码；应复用原有入口')
    target = public_path(command[0], base)
    interpreter=bool(re.fullmatch(r'python(?:\d+(?:\.\d+)*)?',target.name,re.I))
    if not target.is_file() or target.suffix.lower() not in SUFFIXES and not interpreter:
        raise ValueError('钱包启动入口不存在或类型不支持')
    # Shell code is not a launcher description. Reuse the original script file.
    if (interpreter or target.stem.casefold() in {'sh','bash','zsh','cmd','powershell','pwsh','python','python3','node'}) and any(x.casefold() in {'-c','/c','-command','-encodedcommand','-e','--eval'} for x in command[1:]):
        raise ValueError('请指定原有脚本路径，不接受内联执行代码')
    cwd = public_path(row.get('cwd', str(base)), base)
    if not cwd.is_dir(): raise ValueError('钱包工作目录不存在')
    result = {'account': n, 'kind': 'adapter', 'command': [str(target), *command[1:]], 'cwd': str(cwd)}
    expected = row.get('address')
    if expected is not None:
        if not isinstance(expected, str) or not ADDRESS.fullmatch(expected) or int(expected,16) == 0:
            raise ValueError('address 只能是非零 BSC 公开地址')
        result['address'] = expected
    if 'lockGroup' in row:
        if not isinstance(row['lockGroup'], str) or not re.fullmatch(r'[\w.:-]{1,100}', row['lockGroup']):
            raise ValueError('lockGroup 只能是公开的锁分组名称')
        result['lockGroup'] = row['lockGroup']
    return result

def read_entrypoints(filename):
    p = public_path(filename)
    if p.name != MAP_NAME: raise ValueError('请让安装 AI 生成 wallet-entrypoints.json 公开接入清单，不选择钱包数据库')
    data = read_public_json(p)
    if not isinstance(data, dict) or set(data) != {'schema', 'wallets'} or data['schema'] != 1 or not isinstance(data['wallets'], list) or not 1 <= len(data['wallets']) <= MAX_WALLETS:
        raise ValueError('接入清单须为 schema=1 和 1–200 个 wallets')
    rows = [normalize_entry(row, p.parent) for row in data['wallets']]
    if len({r['account'] for r in rows}) != len(rows): raise ValueError('接入清单的账号编号重复')
    if len({json.dumps([r['command'],r['cwd']]) for r in rows}) != len(rows): raise ValueError('多个编号不能使用完全相同的启动命令和工作目录，请保留账号选择参数')
    return sorted(rows, key=lambda r:r['account'])

def entry_from_argument(value):
    n, sep, filename = value.partition('=')
    if not sep or not n.isdecimal(): raise ValueError('--wallet-entry 格式为 编号=完整启动脚本路径')
    p = public_path(filename)
    return normalize_entry({'account':int(n), 'command':[str(p)], 'cwd':str(p.parent)}, p.parent)

def entries_at(directory):
    p = public_path(directory)
    if p.is_file():
        if p.name == MAP_NAME: return read_entrypoints(p)
        raise ValueError('目录参数请指向入口目录；单个脚本请使用 --wallet-entry 编号=路径')
    if not p.is_dir(): raise ValueError('钱包入口目录不存在')
    if (p/MAP_NAME).is_file(): return read_entrypoints(p/MAP_NAME)
    if (p/'wallet-containers').is_dir(): p = p/'wallet-containers'
    mapping = read_public_json(p/'accounts.json') if (p/'accounts.json').exists() else {}
    if not isinstance(mapping, dict) or any(not re.fullmatch(r'account[1-9][0-9]{0,2}', k) or v is not None and (not isinstance(v,str) or not ADDRESS.fullmatch(v)) for k,v in mapping.items()):
        raise ValueError('accounts.json 不是公开地址映射；请用公开接入清单，不解析其他钱包数据')
    platform_suffix = {'.ps1','.cmd','.bat','.exe','.py','.js','.mjs'} if os.name == 'nt' else {'.sh','.py','.js','.mjs'}
    scripts = {}
    for f in sorted(p.iterdir()):
        match = SCRIPT.fullmatch(f.name)
        if not match or not f.is_file() or f.is_symlink() or f.suffix.lower() not in platform_suffix: continue
        n = int(match[1])
        if n > MAX_WALLETS: raise ValueError('钱包编号超过 200，请使用接入清单映射编号')
        scripts.setdefault(n, []).append(f)
    rows = []
    # An existing public binding map is authoritative; don't probe empty slots.
    wanted = [int(k[7:]) for k,v in mapping.items() if v] if mapping else sorted(scripts)
    for n in sorted(wanted):
        choices = scripts.get(n, [])
        preferred = [f for f in choices if f.suffix.lower() == ('.ps1' if os.name=='nt' else '.sh')]
        choices = preferred or choices
        if len(choices) != 1: raise ValueError('同一账号缺少本系统入口或有多个入口，请使用接入清单明确选择')
        row = {'account':n, 'command':[str(choices[0])], 'cwd':str(p.parent if p.name=='wallet-containers' else p)}
        if mapping.get('account'+str(n)): row['address'] = mapping['account'+str(n)]
        entry = normalize_entry(row,p)
        if p.name=='wallet-containers': entry['kind']='numbered'
        rows.append(entry)
    return rows
