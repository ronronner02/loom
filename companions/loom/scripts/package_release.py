import argparse
import json
from pathlib import Path
import re
import stat
import zipfile


# Public source only. Deployment packages from deploy.py contain private environment files.
FILES = (
    '.dockerignore', '.gitignore', 'Dockerfile', 'Dockerfile.ask4me', 'LICENSE', 'README.md',
    'INTEGRATION.md', 'package.json', 'package-lock.json', 'tsconfig.json',
    'src/ask4me.ts', 'src/codex.ts', 'src/runner.ts', 'src/server.ts', 'src/store.ts',
    'src/test/ask4me.test.ts', 'src/test/codex.test.ts', 'src/test/server.test.ts',
    'src/test/store.test.ts', 'src/test/fixtures/native.mjs',
    'web/app.js', 'web/index.html', 'web/interaction.css', 'web/interaction.js', 'web/style.css',
    'scripts/activate_astrbot.py', 'scripts/configure-local.py', 'scripts/connect-astrbot.py',
    'scripts/deploy-astrbot.py', 'scripts/deploy.py', 'scripts/install-astrbot.py',
    'scripts/install-server.py', 'scripts/notify_astrbot.py', 'scripts/start-runner.ps1',
    'scripts/stop-runner.ps1', 'scripts/package_release.py', 'scripts/test_activate_astrbot.py',
    'scripts/test_deploy.py', 'scripts/test_notify_astrbot.py', 'scripts/test_package_release.py',
    'scripts/test_install_server.py',
)


def build_release(root, output):
    root = root.resolve()
    files = {}
    for name in FILES:
        source = root / name
        if source.resolve() != source or not source.is_file():
            raise ValueError('A release input is missing or resolves through a link: ' + name)
        files[name] = source.read_bytes()
    version = json.loads(files['package.json'])['version']
    if not re.fullmatch(r'\d+\.\d+\.\d+', version):
        raise ValueError('The release version must be a numeric major.minor.patch value.')
    with zipfile.ZipFile(output, 'x') as archive:
        for name, data in sorted(files.items()):
            entry = zipfile.ZipInfo(f'loom-companion-{version}/{name}')
            entry.external_attr = (stat.S_IFREG | 0o644) << 16
            entry.compress_type = zipfile.ZIP_DEFLATED
            archive.writestr(entry, data)
    return len(files)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='Package the optional companion source without private configuration.')
    parser.add_argument('--output', required=True, type=Path)
    args = parser.parse_args()
    count = build_release(Path(__file__).resolve().parent.parent, args.output)
    print(f'Packaged {count} public source files. No runtime configuration or credentials were included.')
