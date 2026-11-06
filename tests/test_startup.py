import json,os,plistlib,subprocess,sys,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import startup

class StartupTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(prefix='startup 中文 ');self.root=Path(self.temp.name).resolve()
        self.cfg={'installationId':'synthetic-install','wallets':[{'address':'never-copy-wallet-data'}]}
        self.support=self.root/'support';self.folders={'desktop':self.root/'Desktop','login':self.root/'Login'}
    def tearDown(self):self.temp.cleanup()
    def configure(self,enabled=True,platform='darwin',**kwargs):
        with patch.object(startup.sys,'platform',platform),patch.object(startup,'python_path',return_value=str(self.root/'python runtime'/'python')),patch.object(startup,'capture_environment',return_value={'PATH':'original-only','HOME':str(Path.home())}):
            return startup.configure(self.cfg,enabled,root=self.root,data_dir=self.root/'data',support=self.support,folders=self.folders,register=False,**kwargs)
    def test_mac_login_is_one_shot_headless_and_uses_support_cwd_and_log(self):
        out=self.configure();saved=startup.read(Path(out['config']));login=next(self.folders['login'].glob('*.plist'))
        p=plistlib.loads(login.read_bytes())
        self.assertTrue(p['RunAtLoad']);self.assertTrue(p['AbandonProcessGroup']);self.assertNotIn('KeepAlive',p)
        self.assertEqual(p['WorkingDirectory'],str(self.support));self.assertTrue(p['StandardOutPath'].startswith(str(self.support)))
        self.assertEqual(p['ProgramArguments'][-3:],['run','--config',out['config']])
        self.assertNotIn('never-copy-wallet-data',Path(out['config']).read_text())
        self.assertNotIn('wallets',saved);self.assertNotIn('token',saved)
    def test_windows_login_is_hidden_unicode_and_no_registry_or_policy(self):
        out=self.configure(platform='win32');text=next(self.folders['login'].glob('*.vbs')).read_text(encoding='utf-16')
        self.assertIn('中文',text);self.assertIn(', 0, False',text);self.assertIn(' run --config ',text)
        for forbidden in ['reg.exe','ExecutionPolicy','auth signin','auth signout']:self.assertNotIn(forbidden,text)
        self.assertTrue(Path(out['desktop']).is_file())
    def test_disable_preserves_desktop_and_removes_only_owned_login(self):
        out=self.configure();unrelated=self.folders['login']/'unrelated.plist';unrelated.write_text('keep')
        self.configure(False)
        self.assertTrue(Path(out['desktop']).exists());self.assertEqual(unrelated.read_text(),'keep')
        self.assertEqual(list(self.folders['login'].glob('local.agent*.plist')),[])
        self.assertFalse(startup.read(Path(out['config']))['enabled'])
    def test_does_not_overwrite_a_modified_shortcut_or_another_install(self):
        out=self.configure();Path(out['desktop']).write_text('user edit')
        with self.assertRaisesRegex(RuntimeError,'未覆盖'):self.configure()
        self.cfg['installationId']='different'
        with self.assertRaisesRegex(RuntimeError,'另一安装'):self.configure()
    def test_capture_allowlist_excludes_secrets_and_bundled_runtime(self):
        env={'PATH':'original','HOME':str(Path.home()),'TOKEN':'test-secret','PRIVATE_KEY':'not-a-key','BSC_RPC_URL':'https://rpc.example.invalid/test-only','HTTP_PROXY':'http://127.0.0.1:3128'}
        with patch('runtime_paths.wallet_environment',return_value=env):captured=startup.capture_environment()
        self.assertEqual(captured['PATH'],'original');self.assertNotIn('TOKEN',captured);self.assertNotIn('PRIVATE_KEY',captured);self.assertNotIn('BSC_RPC_URL',captured)
        env['HTTP_PROXY']='https://user:password@example.invalid/'
        with patch('runtime_paths.wallet_environment',return_value=env),self.assertRaisesRegex(RuntimeError,'认证信息'):startup.capture_environment()
    def test_restore_preserves_original_path_and_removes_stale_context(self):
        with patch.dict(os.environ,{'PATH':'changed','DOCKER_CONTEXT':'wrong'},clear=False):
            startup.restore_environment({'dataDir':str(self.root/'data'),'environment':{'PATH':'original','DOCKER_CONTEXT':None}})
            self.assertEqual(os.environ['PATH'],'original');self.assertEqual(os.environ['ATC_WALLET_PATH'],'original');self.assertNotIn('DOCKER_CONTEXT',os.environ)
    def test_foreign_home_and_unknown_environment_are_rejected(self):
        with patch.dict(os.environ,{'HOME':str(self.root/'current')}),self.assertRaisesRegex(RuntimeError,'另一系统用户'):startup.restore_environment({'environment':{'HOME':str(self.root/'other')},'dataDir':str(self.root)})
        with self.assertRaisesRegex(RuntimeError,'字段无效'):startup.restore_environment({'environment':{'PRIVATE_KEY':'anything'},'dataDir':str(self.root)})
    def test_disabled_login_does_not_start_or_discover(self):
        file=self.root/'startup.json';file.write_text(json.dumps({'schema':1,'root':str(startup.ROOT),'enabled':False}))
        with patch.object(startup,'restore_environment') as restore:
            self.assertTrue(startup.run_saved(file)['disabled']);restore.assert_not_called()
    def test_startup_never_discovers_installs_resets_or_resumes(self):
        import inspect
        source=inspect.getsource(startup.run_saved)
        for forbidden in ['setup.main(','discover(','verify_entries(','resume','signin','signout','colima','docker']:
            self.assertNotIn(forbidden,source.replace('# No discover/recheck/install, no login, dependency updates or task resume.',''))
        self.assertIn('setup.verify_release()',source);self.assertIn('setup.start(cfg)',source)
    def test_skip_has_no_filesystem_or_registration_side_effects(self):
        with patch.object(startup,'configure') as configure,patch.object(startup,'read') as read:
            self.assertTrue(startup.after_install(self.cfg,'skip')['skipped']);configure.assert_not_called();read.assert_not_called()
    def test_command_quoting_keeps_metacharacters_inside_path(self):
        result=startup.windows_launcher(['C:\\App path\\pythonw.exe',"C:\\中文 & friend's app\\startup.py",'run','--config','C:\\a b\\startup.json']).decode('utf-16')
        self.assertIn("friend's app",result);self.assertIn('""C:\\App path\\pythonw.exe""',result)

if __name__=='__main__':unittest.main()
