import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import time
import urllib.request


IMAGE = 'soulter/astrbot@sha256:72f341f0ffcf6621ef820277642c5d63955f7beeac3683433ce09cac96379c78'
SEED = '''import copy,json,sys
from pathlib import Path
from astrbot.core.config.default import DEFAULT_CONFIG
from astrbot.core.utils.auth_password import hash_dashboard_password, hash_md5_dashboard_password
credentials=json.load(sys.stdin)
config=copy.deepcopy(DEFAULT_CONFIG)
config['dashboard'].update(username=credentials['username'], password=hash_md5_dashboard_password(credentials['password']),
    pbkdf2_password=hash_dashboard_password(credentials['password']), password_storage_upgraded=True,
    password_change_required=False, host='0.0.0.0', port=6185)
config['provider_settings']['enable']=False
path=Path('/AstrBot/data/cmd_config.json')
path.write_text(json.dumps(config,ensure_ascii=False),encoding='utf-8')
path.chmod(0o600)
'''


def run(*args, payload=None):
    result = subprocess.run(args, input=payload, capture_output=True)
    if result.returncode:
        raise RuntimeError(f'AstrBot operation failed: {args[0]} {args[1]}. No credentials were logged.')
    return result.stdout


def main():
    os.umask(0o077)
    root = Path.home() / 'loom'
    data = root / 'astrbot/data'
    if not (root / 'secrets').is_dir() or data.parent.exists():
        raise SystemExit('An initial Loom installation is required, and AstrBot must not already exist.')
    if subprocess.run(['docker', 'container', 'inspect', 'loom-astrbot'], capture_output=True).returncode == 0:
        raise SystemExit('The AstrBot container already exists; it was not changed.')
    with socket.socket() as probe:
        probe.bind(('127.0.0.1', 18761))
    credentials = json.loads(sys.stdin.buffer.read(16_000))
    if not isinstance(credentials.get('username'), str) or len(credentials.get('password', '')) < 32:
        raise SystemExit('Bootstrap credentials are incomplete.')
    data.mkdir(parents=True, mode=0o700)
    user = f'{os.getuid()}:{os.getgid()}'
    run('docker', 'run', '--rm', '--interactive', '--network', 'none', '--user', user, '--entrypoint', 'python',
        '--mount', f'type=bind,source={data},target=/AstrBot/data', IMAGE, '-c', SEED, payload=json.dumps(credentials).encode())
    (root / 'secrets/astrbot-admin.json').write_text(json.dumps(credentials), encoding='utf-8')
    run('docker', 'run', '--detach', '--name', 'loom-astrbot', '--restart', 'unless-stopped',
        '--network', 'loom-private', '--label', 'io.loom.stack=loom', '--user', user,
        '--read-only', '--tmpfs', '/tmp:rw,nosuid,nodev,size=256m', '--env', 'HOME=/tmp', '--env', 'PYTHONDONTWRITEBYTECODE=1',
        '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true', '--pids-limit', '256', '--memory', '1536m', '--cpus', '1',
        '--log-opt', 'max-size=10m', '--log-opt', 'max-file=2', '--publish', '127.0.0.1:18761:6185',
        '--mount', f'type=bind,source={data},target=/AstrBot/data', IMAGE)
    base = 'http://127.0.0.1:18761/api/v1'

    def call(path, body, token=''):
        headers = {'Content-Type': 'application/json'}
        if token:
            headers['Authorization'] = 'Bearer ' + token
        request = urllib.request.Request(base + path, data=json.dumps(body).encode(), headers=headers)
        with urllib.request.urlopen(request, timeout=15) as response:
            value = json.load(response)
        if value.get('status') != 'ok':
            raise RuntimeError('AstrBot API did not accept the bootstrap operation.')
        return value.get('data', {})

    for _ in range(90):
        try:
            with urllib.request.urlopen(base + '/auth/setup-status', timeout=2) as response:
                if response.status == 200:
                    break
        except OSError:
            time.sleep(2)
    else:
        raise SystemExit('AstrBot did not become ready; inspect its private service diagnostics.')
    login = call('/auth/login', credentials)
    key = call('/api-keys', {'name': 'Loom notifications', 'scopes': ['im']}, login['token'])
    notify = {'endpoint': 'http://loom-astrbot:6185/api/v1/im/messages', 'apiKey': key['api_key'], 'umo': ''}
    (root / 'secrets/astrbot-notify.json').write_text(json.dumps(notify), encoding='utf-8')
    (root / 'astrbot/image.txt').write_text(IMAGE + '\n', encoding='utf-8')
    print('AstrBot v4.29.4 is ready on 127.0.0.1:18761 with a unique admin password and an IM-only notification key.')
    print('WeChat account pairing is pending. No model/provider credentials were installed on the server.')


if __name__ == '__main__':
    main()
