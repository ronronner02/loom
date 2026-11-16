import importlib.util
import io
import os
from pathlib import Path
import stat
import tarfile
import tempfile
import unittest


spec = importlib.util.spec_from_file_location('install_server', Path(__file__).with_name('install-server.py'))
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)


class BuildContextTests(unittest.TestCase):
    @unittest.skipIf(os.name == 'nt', 'POSIX directory permissions are verified on the Linux deployment platform.')
    def test_public_image_inputs_are_readable_and_secrets_stay_private(self):
        payload = io.BytesIO()
        with tarfile.open(fileobj=payload, mode='w:gz') as archive:
            for name in ['app/Dockerfile', 'app/dist/server.js', 'app/web/interaction.js', 'secrets/control.env']:
                member = tarfile.TarInfo(name)
                member.size = 1
                archive.addfile(member, io.BytesIO(b'x'))
        with tempfile.TemporaryDirectory(prefix='loom-context-') as directory:
            root = Path(directory).resolve()
            previous = os.umask(0o077)
            try:
                installer.extract_package(root, payload.getvalue())
            finally:
                os.umask(previous)
            for name in ['app', 'app/dist', 'app/web']:
                self.assertEqual(stat.S_IMODE((root / name).stat().st_mode), 0o755, name)
            self.assertEqual(stat.S_IMODE((root / 'app/dist/server.js').stat().st_mode), 0o644)
            self.assertEqual(stat.S_IMODE((root / 'secrets').stat().st_mode), 0o700)
            self.assertEqual(stat.S_IMODE((root / 'secrets/control.env').stat().st_mode), 0o600)


if __name__ == '__main__':
    unittest.main()
