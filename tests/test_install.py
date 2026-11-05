import base64
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import setup
import wallet_bridge as bridge
from wallet_safety import bind_environment

A='0x0000000000000000000000000000000000001001'
B='0x0000000000000000000000000000000000001002'
def ok(data):return {'success':True,'data':data}
def addr(a=A):return ok({'addresses':[{'binanceChainId':'56','address':a}]})

class InstallerSafety(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.root=Path(self.temp.name).resolve()
        self.home=patch.object(bridge.Path,'home',return_value=self.root);self.home.start()
    def tearDown(self):self.home.stop();self.temp.cleanup()
    def entry(self):return bind_environment({'account':1,'address':A,'command':[sys.executable],'cwd':str(self.root),'kind':'official-cli'})
    def wallet_dir(self,name='project'):
        d=self.root/name/'wallet-containers';d.mkdir(parents=True)
        (d/'accounts.json').write_text(json.dumps({'account1':A}))
        (d/'account1.sh').write_text('#!/bin/sh\nexit 0\n');(d/'account1.ps1').write_text('exit 0\n')
        return d
    def test_discovery_excludes_secret_and_runtime_trees(self):
        good=self.wallet_dir()
        for bad in ['.baw','Library','AppData','local','runtime','node_modules']:
            self.wallet_dir(bad+'/project')
        self.assertEqual(setup.find_wallet_dirs([self.root]),[good])
    def test_discovery_does_not_follow_symlinks(self):
        good=self.wallet_dir()
        try:(self.root/'linked').symlink_to(good.parent,target_is_directory=True)
        except OSError:self.skipTest('Symlink unavailable')
        self.assertEqual(setup.find_wallet_dirs([self.root]),[good])
    def test_multiple_roots_never_execute_wallet(self):
        self.wallet_dir('one');self.wallet_dir('two')
        with patch.object(setup,'invoke') as call:
            wallets,issues=setup.discover(scan_roots=[self.root])
        self.assertEqual(wallets,[]);self.assertEqual(issues[0]['code'],'CHOOSE_WALLET_DIRECTORY');call.assert_not_called()
    def test_numbered_wallet_offline_never_falls_back_to_default(self):
        self.wallet_dir()
        with patch.object(setup,'invoke',return_value=ok({'status':'UNCONNECTED'})) as call,patch.object(setup.shutil,'which') as which:
            wallets,issues=setup.discover(scan_roots=[self.root])
        self.assertEqual(wallets,[]);self.assertEqual(issues[0]['code'],'WALLET_DISCONNECTED');which.assert_not_called();self.assertEqual(call.call_count,1)
    def test_binding_checks_current_address(self):
        with patch.object(setup,'invoke',side_effect=[ok({'status':'CONNECTED'}),addr(B)]):
            wallets,issues=setup.verify_entries([self.entry()])
        self.assertEqual(wallets,[]);self.assertEqual(issues[0]['code'],'ADDRESS_MISMATCH')
    def test_binding_calls_only_status_and_address(self):
        with patch.object(setup,'invoke',side_effect=[ok({'status':'CONNECTED'}),addr()]) as call:
            wallets,issues=setup.verify_entries([self.entry()])
        self.assertEqual(len(wallets),1);self.assertEqual(issues,[])
        self.assertEqual([c.args[1] for c in call.call_args_list],[['wallet','status'],['wallet','address']])
    def test_duplicate_wallets_rejected(self):
        with patch.object(setup,'invoke',side_effect=[ok({'status':'CONNECTED'}),addr(),ok({'status':'CONNECTED'}),addr()]):
            with self.assertRaisesRegex(RuntimeError,'同一钱包'):setup.verify_entries([self.entry(),dict(self.entry(),account=2)])
    def test_invalid_binding_file_rejected(self):
        d=self.wallet_dir();(d/'accounts.json').write_text('{"account1":{"unexpected":"data"}}')
        with self.assertRaisesRegex(ValueError,'映射'):setup.entries_at(d)
    def test_read_only_test_bridge_cannot_dispatch_writes(self):
        with patch.object(bridge,'invoke') as invoke:
            for args in [['market-order','swap'],['contract-call','execute']]:
                with self.assertRaisesRegex(bridge.BridgeError,'不允许签名'):bridge.dispatch(self.entry(),args,False)
            invoke.assert_not_called()
    def test_auth_export_send_not_allowed_even_live(self):
        with patch.object(bridge,'invoke') as invoke:
            for args in [['auth','signin'],['auth','signout'],['wallet','send'],['wallet','export'],['sign-message','execute']]:
                with self.assertRaises(bridge.BridgeError):bridge.dispatch(self.entry(),args,True)
            invoke.assert_not_called()
    def test_address_change_blocks_mock_write(self):
        with patch.object(bridge,'invoke',return_value=addr(B)) as invoke:
            with self.assertRaisesRegex(bridge.BridgeError,'地址改变'):bridge.dispatch(self.entry(),['contract-call','execute','--requestId','mock'],True)
            self.assertEqual(invoke.call_count,1)
    def test_mock_write_uses_exact_entry_after_address_check(self):
        with patch.object(bridge,'invoke',side_effect=[addr(),ok({'orderId':'test-only'})]) as invoke:
            result=bridge.dispatch(self.entry(),['market-order','swap','--json'],True)
        self.assertEqual(result['data']['orderId'],'test-only');self.assertEqual(invoke.call_args_list[-1].args[0],self.entry())
    def test_wrapper_always_uses_json_and_drops_raw_errors(self):
        result=type('R',(),{'stdout':'sensitive provider response','stderr':'sensitive provider stderr','returncode':1})()
        with patch.object(bridge,'run_command',return_value=result) as run:
            with self.assertRaises(bridge.BridgeError) as error:bridge.invoke(self.entry(),['wallet','status'])
        self.assertNotIn('sensitive',str(error.exception));self.assertIn('--json',run.call_args.args[0])
    def test_wrong_chain_or_ambiguous_address_rejected(self):
        for response in [ok({'addresses':[{'binanceChainId':'1','address':A}]}),ok({'addresses':[{'binanceChainId':'56','address':A},{'binanceChainId':'56','address':B}]}),ok({'addresses':[]})]:
            with self.assertRaises(bridge.BridgeError):bridge.bsc_address(response)
    def test_windows_quoting_preserves_metacharacters_as_data(self):
        script=self.root/"wallet's entry.ps1";script.write_text('exit 0')
        arg="literal'; Write-Output injected; # $(not-a-command)"
        with patch.object(bridge.shutil,'which',return_value='powershell'):
            command=bridge.launch_args({'command':[str(script)]},['wallet','status',arg])
        decoded=base64.b64decode(command[-1]).decode('utf-16le')
        self.assertIn("'literal''; Write-Output injected; # $(not-a-command)'",decoded)
        self.assertIn("wallet''s",decoded)
    def test_foreign_service_never_accepted(self):
        cfg={'installationId':'installation-A'}
        with patch.object(setup,'read',return_value={'installationId':'installation-A','port':19999}),patch.object(setup,'http',return_value={'service':'agent-trade-console','installationId':'installation-B'}):
            self.assertIsNone(setup.current(cfg))
    def test_existing_live_service_not_silently_switched(self):
        with patch.object(setup,'current',return_value=('http://127.0.0.1:19999',{'mode':'LIVE'})),patch.object(setup,'save') as save:
            with self.assertRaisesRegex(RuntimeError,'仅提供真实'):setup.start({'installationId':'test'},False)
        save.assert_not_called()
    def test_windows_child_processes_are_hidden_and_utf8(self):
        from runtime_paths import hidden_process_options
        if sys.platform=='win32':
            options=hidden_process_options()
            self.assertTrue(options['creationflags'] & bridge.subprocess.CREATE_NO_WINDOW)
            self.assertEqual(options['startupinfo'].wShowWindow,0)
        result=type('R',(),{'stdout':'{"success":true,"data":{}}','stderr':'','returncode':0})()
        with patch.object(bridge,'run_command',return_value=result) as run:bridge.invoke(self.entry(),['wallet','status'])
        self.assertEqual(run.call_args.kwargs['timeout'],100)
    def test_missing_docker_never_launches_legacy_bootstrap(self):
        d=self.wallet_dir();(d/'wallet.ps1').write_text("$docker = @('--context', 'desktop-linux'); & './start-environment.ps1'")
        entry=dict(self.entry(),kind='numbered',command=[str(d/'account1.ps1')])
        with patch.object(bridge.shutil,'which',return_value=None),patch.object(bridge.subprocess,'run') as run:
            with self.assertRaises(bridge.BridgeError) as e:bridge.check_environment(entry)
        self.assertEqual(e.exception.code,'WALLET_ENVIRONMENT_NOT_READY');run.assert_not_called()
    def test_lock_contention_does_not_dispatch(self):
        if os.name=='nt':self.skipTest('Unix flock integration')
        with bridge.account_lock(self.entry()):
            with self.assertRaisesRegex(bridge.BridgeError,'其他进程'):
                with bridge.account_lock(self.entry(),timeout=.05):pass

if __name__=='__main__':unittest.main()
