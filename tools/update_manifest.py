#!/usr/bin/env python3
"""Refresh explicitly listed source files; never sweep a workspace into a release."""
import argparse,hashlib,json,re
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]
FORBIDDEN={'.git','.baw','.env','local','runtime','node_modules','wallet-containers','accounts.json','wallet-entrypoints.json','install.json','service.json','startup.json','startup-error.json','startup-error.html','startup.html','last-launch.json','rpc-settings.json','.migration','evidence','reports','__pycache__'}

def check_path(name):
    p=Path(name)
    parts={part.casefold() for part in p.parts}
    if p.is_absolute() or not p.parts or '..' in p.parts or '\\' in name or ':' in name or parts&FORBIDDEN or any(part.startswith('.env') for part in parts):
        raise ValueError('拒绝私有或不安全路径：'+name)
    target=ROOT/p
    if any((ROOT/Path(*p.parts[:i])).is_symlink() for i in range(1,len(p.parts)+1)) or not target.is_file() or not target.resolve().is_relative_to(ROOT):raise ValueError('只允许仓库内普通文件：'+name)
    if name not in {'.gitignore','.gitattributes','LICENSE'} and p.suffix not in {'.py','.mjs','.js','.c','.css','.svg','.html','.json','.md','.txt','.yml','.vbs','.command'}:raise ValueError('不支持的发行文件类型：'+name)
    return target

def main():
    parser=argparse.ArgumentParser(description='更新已列出的文件；新增源码须显式 --add，不读取运行数据')
    parser.add_argument('--add',action='append',default=[]);parser.add_argument('--remove',action='append',default=[])
    args=parser.parse_args()
    manifest=ROOT/'MANIFEST.json';current=json.loads(manifest.read_text())
    names=(set(current['files'])|set(args.add))-set(args.remove)-{'MANIFEST.json'}
    result={}
    for name in sorted(names):
        data=check_path(name).read_bytes();text=data.decode('utf-8')
        if '\x00' in text or re.search(r'-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----|eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}',text):raise ValueError('疑似秘密信息，停止：'+name)
        result[name]=hashlib.sha256(data).hexdigest()
    manifest.write_text(json.dumps({'format':1,'files':result},indent=2)+'\n')
    print(json.dumps({'updatedFiles':len(result),'note':'仅校验完整性；提交前仍须检查敏感信息'},ensure_ascii=False))

if __name__=='__main__':main()
