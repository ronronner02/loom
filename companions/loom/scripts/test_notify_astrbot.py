from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import threading
import unittest

from notify_astrbot import send_notification


class NotificationTests(unittest.TestCase):
    def test_the_configured_recipient_key_and_plain_link_are_used(self):
        requests = []

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                requests.append((self.path, self.headers['Authorization'], json.loads(self.rfile.read(int(self.headers['Content-Length'])))))
                self.send_response(200)
                self.end_headers()
                self.wfile.write(b'{"status":"ok"}')

            def log_message(self, *args):
                pass

        server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        thread = threading.Thread(target=server.serve_forever)
        thread.start()
        try:
            config = {'endpoint': f'http://127.0.0.1:{server.server_port}/api/v1/im/messages', 'apiKey': 'fixture-key', 'umo': 'weixin:FriendMessage:owner'}
            link = 'https://example.test/r/req_fixture/?k=fixture-key'
            send_notification(config, 'Reply needed', f'Open your interaction link.\n\n[{link}](<{link}>)')
            self.assertEqual(requests, [('/api/v1/im/messages', 'ApiKey fixture-key', {'umo': config['umo'], 'message': f'Reply needed\n\nOpen your interaction link.\n\n{link}'})])
        finally:
            server.shutdown()
            server.server_close()
            thread.join()

    def test_an_unpaired_recipient_fails_without_contacting_the_api(self):
        with self.assertRaisesRegex(ValueError, 'not been paired'):
            send_notification({'umo': ''}, 'Reply needed', 'Open your interaction link.')

    def test_public_destinations_are_rejected(self):
        with self.assertRaisesRegex(ValueError, 'private network'):
            send_notification({'umo': 'owner', 'endpoint': 'http://example.test/', 'apiKey': 'fixture'}, 'Title', 'Body')


if __name__ == '__main__':
    unittest.main()
