"""Cross-platform integration check. Only synthetic wallets; no real wallet scan."""
import argparse,datetime,json,os,shutil,subprocess,sys,tempfile,time,urllib.request,zipfile
from pathlib import Path

SOURCE=Path(__file__).resolve().parents[1]

def run_smoke(archive=None):
    with tempfile.TemporaryDirectory(prefix='agent smoke 中文 ') as temp:
        temp=Path(temp);root=temp/'App 中文'
        if archive:
            unpack=temp/'unpack'
            with zipfile.ZipFile(archive) as z:
                z.extractall(unpack)
                if os.name!='nt':
                    for info in z.infolist():
                        p=unpack/info.filename
                        if p.is_file():p.chmod((info.external_attr>>16)&0o777 or 0o644)
            shutil.move(str(unpack/'AgentTradeConsole'),root)
        else:
            root.mkdir()
            manifest=json.loads((SOURCE/'MANIFEST.json').read_text())
            for name in [*manifest['files'],'MANIFEST.json']:
                p=root/name;p.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(SOURCE/name,p)
            shutil.copytree(SOURCE/'trade-console/node_modules',root/'trade-console/node_modules')
        # Fresh app-data ancestors do not exist on a recipient's first install.
        env=dict(os.environ,AGENT_TRADE_HOME=str(temp/'用户 data'/'AgentTradeConsole'/'new-install'),PYTHONIOENCODING='utf-8')
        python=str(root/'portable/python'/('python.exe' if os.name=='nt' else 'bin/python3')) if archive else sys.executable
        def cmd(*args):
            r=subprocess.run([python,str(root/'setup.py'),*args],cwd=root,env=env,capture_output=True,text=True,encoding='utf-8',timeout=120)
            try:result=json.loads(r.stdout)
            except Exception:raise AssertionError('Installer did not return JSON: '+r.stderr[-600:])
            assert r.returncode==0 and result.get('success'),result
            return result
        def request(url,payload=None,token=None):
            headers={'content-type':'application/json'}
            if token:headers['x-console-token']=token
            q=urllib.request.Request(url,data=json.dumps(payload).encode() if payload is not None else None,headers=headers)
            with urllib.request.build_opener(urllib.request.ProxyHandler({})).open(q,timeout=30) as r:
                data=r.read();return json.loads(data) if 'application/json' in r.headers.get('content-type','') else data
        try:
            first=cmd('--no-wallet');assert first['mode']=='LIVE' and first['walletCount']==0,first
            boot=request(first['url']+'/api/bootstrap');assert boot['installationId']
            for asset in ['/','/app.js','/style.css','/favicon.svg']:assert request(first['url']+asset)
            assert cmd()['url']==first['url'],'repeated install started another server'
            # Exercise the desktop entry, including pythonw on Windows, without
            # opening a real browser or discovering any recipient wallet.
            desktop_python=str(Path(python).with_name('pythonw.exe')) if os.name=='nt' else python
            desktop=subprocess.run([desktop_python,str(root/'desktop.py'),'--no-browser'],cwd=root,env=env,capture_output=True,timeout=120)
            assert desktop.returncode==0,'desktop entry failed'
            launch=json.loads((Path(env['AGENT_TRADE_HOME'])/'last-launch.json').read_text(encoding='utf-8'))
            assert launch.get('success') and launch['url']==first['url'] and launch['mode']=='LIVE',launch
            cfg=json.loads((Path(env['AGENT_TRADE_HOME'])/'install.json').read_text(encoding='utf-8'))
            assert cfg['installationId']==boot['installationId']
            cmd('stop')
            # Fake entry implements only public status/address/settings; all writes fail.
            wallets=temp/'wallet project 中文'/'wallet-containers';wallets.mkdir(parents=True)
            address='0x0000000000000000000000000000000000001001'
            (wallets/'accounts.json').write_text(json.dumps({'account1':address}))
            fixture=wallets/'fixture.py';calls=temp/'readonly-calls.jsonl'
            fixture.write_text('import sys,json,datetime\nfrom pathlib import Path\nargs=sys.argv[1:]\naction=" ".join(args[:2])\nallowed={"wallet status","wallet address","wallet settings"}\nassert action in allowed, "forbidden wallet command"\np=Path('+repr(str(calls))+')\nwith p.open("a",encoding="utf-8") as f:f.write(json.dumps(args)+"\\n")\nif action=="wallet status":d={"status":"CONNECTED"}\nelif action=="wallet address":d={"addresses":[{"binanceChainId":"56","address":'+repr(address)+'}]}\nelse:d={"sessionExpireTime":(datetime.datetime.now(datetime.timezone.utc)+datetime.timedelta(days=2)).isoformat(),"devMode":{"enabled":False}}\nprint(json.dumps({"success":True,"data":d},ensure_ascii=False))\n',encoding='utf-8')
            if os.name=='nt':
                quote=lambda s:"'"+s.replace("'","''")+"'"
                wrapper="& "+quote(python)+' '+quote(str(fixture))+" @args\nexit $LASTEXITCODE\n"
                (wallets/'account1.ps1').write_text(wrapper,encoding='utf-8-sig')
            else:
                import shlex
                (wallets/'account1.sh').write_text('#!/bin/sh\nexec '+shlex.quote(python)+' '+shlex.quote(str(fixture))+' "$@"\n')
            second=cmd('--wallet-dir',str(wallets));assert second['walletCount']==1 and second['issues']==[],second
            boot=request(second['url']+'/api/bootstrap');assert boot['mode']=='LIVE'
            ready=request(second['url']+'/api/ready',{},boot['token']);assert ready[0]['status']=='CONNECTED',ready
            # Booting/refreshing LIVE must not send any transaction or arm a task.
            assert request(second['url']+'/api/orders',token=boot['token'])==[]
            assert request(second['url']+'/api/opening',token=boot['token'])==[]
            commands=[json.loads(x) for x in calls.read_text(encoding='utf-8').splitlines()]
            assert all(' '.join(c[:2]) in {'wallet status','wallet address','wallet settings'} and '--json' in c for c in commands)
            cmd('stop');assert not cmd('status')['running']
            # An unrelated account-pool layout, arbitrary launcher name and
            # original profile parameter; no publisher-specific account1 path.
            pool=temp/'独立账号池';pool.mkdir();entry=pool/('manage.ps1' if os.name=='nt' else 'manage.py')
            if os.name=='nt':
                entry.write_text("param([string]$Profile, [Parameter(ValueFromRemainingArguments=$true)][string[]]$WalletArgs)\nif ($Profile -ne 'slot-a') { exit 2 }\n& "+quote(python)+' '+quote(str(fixture))+" @WalletArgs\nexit $LASTEXITCODE\n",encoding='utf-8-sig')
                command=[str(entry),'-Profile','slot-a']
            else:
                entry.write_text('import sys,runpy\nassert sys.argv[1:3]==["--profile","slot-a"]\nsys.argv=[sys.argv[0],*sys.argv[3:]]\nrunpy.run_path('+repr(str(fixture))+',run_name="__main__")\n',encoding='utf-8')
                command=[str(entry),'--profile','slot-a']
            mapping=pool/'wallet-entrypoints.json';mapping.write_text(json.dumps({'schema':1,'wallets':[{'account':7,'address':address,'command':command,'cwd':str(pool)}]}),encoding='utf-8')
            before=len(calls.read_text().splitlines());description=cmd('discover','--wallet-map',str(mapping));assert description['walletCommands']==0
            assert len(calls.read_text().splitlines())==before
            third=cmd('--wallet-map',str(mapping));assert third['walletCount']==1 and not third['issues'],third
            boot=request(third['url']+'/api/bootstrap');assert boot['wallets'][0]['account']==7
            ready=request(third['url']+'/api/ready',{},boot['token']);assert ready[0]['status']=='CONNECTED',ready
            assert request(third['url']+'/api/orders',token=boot['token'])==[]
            cmd('stop');reused=cmd();assert reused['walletCheck']['savedBindingsReused'],reused
            cmd('stop');assert not cmd('status')['running']
            print(json.dumps({'success':True,'platform':sys.platform,'portable':bool(archive),'checks':['install','LIVE without writes','paths with spaces and Chinese','repeat install','desktop entry','assets','numbered wrapper','read-only readiness','no automatic jobs','custom pool profile','account above five','entrypoint manifest','reuse saved bindings','stop'],'fakeWalletCommands':len(calls.read_text().splitlines()),'realWalletCommands':0,'submittedTransactions':0}))
        finally:
            try:cmd('stop')
            except Exception:pass

if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--archive',type=Path);a=p.parse_args();run_smoke(a.archive)
