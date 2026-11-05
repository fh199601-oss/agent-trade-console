"""Synthetic entrypoints only; tests never discover the developer's wallets."""
import json,os,sys,tempfile,time,unittest
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import setup, wallet_bridge as bridge, wallet_sources as sources

class WalletSources(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(prefix='wallet 账号池 ');self.root=Path(self.temp.name).resolve()
        self.home=patch.object(Path,'home',return_value=self.root);self.home.start()
        self.script=self.root/'原有入口.py'
        self.script.write_text('import json,sys,time\na=sys.argv[1:]\nn=int(a[0]);a=a[1:]\nassert "--json" in a\nassert a[:2] in [["wallet","status"],["wallet","address"]]\nif n==99:time.sleep(20)\nd={"status":"CONNECTED"} if a[1]=="status" else {"addresses":[{"binanceChainId":"56","address":"0x"+format(n,"040x")}]}\nprint(json.dumps({"success":True,"data":d}))\n',encoding='utf-8')
    def tearDown(self):self.home.stop();self.temp.cleanup()
    def row(self,n=1):return {'account':n,'command':[str(self.script),str(n)],'cwd':str(self.root)}
    def manifest(self,rows=None):
        p=self.root/sources.MAP_NAME;p.write_text(json.dumps({'schema':1,'wallets':rows or [self.row()]}),encoding='utf-8');return p
    def test_custom_pool_and_many_accounts_do_not_require_publisher_layout(self):
        rows=sources.read_entrypoints(self.manifest([self.row(n) for n in range(1,25)]))
        start=time.monotonic();verified,issues=setup.verify_entries(rows,timeout=8,workers=4)
        self.assertEqual(issues,[]);self.assertEqual([r['account'] for r in verified],list(range(1,25)))
        self.assertLess(time.monotonic()-start,8)
        self.assertEqual(verified[-1]['address'],'0x'+format(24,'040x'))
    def test_explicit_map_never_searches_disk_or_falls_back(self):
        with patch.object(setup,'find_wallet_dirs') as scan,patch.object(setup,'verify_entries',return_value=([],[])) as verify:
            setup.discover(wallet_map=self.manifest())
        scan.assert_not_called();self.assertEqual(verify.call_args.args[0][0]['command'],[str(self.script),'1'])
    def test_any_directory_numbered_scripts_and_empty_mapping(self):
        p=self.root/'my-pool';p.mkdir();(p/'account17.py').write_text('')
        self.assertEqual(sources.entries_at(p)[0]['account'],17)
        (p/'accounts.json').write_text(json.dumps({'account17':None}))
        self.assertEqual(sources.entries_at(p),[])
    def test_specific_public_pool_under_appdata_or_library_is_searchable(self):
        for name in ['AppData','Library']:
            parent=self.root/name;pool=parent/'PublicPool';pool.mkdir(parents=True)
            (pool/'account7.py').write_text('')
            self.assertEqual(setup.find_wallet_dirs([pool]),[pool])
            self.assertEqual(setup.find_wallet_dirs([parent]),[])
        private=self.root/'.baw'/'nested';private.mkdir(parents=True)
        (private/'account7.py').write_text('')
        with patch.object(setup.os,'walk',side_effect=AssertionError('credential directory scanned')):
            self.assertEqual(setup.find_wallet_dirs([private]),[])
    def test_public_map_optional_address_and_argument_insertion(self):
        row=self.row();row['command']=[str(self.script),'1','{args}','--readonly-output']
        entry=sources.read_entrypoints(self.manifest([row]))[0]
        command=bridge.launch_args(entry,['wallet','status','--json'])
        self.assertEqual(command,[sys.executable,str(self.script),'1','wallet','status','--json','--readonly-output'])
    def test_entry_argument_keeps_spaces_and_non_ascii_as_path(self):
        e=sources.entry_from_argument('8='+str(self.script));self.assertEqual(e['account'],8);self.assertEqual(e['command'],[str(self.script)])
    def test_private_stores_and_unknown_schema_rejected_before_read(self):
        p=self.root/'.baw';p.mkdir();private=p/'wallet-entrypoints.json';private.write_text('do not read')
        with patch.object(Path,'read_text',side_effect=AssertionError('secret read')):
            with self.assertRaisesRegex(ValueError,'凭据'):sources.read_entrypoints(private)
        for bad in [dict(self.row(),privateKey='not-a-key'),dict(self.row(),env={'TOKEN':'not-a-token'}),dict(self.row(),command='sh command'),dict(self.row(),account=201),dict(self.row(),address='0x'+'0'*40),dict(self.row(),command=[str(self.script),'--password','dummy'])]:
            with self.assertRaises(ValueError):sources.read_entrypoints(self.manifest([bad]))
    def test_duplicate_numbers_commands_and_inline_code_rejected(self):
        for rows in [[self.row(),self.row()],[self.row(),dict(self.row(),account=2)],[dict(self.row(),command=[sys.executable,'-c','print(1)'])]]:
            with self.assertRaises(ValueError):sources.read_entrypoints(self.manifest(rows))
    def test_deadline_is_shared_not_repeated_per_wallet(self):
        rows=[sources.normalize_entry(self.row(n),self.root) for n in [99,1,2,3]]
        start=time.monotonic();verified,issues=setup.verify_entries(rows,timeout=1,workers=2)
        self.assertLess(time.monotonic()-start,3)
        self.assertEqual([r['account'] for r in verified],[1,2,3]);self.assertEqual(issues[0]['account'],99)
        self.assertEqual(issues[0]['code'],'WALLET_ENTRY_TIMEOUT')
    def test_lock_groups_preserve_shared_session_serialization(self):
        first=dict(self.row(),lockGroup='shared-pool');other=dict(self.row(2),lockGroup='shared-pool')
        with bridge.account_lock(first):
            with self.assertRaises(bridge.BridgeError):
                with bridge.account_lock(other,timeout=.05):self.fail('lock bypassed')
    def test_read_only_timeout_reaches_bridge_but_cannot_weaken_write(self):
        e=self.row();e['address']='0x'+format(1,'040x')
        address={'success':True,'data':{'addresses':[{'binanceChainId':'56','address':e['address']}]}}
        with patch.object(bridge,'invoke',return_value=address) as invoke:
            bridge.dispatch(e,['wallet','status'],read_only_timeout_ms=500,background=True)
            self.assertEqual(invoke.call_args.kwargs['timeout'],.5)
            bridge.dispatch(e,['contract-call','execute'],True,read_only_timeout_ms=500,background=True)
            self.assertEqual(invoke.call_args.kwargs['timeout'],100)
    def test_existing_install_reuses_saved_entries_without_query(self):
        e=dict(self.row(),address='0x'+format(1,'040x'));cfg={'installationId':'fake','wallets':[e],'issues':[]}
        with patch.object(sys,'argv',['setup.py']),patch.object(setup,'LOCAL',self.root),patch.object(setup,'verify_release',return_value=1),patch.object(setup,'read',return_value=cfg),patch.object(setup,'current',return_value=None),patch.object(setup,'node_and_npm',return_value=('node','npm')),patch.object(setup,'dependencies'),patch.object(setup,'save'),patch.object(setup,'verify_entries') as verify,patch.object(setup,'start',return_value=('http://127.0.0.1:1',{'mode':'LIVE','wallets':[e]})):
            result=setup.main()
        self.assertTrue(result['success'],result);self.assertTrue(result['walletCheck']['savedBindingsReused']);verify.assert_not_called()
    def test_explicit_discover_checks_descriptions_without_running_wallet(self):
        with patch.object(sys,'argv',['setup.py','discover','--wallet-map',str(self.manifest())]),patch.object(setup,'verify_release',return_value=1),patch.object(setup,'invoke') as invoke:
            result=setup.main()
        self.assertTrue(result['success'],result);self.assertEqual(result['walletCommands'],0);invoke.assert_not_called()
    def test_incomplete_search_never_guesses_only_result_or_default_wallet(self):
        with patch.object(setup,'find_wallet_dirs',return_value=setup.ScanResults([self.root],truncated=True)),patch.object(setup,'invoke') as invoke,patch.object(setup.shutil,'which') as which:
            wallets,issues=setup.discover()
        self.assertEqual(wallets,[]);self.assertEqual(issues[0]['code'],'WALLET_SEARCH_LIMIT');invoke.assert_not_called();which.assert_not_called()
    def test_powershell_named_profile_is_not_quoted_as_positional_value(self):
        p=self.root/'manage.ps1';p.write_text('')
        with patch.object(bridge.shutil,'which',return_value='powershell'):
            args=bridge.launch_args({'command':[str(p),'-Profile',"name's profile"]},['wallet','status','--json'])
        import base64
        script=base64.b64decode(args[-1]).decode('utf-16le');self.assertIn(" -Profile 'name''s profile' ",script)

if __name__=='__main__':unittest.main()
