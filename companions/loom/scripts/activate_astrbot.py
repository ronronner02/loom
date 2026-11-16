import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import time
import urllib.request


NAMES = ('loom-control', 'loom-ask4me')


def paired_recipient(confirmed, config):
    platform = confirmed['platform']
    result = confirmed['result']
    owner = result.get('weixin_oc_user_id', '')
    if platform.get('type') != 'weixin_oc' or not owner or any(c in owner for c in ':\r\n'):
        raise ValueError('The confirmed private WeChat identity is missing or ambiguous.')
    bot = next((item for item in config['platform'] if item['id'] == platform['id']), None)
    if not bot or not bot.get('enable') or bot.get('type') != 'weixin_oc':
        raise ValueError('The confirmed WeChat adapter is not enabled.')
    if not result.get('weixin_oc_account_id') or bot.get('weixin_oc_account_id') != result['weixin_oc_account_id']:
        raise ValueError('The adapter does not match the account confirmed by QR login.')
    if not bot.get('weixin_oc_context_tokens', {}).get(owner):
        raise ValueError('Send a private message from the confirmed WeChat account before connecting notifications.')
    return platform['id'] + ':FriendMessage:' + owner


def replace_env(data, changes):
    if any(any(char in value for char in '\r\n\0') for value in changes.values()):
        raise ValueError('Environment values must be single-line strings.')
    lines = [line for line in data.decode('utf-8').splitlines() if line.partition('=')[0] not in changes]
    return ('\n'.join(lines + [key + '=' + value for key, value in changes.items()]) + '\n').encode()


def run(*args):
    result = subprocess.run(args, capture_output=True)
    if result.returncode:
        raise RuntimeError(f'Operation failed: {args[0]} {args[1]}. No private output was printed.')
    return result.stdout


def inspect(name):
    return json.loads(run('docker', 'inspect', name))[0]


def ensure_idle(env):
    request = urllib.request.Request('http://127.0.0.1:18760/control/api/status',
                                     headers={'Authorization': 'Bearer ' + env['LOOM_OWNER_KEY']})
    with urllib.request.urlopen(request, timeout=10) as response:
        state = json.load(response)
    require_idle(state)


def require_idle(state):
    if any(job['status'] not in ['succeeded', 'failed', 'cancelled', 'interrupted'] for job in state['jobs']):
        raise ValueError('Finish or cancel active tasks before connecting the notification transport.')
    if any(question['status'] == 'pending' for question in state['questions']):
        raise ValueError('An owner interaction is still pending.')


def main():
    os.umask(0o077)
    root = Path.home() / 'loom'
    secret_dir = root / 'secrets'
    confirmed = json.loads((secret_dir / 'wechat-confirmed.json').read_text(encoding='utf-8-sig'))
    config = json.loads((root / 'astrbot/data/cmd_config.json').read_text(encoding='utf-8-sig'))
    recipient = paired_recipient(confirmed, config)
    old_files = {name: (secret_dir / name).read_bytes() for name in ['control.env', 'ask4me.env', 'astrbot-notify.json']}
    control_env = dict(line.split('=', 1) for line in old_files['control.env'].decode().splitlines() if '=' in line)
    notify = json.loads(old_files['astrbot-notify.json'])
    if notify.get('umo') not in ['', recipient]:
        raise ValueError('A different notification recipient is already configured.')
    snapshots = {name: inspect(name) for name in NAMES}
    for name, item in snapshots.items():
        if item['Config']['Labels'].get('io.loom.stack') != 'loom' or not item['State']['Running']:
            raise ValueError('The expected running Loom containers were not found.')
        if subprocess.run(['docker', 'container', 'inspect', name + '-before-astrbot'], capture_output=True).returncode == 0:
            raise ValueError('A previous notification migration exists; inspect it before retrying.')
    backup = secret_dir / 'before-astrbot'
    if backup.exists():
        raise ValueError('Previous notification configuration backups already exist.')
    ensure_idle(control_env)
    payload = sys.stdin.buffer.read(80_001)
    if len(payload) > 80_000:
        raise ValueError('The notification build payload exceeded its size limit.')
    files = json.loads(payload)
    if set(files) != {'Dockerfile', 'notify_astrbot.py'} or not all(isinstance(value, str) for value in files.values()):
        raise ValueError('Unexpected notification build files.')
    digest = hashlib.sha256(payload).hexdigest()
    build = root / 'astrbot' / ('notifier-' + digest[:16])
    build.mkdir(mode=0o700, exist_ok=True)
    for name, content in files.items():
        (build / name).write_text(content, encoding='utf-8')
    image = 'loom-ask4me-astrbot:' + digest[:16]
    run('docker', 'build', '--pull=false', '-t', image, str(build))
    run('docker', 'run', '--rm', '--network', 'none', '--read-only', '--user', f'{os.getuid()}:{os.getgid()}',
        '--entrypoint', 'python3', image, '--version')
    ensure_idle(control_env)
    backup.mkdir(mode=0o700)
    for name, content in old_files.items():
        (backup / name).write_bytes(content)
    stopped, renamed = [], []
    try:
        for name in NAMES:
            run('docker', 'stop', '--time', '20', name)
            stopped.append(name)
            run('docker', 'rename', name, name + '-before-astrbot')
            renamed.append(name)
        notify['umo'] = recipient
        (secret_dir / 'astrbot-notify.json').write_text(json.dumps(notify), encoding='utf-8')
        (secret_dir / 'ask4me.env').write_bytes(replace_env(old_files['ask4me.env'], {
            'ASK4ME_SERVERCHAN_SENDKEY': '', 'ASK4ME_APPRISE_BIN': '/usr/local/bin/loom-notify',
            'ASK4ME_APPRISE_URLS': 'astrbot://paired',
        }))
        (secret_dir / 'control.env').write_bytes(replace_env(old_files['control.env'], {'LOOM_NOTIFICATIONS_CONFIGURED': 'true'}))
        common = ['--detach', '--restart', 'unless-stopped', '--network', 'loom-private', '--label', 'io.loom.stack=loom',
                  '--user', f'{os.getuid()}:{os.getgid()}', '--read-only', '--tmpfs', '/tmp:rw,nosuid,nodev,size=64m',
                  '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true', '--pids-limit', '128',
                  '--memory', '512m', '--cpus', '1', '--log-opt', 'max-size=10m', '--log-opt', 'max-file=2']
        run('docker', 'run', *common, '--name', 'loom-ask4me', '--env-file', str(secret_dir / 'ask4me.env'),
            '--mount', f'type=bind,source={root}/data/ask4me,target=/data',
            '--mount', f'type=bind,source={secret_dir}/astrbot-notify.json,target=/run/secrets/astrbot-notify.json,readonly', image)
        run('docker', 'run', *common, '--name', 'loom-control', '--env-file', str(secret_dir / 'control.env'),
            '--mount', f'type=bind,source={root}/data/control,target=/data', '--publish', '127.0.0.1:18760:3000',
            snapshots['loom-control']['Config']['Image'])
        for _ in range(30):
            try:
                with urllib.request.urlopen('http://127.0.0.1:18760/healthz', timeout=2) as response:
                    if response.status == 200:
                        break
            except OSError:
                time.sleep(1)
        else:
            raise RuntimeError('The updated scheduler did not become healthy.')
        run('docker', 'exec', 'loom-control', 'node', '--input-type=module', '-e',
            "const r=await fetch('http://loom-ask4me:8080/r/probe/');if(r.status!==400)process.exit(1)")
        run('docker', 'exec', 'loom-ask4me', '/usr/local/bin/loom-notify', '--title', 'Loom connection check',
            '--body', 'Your private WeChat account is connected. Questions and approvals will arrive as links.', 'astrbot://paired')
    except Exception:
        for name, content in old_files.items():
            (secret_dir / name).write_bytes(content)
        for name in reversed(stopped):
            if name in renamed:
                if subprocess.run(['docker', 'container', 'inspect', name], capture_output=True).returncode == 0:
                    run('docker', 'rm', '--force', name)
                run('docker', 'rename', name + '-before-astrbot', name)
            run('docker', 'start', name)
        raise
    print('WeChat notification transport is connected. The API accepted a test notification; confirm receipt on the phone.')
    print('Only loom-control and loom-ask4me were recreated. Their stopped originals and private configuration backups were retained.')


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(f'Notification activation stopped: {type(error).__name__}. Inspect the owned service state before retrying.')
        raise SystemExit(1)
