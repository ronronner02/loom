import json
from pathlib import Path
import tempfile
import unittest
import zipfile

from package_release import FILES, build_release


class PublicReleaseTests(unittest.TestCase):
    def source_tree(self, root):
        for name in FILES:
            path = root / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text('public source', encoding='utf-8')
        (root / 'package.json').write_text(json.dumps({'version': '0.1.1'}))

    def test_only_allowlisted_source_enters_the_public_archive(self):
        with tempfile.TemporaryDirectory(prefix='loom-release-') as directory:
            root = Path(directory) / 'source'
            self.source_tree(root)
            for name in ['private/access.json', 'private/runner.json', 'secrets/control.env',
                         'state/loom.db', '.env', 'ssh.key', 'logs/output.log', 'node_modules/extra.js']:
                path = root / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text('PRIVATE_RELEASE_SENTINEL')
            output = Path(directory) / 'public.zip'
            self.assertEqual(build_release(root, output), len(FILES))
            with zipfile.ZipFile(output) as archive:
                self.assertEqual(set(archive.namelist()), {'loom-companion-0.1.1/' + name for name in FILES})
                self.assertNotIn(b'PRIVATE_RELEASE_SENTINEL', b''.join(archive.read(name) for name in archive.namelist()))

    def test_missing_input_fails_before_creating_an_archive(self):
        with tempfile.TemporaryDirectory(prefix='loom-release-') as directory:
            root = Path(directory) / 'source'
            self.source_tree(root)
            (root / 'src/server.ts').unlink()
            output = Path(directory) / 'public.zip'
            with self.assertRaises(ValueError):
                build_release(root, output)
            self.assertFalse(output.exists())

    def test_source_link_does_not_publish_a_private_file(self):
        with tempfile.TemporaryDirectory(prefix='loom-release-') as directory:
            root = Path(directory) / 'source'
            self.source_tree(root)
            private = Path(directory) / 'private.txt'
            private.write_text('PRIVATE_RELEASE_SENTINEL')
            source = root / 'src/server.ts'
            source.unlink()
            try:
                source.symlink_to(private)
            except OSError:
                self.skipTest('Creating symlinks is not available in this test environment.')
            with self.assertRaises(ValueError):
                build_release(root, Path(directory) / 'public.zip')


if __name__ == '__main__':
    unittest.main()
