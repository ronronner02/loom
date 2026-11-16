import io
import os
from pathlib import Path
import socket
import subprocess
import sys
import tarfile
import time
import urllib.request


NODE_IMAGE = 'node@sha256:116b800c3754b440ee0aa3ed2f20f5bf3d99a554bfd9adeea09ea8017f6e85f5'
ASK_IMAGE = 'ghcr.io/easychen/ask4me@sha256:02b380e5f3dfafff465c5df1a3cb2a73c2470464bf859ecd5d2ff7c769b1bf20'


def run(*args):
    result = subprocess.run(args, text=True, capture_output=True)
    if result.returncode:
        raise RuntimeError(f'Server operation failed: {args[0]} {args[1]}. No credential values were logged.')
    return result.stdout.strip()


def extract_package(root, payload):
    with tarfile.open(fileobj=io.BytesIO(payload), mode='r:gz') as archive:
        for member in archive.getmembers():
            target = (root / member.name).resolve()
            if not member.isfile() or not target.is_relative_to(root) or member.size > 2_000_000:
                raise SystemExit('Invalid deployment member.')
            target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            target.write_bytes(archive.extractfile(member).read())
            target.chmod(0o600 if member.name.startswith('secrets/') else 0o644)
    # Docker copies these directory modes into the image, where the service runs as a non-root user.
    for directory in ['app', 'app/dist', 'app/web']:
        (root / directory).chmod(0o755)


def main():
    os.umask(0o077)
    root = Path.home() / 'loom'
    if root.exists():
        raise SystemExit('The application directory already exists; nothing was replaced.')
    run('docker', 'info', '--format', '{{.ServerVersion}}')
    for kind, name in [('container', 'loom-control'), ('container', 'loom-ask4me'), ('network', 'loom-private')]:
        if subprocess.run(['docker', kind, 'inspect', name], capture_output=True).returncode == 0:
            raise SystemExit('A named application resource already exists; nothing was replaced.')
    with socket.socket() as probe:
        probe.bind(('127.0.0.1', 18760))
    payload = sys.stdin.buffer.read(10_000_001)
    if len(payload) > 10_000_000:
        raise SystemExit('Deployment package exceeded the size limit.')
    root.mkdir(mode=0o700)
    extract_package(root, payload)
    for directory in ['data/control', 'data/ask4me']:
        (root / directory).mkdir(parents=True, mode=0o700)
    (root / 'data/ask4me/.env').touch(mode=0o600)
    digest = (root / 'release.txt').read_text().strip()
    if len(digest) != 64 or any(c not in '0123456789abcdef' for c in digest):
        raise SystemExit('Invalid source digest.')
    image = 'loom-control:' + digest[:16]
    run('docker', 'build', '--pull=false', '--build-arg', 'NODE_IMAGE=' + NODE_IMAGE, '-t', image, str(root / 'app'))
    run('docker', 'network', 'create', '--label', 'io.loom.stack=loom', 'loom-private')
    common = ['--detach', '--restart', 'unless-stopped', '--network', 'loom-private', '--label', 'io.loom.stack=loom',
              '--user', f'{os.getuid()}:{os.getgid()}', '--read-only', '--tmpfs', '/tmp:rw,nosuid,nodev,size=64m',
              '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true', '--pids-limit', '128',
              '--memory', '512m', '--cpus', '1', '--log-opt', 'max-size=10m', '--log-opt', 'max-file=2']
    run('docker', 'run', *common, '--name', 'loom-ask4me', '--env-file', str(root / 'secrets/ask4me.env'),
        '--mount', f'type=bind,source={root}/data/ask4me,target=/data', ASK_IMAGE)
    run('docker', 'run', *common, '--name', 'loom-control', '--env-file', str(root / 'secrets/control.env'),
        '--mount', f'type=bind,source={root}/data/control,target=/data', '--publish', '127.0.0.1:18760:3000', image)
    for _ in range(20):
        try:
            with urllib.request.urlopen('http://127.0.0.1:18760/healthz', timeout=2) as response:
                if response.status == 200:
                    break
        except OSError:
            time.sleep(1)
    else:
        raise SystemExit('The new scheduler did not pass its loopback health check.')
    run('docker', 'exec', 'loom-control', 'node', '--input-type=module', '-e',
        "const r=await fetch('http://loom-ask4me:8080/r/probe/');if(r.status!==400)process.exit(1)")
    print('Both application services are reachable. Scheduler binding: 127.0.0.1:18760.')
    print('Existing proxy routes, other containers, and host runtimes were not modified.')


if __name__ == '__main__':
    main()
