"""Packaging must fail before copying private or escaping paths."""
import importlib.util
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

spec=importlib.util.spec_from_file_location('release_manifest',Path(__file__).resolve().parents[1]/'tools/update_manifest.py')
manifest=importlib.util.module_from_spec(spec)
spec.loader.exec_module(manifest)

class ReleaseScope(unittest.TestCase):
    def test_private_paths_and_cross_platform_escapes(self):
        with tempfile.TemporaryDirectory() as tmp,patch.object(manifest,'ROOT',Path(tmp).resolve()):
            for name in ['../outside.json','/tmp/source.json','C:/wallet.json','a\\b.json','.env.production','LOCAL/config.json','wallet-containers/account1.sh','a/ACCOUNTS.JSON','runtime/orders.json','local/install.json']:
                with self.subTest(name=name),self.assertRaises(ValueError):manifest.check_path(name)
            good=Path(tmp).resolve()/'module.mjs';good.write_text('export const value=1;')
            self.assertEqual(manifest.check_path('module.mjs'),good)

    def test_parent_symlink_cannot_smuggle_local_files(self):
        with tempfile.TemporaryDirectory() as tmp,patch.object(manifest,'ROOT',Path(tmp).resolve()):
            root=Path(tmp);(root/'local').mkdir();(root/'local/example.json').write_text('{}')
            try:(root/'source').symlink_to(root/'local',target_is_directory=True)
            except OSError as e:
                self.skipTest('Symlinks unavailable on this runner: '+type(e).__name__)
            with self.assertRaises(ValueError):manifest.check_path('source/example.json')

if __name__=='__main__':unittest.main()
