import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { formFor, validateAnswer, waitForAnswer } from '../ask4me.js';
import type { Question } from '../store.js';

test('push messages omit operation details and approval defaults to rejection', () => {
  const form = formFor({ kind: 'approval', detail: 'private command and repository path' });
  assert.ok(!form.body.includes('private command'));
  assert.equal(form.jsonforms.data.decision, 'decline');
  assert.deepEqual((form.jsonforms.schema.properties.decision as { enum: string[] }).enum, ['decline', 'accept']);
  assert.equal(form.jsonforms.submit_label, 'Confirm decision');
  assert.equal(form.jsonforms.data.details, 'private command and repository path');
  assert.equal(formFor({ kind: 'input', detail: 'A question', fields: [{ id: 'reply', question: 'Your reply' }] }).jsonforms.submit_label, 'Send reply');
});
test('only explicit one-request approval decisions are accepted', () => {
  const spec = { kind: 'approval' as const, detail: 'Test' };
  assert.deepEqual(validateAnswer(spec, { decision: 'accept', details: 'tampered' }), { decision: 'accept' });
  assert.throws(() => validateAnswer(spec, { decision: 'acceptForSession' }));
  assert.throws(() => validateAnswer(spec, {}));
});
test('HTTP event stream returns the exact request-bound answer', async t => {
  let connection: string | undefined;
  const service = createServer((req, res) => {
    connection = req.headers.connection;
    assert.equal(new URL(req.url!, 'http://local').searchParams.get('request_id'), 'req_fixed');
    assert.equal(req.headers.authorization, 'Bearer secret');
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end('data: {"type":"request.created","data":{"interaction_url":"https://example.test/r/req_fixed?token=scoped"}}\n\ndata: {"type":"user.submitted","data":{"payload":{"decision":"decline"}}}\n\n');
  });
  await new Promise<void>(resolve => service.listen(0, '127.0.0.1', resolve));
  t.after(() => { service.closeAllConnections(); service.close(); });
  const port = (service.address() as { port: number }).port;
  let link = '';
  const q = { spec: JSON.stringify({ kind: 'approval', detail: 'A command' }), request_id: 'req_fixed', created: Date.now() } as Question;
  const result = await waitForAnswer(q, { endpoint: `http://127.0.0.1:${port}`, key: 'secret', publicUrl: 'https://example.test' }, value => { link = value; }, new AbortController().signal);
  assert.equal(connection, 'close', 'The form service reads the POST body after flushing its stream headers.');
  assert.equal(link, 'https://example.test/r/req_fixed?token=scoped');
  assert.deepEqual(result, { answer: { decision: 'decline' }, error: '' });
});
test('notification delivery failure never grants permission', async t => {
  const service = createServer((_req, res) => res.end('data: {"type":"notify.failed","data":{"error":"upstream credential detail"}}\n\n'));
  await new Promise<void>(resolve => service.listen(0, '127.0.0.1', resolve));
  t.after(() => { service.closeAllConnections(); service.close(); });
  const port = (service.address() as { port: number }).port;
  const q = { spec: JSON.stringify({ kind: 'approval', detail: 'A command' }), request_id: 'req_fixed', created: Date.now() } as Question;
  const result = await waitForAnswer(q, { endpoint: `http://127.0.0.1:${port}`, key: 'secret', publicUrl: 'https://example.test' }, () => {}, new AbortController().signal);
  assert.deepEqual(result.answer, {});
  assert.match(result.error, /No approval/);
  assert.ok(!result.error.includes('credential detail'));
});
