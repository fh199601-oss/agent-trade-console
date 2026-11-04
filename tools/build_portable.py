"""Build a clean, self-contained platform ZIP from an explicit source manifest."""
import argparse,hashlib,json,os,shutil,stat,subprocess,tarfile,tempfile,urllib.request,zipfile
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]

def digest(path):
    h=hashlib.sha256()
    with path.open('rb') as f:
        for chunk in iter(lambda:f.read(1024*1024),b''):h.update(chunk)
    return h.hexdigest()

def extract(archive,destination):
    destination.mkdir(parents=True,exist_ok=True)
    if archive.name.endswith('.zip'):
        with zipfile.ZipFile(archive) as z:
            for item in z.infolist():
                target=destination/item.filename
                if not target.resolve().is_relative_to(destination.resolve()):raise ValueError('Unsafe ZIP path')
            z.extractall(destination)
    else:
        with tarfile.open(archive) as t:t.extractall(destination,filter='data')

def build(platform,output):
    manifest=json.loads((ROOT/'MANIFEST.json').read_text())
    for name,want in manifest['files'].items():
        p=ROOT/name
        if p.is_symlink() or not p.is_file() or digest(p)!=want:raise ValueError('Source verification failed: '+name)
    locks=json.loads((ROOT/'tools/runtime-lock.json').read_text());lock=locks['platforms'][platform]
    version=json.loads((ROOT/'trade-console/package.json').read_text())['version']
    output=output.resolve();output.mkdir(parents=True,exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='agent-portable-build-') as tmp:
        tmp=Path(tmp);app=tmp/'AgentTradeConsole';app.mkdir()
        for name in [*manifest['files'],'MANIFEST.json']:
            dst=app/name;dst.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(ROOT/name,dst)
        for name,spec in lock.items():
            archive=tmp/(name+('.zip' if spec['url'].endswith('.zip') else '.tar.gz'))
            with urllib.request.urlopen(spec['url'],timeout=90) as r,archive.open('wb') as f:shutil.copyfileobj(r,f)
            if digest(archive)!=spec['sha256']:raise ValueError('Runtime checksum mismatch: '+name)
            unpack=tmp/('unpack-'+name);extract(archive,unpack)
            dirs=[unpack] if spec.get('embedded') else [p for p in unpack.iterdir() if p.is_dir()]
            if len(dirs)!=1:raise ValueError('Unexpected runtime layout')
            # Dereference only links inside this already verified runtime.
            for p in dirs[0].rglob('*'):
                if p.is_symlink() and not p.resolve().is_relative_to(dirs[0].resolve()):raise ValueError('Runtime link escapes archive')
            shutil.copytree(dirs[0],app/'portable'/name,symlinks=False)
            if spec.get('embedded'):
                # Official embedded Python disables script-directory imports.
                # Add only this application's root, not user site-packages.
                pth=next((app/'portable/python').glob('python*._pth'))
                pth.write_text(pth.read_text()+'\n../..\n',encoding='utf-8')
                if not (app/'portable/python/vcruntime140.dll').is_file():raise ValueError('Embedded Python is missing its VC runtime')
        node=app/'portable/node'/('node.exe' if platform.startswith('windows') else 'bin/node')
        npm=app/'portable/node'/('node_modules/npm/bin/npm-cli.js' if platform.startswith('windows') else 'lib/node_modules/npm/bin/npm-cli.js')
        # Build on the matching runner. Never copy the author's installed modules.
        env=dict(os.environ,NODE_USE_ENV_PROXY='1',npm_config_userconfig=str(tmp/'empty-npmrc'))
        (tmp/'empty-npmrc').write_text('')
        subprocess.run([str(node),str(npm),'ci','--ignore-scripts','--no-audit','--no-fund','--registry=https://registry.npmjs.org/'],cwd=app/'trade-console',env=env,check=True,timeout=240)
        # No executable symlinks are needed; calls use explicit JS entrypoints.
        shutil.rmtree(app/'trade-console/node_modules/.bin',ignore_errors=True)
        for p in list(app.rglob('__pycache__')):shutil.rmtree(p)
        for p in list(app.rglob('*.pyc')):p.unlink()
        provenance={'version':version,'platform':platform,'runtimes':lock,'nodeVersion':locks['nodeVersion'],'pythonVersion':lock['python'].get('version',locks['pythonVersion']),'sourceManifestSha256':digest(ROOT/'MANIFEST.json')}
        (app/'PORTABLE.json').write_text(json.dumps(provenance,indent=2)+'\n')
        files={}
        for p in sorted(app.rglob('*')):
            if p.is_file() and p.name!='MANIFEST.json':
                rel=p.relative_to(app).as_posix()
                if set(p.relative_to(app).parts)&{'.baw','.env','local','wallet-containers','.git'}:raise ValueError('Private path in package')
                files[rel]=digest(p)
        (app/'MANIFEST.json').write_text(json.dumps({'format':1,'files':files},indent=2)+'\n')
        zip_path=output/f'agent-trade-console-v{version}-{platform}.zip'
        with zipfile.ZipFile(zip_path,'w',zipfile.ZIP_DEFLATED,compresslevel=6) as z:
            for p in sorted(app.rglob('*')):
                if p.is_file():
                    info=zipfile.ZipInfo.from_file(p,arcname='AgentTradeConsole/'+p.relative_to(app).as_posix())
                    # Preserve executable flags for Archive Utility on macOS.
                    info.compress_type=zipfile.ZIP_DEFLATED
                    z.writestr(info,p.read_bytes())
        sha=digest(zip_path);zip_path.with_suffix('.zip.sha256').write_text(sha+'  '+zip_path.name+'\n')
        print(json.dumps({'file':str(zip_path),'sha256':sha,'files':len(files)+1}))
    return zip_path

if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--platform',required=True,choices=['windows-x64','windows-arm64','macos-arm64','macos-x64']);p.add_argument('--output',type=Path,default=ROOT/'dist');a=p.parse_args();build(a.platform,a.output)
