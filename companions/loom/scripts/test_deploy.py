import io
import json
from pathlib import Path
import tarfile
import tempfile
import unittest

from deploy import env_file, package


class DeploymentPackageTests(unittest.TestCase):
    def test_only_server_configuration_is_uploaded(self):
        with tempfile.TemporaryDirectory(prefix='loom-package-') as directory:
            private = Path(directory)
            (private / 'setup.json').write_text(json.dumps({'publicUrl': 'https://example.test', 'serverchanSendKey': ''}))
            access = {'ownerKey': 'owner' * 10, 'runnerKey': 'runner' * 10, 'askKey': 'ask' * 15, 'providerKey': 'PRIVATE_PROVIDER_SENTINEL'}
            (private / 'access.json').write_text(json.dumps(access))
            (private / 'runner.json').write_text('PRIVATE_RUNNER_CONFIGURATION_SENTINEL')
            payload, digest = package(Path(__file__).resolve().parent.parent, private)
            self.assertEqual(len(digest), 64)
            with tarfile.open(fileobj=io.BytesIO(payload), mode='r:gz') as archive:
                files = {entry.name: archive.extractfile(entry).read() for entry in archive.getmembers()}
                self.assertEqual(len(files), 13)
                self.assertIn('app/web/interaction.css', files)
                self.assertIn('app/web/interaction.js', files)
                self.assertNotIn(b'PRIVATE_PROVIDER_SENTINEL', b''.join(files.values()))
                self.assertNotIn(b'PRIVATE_RUNNER_CONFIGURATION_SENTINEL', b''.join(files.values()))
                self.assertNotIn(access['ownerKey'].encode(), files['secrets/ask4me.env'])
                self.assertNotIn(access['runnerKey'].encode(), files['secrets/ask4me.env'])
                self.assertIn(b'LOOM_NOTIFICATIONS_CONFIGURED=false', files['secrets/control.env'])
                self.assertEqual(archive.getmember('secrets/control.env').mode, 0o600)

    def test_newlines_do_not_inject_environment_variables(self):
        with self.assertRaises(ValueError):
            env_file({'KEY': 'value\nEXTRA=injected'})


if __name__ == '__main__':
    unittest.main()
