import argparse
import hashlib
import io
import json
from pathlib import Path
import shlex
import subprocess
import tarfile
from urllib.parse import urlsplit


def env_file(values):
    if any(not isinstance(value, str) or any(c in value for c in '\r\n\0') for value in values.values()):
        raise ValueError('Environment values must be single-line strings.')
    return ''.join(f'{key}={value}\n' for key, value in values.items()).encode()


def package(repo, private):
    setup = json.loads((private / 'setup.json').read_text(encoding='utf-8-sig'))
    access = json.loads((private / 'access.json').read_text(encoding='utf-8-sig'))
    url = urlsplit(setup['publicUrl'])
    if url.scheme != 'https' or not url.hostname or url.username or url.password or url.path not in ['', '/'] or url.query or url.fragment:
        raise ValueError('The public URL must be a credential-free HTTPS origin.')
    keys = [access[key] for key in ['ownerKey', 'runnerKey', 'askKey']]
    if any(not isinstance(key, str) or len(key) < 32 for key in keys) or len(set(keys)) != 3:
        raise ValueError('Three distinct access keys are required.')
    send_key = setup.get('serverchanSendKey', '')
    files = {f'app/{name}': (repo / name).read_bytes() for name in [
        'Dockerfile', 'package.json', 'dist/server.js', 'dist/store.js', 'dist/ask4me.js',
        'web/index.html', 'web/app.js', 'web/style.css', 'web/interaction.css', 'web/interaction.js',
    ]}
    source_hash = hashlib.sha256(b''.join(name.encode() + data for name, data in sorted(files.items()))).hexdigest()
    files['secrets/control.env'] = env_file({
        'LOOM_PUBLIC_URL': setup['publicUrl'], 'LOOM_OWNER_KEY': access['ownerKey'],
        'LOOM_RUNNER_KEY': access['runnerKey'], 'LOOM_ASK_KEY': access['askKey'],
        'LOOM_ASK_URL': 'http://loom-ask4me:8080',
        'LOOM_NOTIFICATIONS_CONFIGURED': 'true' if send_key else 'false',
    })
    files['secrets/ask4me.env'] = env_file({
        'ASK4ME_BASE_URL': setup['publicUrl'], 'ASK4ME_API_KEY': access['askKey'],
        'ASK4ME_SERVERCHAN_SENDKEY': send_key, 'ASK4ME_SQLITE_PATH': '/data/ask4me.db',
        'ASK4ME_LISTEN_ADDR': ':8080', 'HOME': '/tmp',
    })
    files['release.txt'] = (source_hash + '\n').encode()
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode='w:gz') as archive:
        for name, data in files.items():
            member = tarfile.TarInfo(name)
            member.size = len(data)
            member.mode = 0o600 if name.startswith('secrets/') else 0o644
            archive.addfile(member, io.BytesIO(data))
    return buffer.getvalue(), source_hash


def main():
    parser = argparse.ArgumentParser(description='Install a new isolated server deployment; existing deployments are left unchanged.')
    parser.add_argument('--host', required=True)
    parser.add_argument('--identity', required=True)
    parser.add_argument('--private-dir', required=True, type=Path)
    args = parser.parse_args()
    repo = Path(__file__).resolve().parent.parent
    payload, source_hash = package(repo, args.private_dir.resolve())
    installer = (repo / 'scripts' / 'install-server.py').read_text(encoding='utf-8')
    command = ['ssh', '-i', args.identity, '-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes',
               '-o', 'StrictHostKeyChecking=yes', '-o', 'UpdateHostKeys=no', args.host,
               'python3 -c ' + shlex.quote(installer)]
    # Only this explicit source/configuration allowlist enters the encrypted SSH stream.
    result = subprocess.run(command, input=payload)
    if result.returncode:
        raise SystemExit('Server installation did not complete. Inspect its named resources before retrying.')
    print('Deployed source digest:', source_hash)


if __name__ == '__main__':
    main()
