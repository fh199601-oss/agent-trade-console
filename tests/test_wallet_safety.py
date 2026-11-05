"""No real accounts. Synthetic login marker proves unsafe launch never occurs."""
import json,os,sys,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import wallet_safety as safety, wallet_bridge as bridge, wallet_sources as sources, runtime_paths as runtime, setup

class WalletIsolation(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory(prefix='isolated wallet ');self.root=Path(self.tmp.name).resolve()
        self.entry=self.root/'account1.py';self.entry.write_text('print("original entry")')
        self.row={'account':1,'command':[sys.executable,str(self.entry)],'cwd':str(self.root)}
    def tearDown(self):self.tmp.cleanup()
    def test_host_cli_with_shared_container_directory_blocked_before_login_marker_touched(self):
        marker=self.root/'synthetic-login-marker';marker.write_bytes(b'X'*223)
        self.entry.write_text('import os\n# baw host CLI version differs from container\nos.environ["BAW_HOME"]="accounts/a1"\nfrom pathlib import Path\nPath('+repr(str(marker))+').write_bytes(b"X"*112)\n')
        with patch.object(bridge,'run_command') as run:
            with self.assertRaisesRegex(bridge.BridgeError,'登录目录重定向'):bridge.invoke(self.row,['wallet','status'])
        run.assert_not_called();self.assertEqual(marker.read_bytes(),b'X'*223)
    def test_manifest_cannot_redirect_store_or_bypass_container_lock(self):
        for args in [['--data-dir','accounts/a1'],['--home=accounts/a1'],['--session-file','file'],['BAW_HOME=accounts/a1']]:
            with self.assertRaises(safety.WalletSafetyError):safety.bind_environment(dict(self.row,command=[*self.row['command'],*args]))
        with patch.dict(os.environ,{'BAW_HOME':'synthetic path'}):
            with self.assertRaises(safety.WalletSafetyError):safety.bind_environment(self.row)
        with self.assertRaises(safety.WalletSafetyError):safety.validate_description(dict(self.row,command=['/dummy/docker','exec','wallet','baw']))
    def test_default_cli_is_never_a_discovery_fallback(self):
        with patch.object(setup,'find_wallet_dirs',return_value=[]),patch.object(setup,'verify_entries') as verify,patch.object(setup.shutil,'which') as which:
            wallets,issues=setup.discover()
        self.assertEqual(wallets,[]);self.assertEqual(issues[0]['code'],'NO_WALLET_ENTRY');verify.assert_not_called();which.assert_not_called()
    def test_changed_public_launcher_stops_even_status_before_execution(self):
        row=safety.bind_environment(self.row);self.entry.write_text('print("a changed launcher")')
        with patch.object(bridge,'run_command') as run:
            with self.assertRaisesRegex(bridge.BridgeError,'入口或平台发生变化'):bridge.invoke(row,['wallet','status'])
        run.assert_not_called()
    def test_unverified_legacy_binding_cannot_dispatch(self):
        with patch.object(bridge,'run_command') as run:
            with self.assertRaisesRegex(bridge.BridgeError,'旧钱包绑定'):bridge.invoke(self.row,['wallet','status'])
        run.assert_not_called()
    def test_original_path_and_docker_context_survive_portable_server_environment(self):
        original_path=str(self.root/'original-runtime');custom={'PATH':original_path,'BAW_DOCKER_CONTEXT':'original-context','DOCKER_HOST':'original-host'}
        with patch.dict(os.environ,custom,clear=True):
            env=runtime.runtime_environment()
            with patch.dict(os.environ,env,clear=True):
                restored=runtime.wallet_environment()
        self.assertEqual(restored['PATH'],original_path);self.assertEqual(restored['BAW_DOCKER_CONTEXT'],'original-context');self.assertEqual(restored['DOCKER_HOST'],'original-host')
    def test_missing_original_runtime_never_uses_bundled_python(self):
        with patch.object(safety.shutil,'which',return_value=None):
            with self.assertRaisesRegex(safety.WalletSafetyError,'原解释器'):safety.original_runtime(self.entry)
    def test_docker_context_change_stops_before_any_wallet_call(self):
        row=safety.bind_environment(self.row)
        with patch.dict(os.environ,{'DOCKER_CONTEXT':'another-wallet-environment'}),patch.object(bridge,'run_command') as run:
            with self.assertRaisesRegex(bridge.BridgeError,'启动环境或 Docker 选择发生变化'):bridge.invoke(row,['wallet','status'])
        run.assert_not_called()
    def test_dashboard_runtime_injection_keeps_valid_wallet_binding(self):
        row=safety.bind_environment(self.row)
        with patch.dict(os.environ,runtime.runtime_environment(),clear=True):safety.verify_environment_binding(row)
    def test_virtualenv_interpreter_path_not_resolved_away(self):
        venv=self.root/'venv/bin/python';venv.parent.mkdir(parents=True)
        try:venv.symlink_to(sys.executable)
        except OSError:self.skipTest('symlinks unavailable')
        self.entry.write_text('#!'+str(venv)+'\nprint(1)')
        # Shebang paths containing spaces require explicit interpreter array.
        self.row['command']=[str(venv),str(self.entry)]
        bound=safety.bind_environment(sources.normalize_entry(self.row,self.root));self.assertEqual(bound['command'][0],str(venv))
    def test_entry_runtime_version_replacement_blocks_without_wallet_command(self):
        executable=self.root/('original.exe' if os.name=='nt' else 'original');executable.write_bytes(b'old executable')
        row=safety.bind_environment(dict(self.row,command=[str(executable)]));executable.write_bytes(b'new executable version')
        with patch.object(bridge,'run_command') as run:
            with self.assertRaisesRegex(bridge.BridgeError,'入口或解释器文件已更新'):bridge.invoke(row,['wallet','status'])
        run.assert_not_called()
    def test_no_session_store_read_to_fingerprint_public_entry(self):
        store=self.root/'.baw';store.mkdir();(store/'session.json').write_text('synthetic only')
        original=Path.read_text
        def read(p,*args,**kwargs):
            self.assertNotIn('.baw',p.parts);return original(p,*args,**kwargs)
        with patch.object(Path,'read_text',read):
            row=safety.bind_environment(self.row);safety.verify_environment_binding(row)
    def test_recheck_preserves_new_environment_binding_and_keeps_failed_original(self):
        cfg={'installationId':'test','wallets':[self.row,dict(self.row,account=2)],'issues':[]};bound=safety.bind_environment(self.row)
        with patch.object(sys,'argv',['setup.py','--recheck-wallets']),patch.object(setup,'LOCAL',self.root),patch.object(setup,'verify_release',return_value=1),patch.object(setup,'read',return_value=cfg),patch.object(setup,'current',return_value=None),patch.object(setup,'node_and_npm',return_value=('node','npm')),patch.object(setup,'dependencies'),patch.object(setup,'save') as save,patch.object(setup,'verify_entries',return_value=([bound],[{'account':2,'code':'WALLET_DISCONNECTED'}])),patch.object(setup,'start',return_value=('http://127.0.0.1:1',{'mode':'LIVE','wallets':cfg['wallets']})):
            result=setup.main()
        self.assertTrue(result['success'],result);saved=save.call_args.args[1];self.assertIn('execution',saved['wallets'][0]);self.assertEqual(saved['wallets'][1],cfg['wallets'][1])

if __name__=='__main__':unittest.main()
