import argparse
import json
import os
from pathlib import Path
import secrets
import shlex
import subprocess


def main():
    parser = argparse.ArgumentParser(description='Install a new private AstrBot instance alongside Loom.')
    parser.add_argument('--host', required=True)
    parser.add_argument('--identity', required=True)
    parser.add_argument('--private-dir', required=True, type=Path)
    args = parser.parse_args()
    private = args.private_dir.resolve()
    if not private.is_dir():
        raise SystemExit('Use the existing owner-restricted private directory.')
    path = private / 'astrbot-admin.json'
    if path.exists():
        raise SystemExit('AstrBot bootstrap credentials already exist; inspect the installation before retrying.')
    credentials = {'username': 'loom-admin', 'password': 'Aa1!' + secrets.token_urlsafe(32)}
    path.write_text(json.dumps(credentials, indent=2) + '\n', encoding='utf-8')
    if os.name != 'nt':
        path.chmod(0o600)
    installer = Path(__file__).with_name('install-astrbot.py').read_text(encoding='utf-8')
    command = ['ssh', '-i', args.identity, '-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes',
               '-o', 'StrictHostKeyChecking=yes', '-o', 'UpdateHostKeys=no', args.host,
               'python3 -c ' + shlex.quote(installer)]
    result = subprocess.run(command, input=json.dumps(credentials).encode())
    if result.returncode:
        raise SystemExit('AstrBot installation did not complete; private bootstrap credentials were preserved.')
    print('AstrBot admin credentials remain in the local private astrbot-admin.json; no values were printed.')


if __name__ == '__main__':
    main()
