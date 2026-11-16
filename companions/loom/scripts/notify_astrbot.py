#!/usr/bin/env python3
import argparse
import http.client
import json
from pathlib import Path
import re
from urllib.parse import urlsplit


def send_notification(config, title, body):
    if not config.get('umo'):
        raise ValueError('The WeChat recipient has not been paired.')
    endpoint = urlsplit(config['endpoint'])
    if endpoint.scheme != 'http' or endpoint.hostname not in ['loom-astrbot', '127.0.0.1'] or endpoint.username or endpoint.password:
        raise ValueError('The notification API must use the private network.')
    connection = http.client.HTTPConnection(endpoint.hostname, endpoint.port, timeout=15)
    try:
        # WeChat opens bare links, not the Markdown link emitted by the form service.
        body = re.sub(r'\[(https?://[^\s\]]+)\]\(<\1>\)', r'\1', body)
        connection.request('POST', endpoint.path, json.dumps({'umo': config['umo'], 'message': title + '\n\n' + body}),
                           {'Authorization': 'ApiKey ' + config['apiKey'], 'Content-Type': 'application/json'})
        response = connection.getresponse()
        if response.status != 200:
            raise ValueError('The notification API did not accept the request.')
        result = json.loads(response.read(64_000))
        if result.get('status') != 'ok':
            raise ValueError('The notification API reported a delivery error.')
    finally:
        connection.close()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('-vv', action='store_true')
    parser.add_argument('--title', required=True)
    parser.add_argument('--body', required=True)
    parser.add_argument('destinations', nargs='*')
    args = parser.parse_args()
    try:
        config = json.loads(Path('/run/secrets/astrbot-notify.json').read_text(encoding='utf-8'))
        send_notification(config, args.title, args.body)
    except Exception:
        raise SystemExit('WeChat notification delivery failed. No response was granted.')


if __name__ == '__main__':
    main()
