import argparse
import json
from pathlib import Path
import shlex
import subprocess


def main():
    parser = argparse.ArgumentParser(description='Connect the paired WeChat account to the existing Loom services.')
    parser.add_argument('--host', required=True)
    parser.add_argument('--identity', required=True)
    args = parser.parse_args()
    scripts = Path(__file__).resolve().parent
    payload = json.dumps({
        'Dockerfile': (scripts.parent / 'Dockerfile.ask4me').read_text(encoding='utf-8'),
        'notify_astrbot.py': (scripts / 'notify_astrbot.py').read_text(encoding='utf-8'),
    }).encode()
    remote = (scripts / 'activate_astrbot.py').read_text(encoding='utf-8')
    command = ['ssh', '-i', args.identity, '-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes',
               '-o', 'StrictHostKeyChecking=yes', '-o', 'UpdateHostKeys=no', args.host,
               'python3 -c ' + shlex.quote(remote)]
    result = subprocess.run(command, input=payload)
    raise SystemExit(result.returncode)


if __name__ == '__main__':
    main()
