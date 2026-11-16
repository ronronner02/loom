import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer, request } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createControlServer } from '../server.js';

async function fixture(t: { after(fn: () => Promise<void>): void }, askUrl = 'http://127.0.0.1:1') {
  const dir = mkdtempSync(join(tmpdir(), 'loom-http-'));
  const owner = 'owner'.repeat(10), runner = 'runner'.repeat(10), ask = 'ask'.repeat(15);
  const app = createControlServer({ dataDir: dir, publicUrl: 'http://127.0.0.1', ownerKey: owner, runnerKey: runner, askKey: ask, askUrl, notificationsConfigured: false });
  await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  t.after(async () => { await app.close(); rmSync(dir, { recursive: true }); });
  async function call(path: string, token: string, data?: unknown, extra: Record<string, string> = {}) {
    return fetch(base + path, { method: data === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...extra },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
  }
  await call('/control/runner/register', runner, { instance: 'one', label: 'Windows', workspaces: [{ id: 'demo', label: 'Demo' }] });
  return { app, base, owner, runner, call };
}
test('owner, runner, and job authorities are separate', async t => {
  const f = await fixture(t);
  assert.equal((await f.call('/control/api/status', '')).status, 401);
  assert.equal((await f.call('/control/api/status', f.runner)).status, 401);
  assert.equal((await f.call('/control/runner/claim', f.owner, { instance: 'one' })).status, 401);
  const created = await (await f.call('/control/api/jobs', f.owner, { title: 'Test', prompt: 'Test', workspace: 'demo' })).json();
  const claimed = await (await f.call('/control/runner/claim', f.runner, { instance: 'one' })).json();
  assert.equal(claimed.job.id, created.id); assert.equal(claimed.job.token_hash, undefined);
  assert.equal((await f.call(`/control/runner/jobs/${created.id}/start`, f.runner, {})).status, 401);
  assert.equal((await f.call(`/control/runner/jobs/${created.id}/start`, claimed.token, {})).status, 200);
  assert.equal((await f.call(`/control/runner/jobs/${randomUUID()}/start`, claimed.token, {})).status, 401);
});
test('mobile submissions are idempotent across a lost HTTP response', async t => {
  const f = await fixture(t);
  const payload = { title: 'Test', prompt: 'Test', workspace: 'demo', requestId: randomUUID() };
  const first = await (await f.call('/control/api/jobs', f.owner, payload)).json();
  const second = await (await f.call('/control/api/jobs', f.owner, payload)).json();
  assert.equal(first.id, second.id); assert.equal(f.app.store.jobs().length, 1);
  assert.equal((await f.call('/control/api/jobs', f.owner, { ...payload, prompt: 'Changed' })).status, 409);
});
test('cookie authentication is HttpOnly and rejects cross-origin writes', async t => {
  const f = await fixture(t);
  const login = await f.call('/control/api/login', '', { key: f.owner }, { Origin: 'http://127.0.0.1' });
  assert.equal(login.status, 200); const cookie = login.headers.get('set-cookie')!;
  assert.match(cookie, /HttpOnly/); assert.match(cookie, /SameSite=Strict/);
  const headers = { Cookie: cookie.split(';')[0] };
  assert.equal((await f.call('/control/api/status', '', undefined, headers)).status, 200);
  assert.equal((await f.call('/control/api/jobs', '', { title: 'Test', prompt: 'Test', workspace: 'demo' }, headers)).status, 403);
  assert.equal((await f.call('/control/api/jobs', '', { title: 'Test', prompt: 'Test', workspace: 'demo' }, { ...headers, Origin: 'https://other.test' })).status, 403);
});
test('missing push configuration fails the question without granting approval', async t => {
  const f = await fixture(t);
  const job = await (await f.call('/control/api/jobs', f.owner, { title: 'Test', prompt: 'Test', workspace: 'demo' })).json();
  const claim = await (await f.call('/control/runner/claim', f.runner, { instance: 'one' })).json();
  await f.call(`/control/runner/jobs/${job.id}/start`, claim.token, {});
  const question = await (await f.call(`/control/runner/jobs/${job.id}/questions`, claim.token, { callback: 'one', spec: { kind: 'approval', detail: 'Test operation' } })).json();
  assert.equal(question.status, 'failed'); assert.equal(question.answer, '{}'); assert.match(question.error, /No approval/);
  await f.call(`/control/api/jobs/${job.id}/cancel`, f.owner, {});
  assert.equal((await f.call(`/control/runner/jobs/${job.id}/questions`, claim.token, { callback: 'two', spec: { kind: 'approval', detail: 'New' } })).status, 409);
});
test('the mobile page has a restrictive script policy and no embedded secrets', async t => {
  const f = await fixture(t);
  const response = await fetch(f.base + '/control/'); const html = await response.text();
  assert.equal(response.status, 200); assert.match(response.headers.get('content-security-policy')!, /script-src 'self'/);
  assert.ok(!html.includes(f.owner)); assert.ok(!html.includes(f.runner)); assert.match(html, /name="viewport"/);
});

test('absolute and ambiguous request targets never turn interaction routing into an open proxy', async t => {
  const f = await fixture(t);
  let reached = false;
  const other = createServer((_req, res) => { reached = true; res.end('Unrelated service'); });
  await new Promise<void>(resolve => other.listen(0, '127.0.0.1', resolve));
  t.after(() => { other.closeAllConnections(); other.close(); });
  const port = (other.address() as { port: number }).port;
  const targets = [
    [`http://127.0.0.1:${port}/r/test`, 404], [`//127.0.0.1:${port}/r/test`, 404],
    [`/\\127.0.0.1:${port}/r/test`, 404], [`\\\\127.0.0.1:${port}/r/test`, 400],
  ] as const;
  for (const [path, expected] of targets) {
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(f.base, { path }, res => { res.resume(); res.once('end', () => resolve(res.statusCode!)); });
      req.on('error', reject); req.end();
    });
    assert.equal(status, expected, path);
  }
  assert.equal(reached, false);
});

test('job endpoints never disclose the owner interaction capability', async t => {
  const f = await fixture(t);
  const job = f.app.store.create('Test', 'Test', 'demo');
  const claim = f.app.store.claim('one')!; f.app.store.start(job.id);
  const spec = { kind: 'approval' as const, detail: 'Test operation' };
  const q = f.app.store.addQuestion(job.id, 'callback', spec);
  const url = 'http://127.0.0.1/r/request?token=owner-interaction-capability';
  f.app.store.linkQuestion(q.id, url);
  const ownerState = await (await f.call('/control/api/status', f.owner)).json();
  assert.equal(ownerState.questions[0].url, url);
  const state = await (await f.call(`/control/runner/jobs/${job.id}`, claim.token)).json();
  assert.deepEqual(Object.keys(state.questions[0]).sort(), ['answer', 'error', 'id', 'status']);
  const repeated = await (await f.call(`/control/runner/jobs/${job.id}/questions`, claim.token, { callback: 'callback', spec })).json();
  assert.deepEqual(Object.keys(repeated).sort(), ['answer', 'error', 'id', 'status']);
  assert.ok(!JSON.stringify([state, repeated]).includes('owner-interaction-capability'));
});

test('origin-form interaction requests preserve their query but not scheduler credentials', async t => {
  const backend = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ path: req.url, authorization: req.headers.authorization ?? null, cookie: req.headers.cookie ?? null,
      body: Buffer.concat(chunks).toString() }));
  });
  await new Promise<void>(resolve => backend.listen(0, '127.0.0.1', resolve));
  t.after(() => { backend.closeAllConnections(); backend.close(); });
  const f = await fixture(t, `http://127.0.0.1:${(backend.address() as { port: number }).port}`);
  const path = '/r/request/submit?k=interaction-fixture&value=%2F';
  const response = await f.call(path, f.owner, { decision: 'decline' }, { Cookie: 'loom_session=fixture' });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { path, authorization: null, cookie: null, body: '{"decision":"decline"}' });
});

test('interaction forms preserve same-origin POSTs without exposing capability URLs in referrers', async t => {
  let reached = 0;
  const backend = createServer((req, res) => {
    reached++; req.resume();
    res.setHeader('Content-Type', 'text/html');
    res.end('<form method="post" action="./submit?k=fixture"><button>Send</button></form>');
  });
  await new Promise<void>(resolve => backend.listen(0, '127.0.0.1', resolve));
  t.after(() => { backend.closeAllConnections(); backend.close(); });
  const f = await fixture(t, `http://127.0.0.1:${(backend.address() as { port: number }).port}`);
  const page = await fetch(f.base + '/r/request/?k=fixture');
  assert.equal(page.status, 200);
  assert.equal(page.headers.get('referrer-policy'), 'strict-origin');
  await page.text();
  const headers = { 'Content-Type': 'application/x-www-form-urlencoded' };
  const submit = await fetch(f.base + '/r/request/submit?k=fixture', {
    method: 'POST', headers: { ...headers, Origin: 'http://127.0.0.1' }, body: 'text=fixture',
  });
  assert.equal(submit.status, 200); await submit.text();
  const accepted = reached;
  for (const origin of ['null', 'https://other.test']) {
    const rejected = await fetch(f.base + '/r/request/submit?k=fixture', {
      method: 'POST', headers: { ...headers, Origin: origin }, body: 'text=fixture',
    });
    assert.equal(rejected.status, 403);
    assert.deepEqual(await rejected.json(), { error: 'Origin check failed.' });
  }
  assert.equal(reached, accepted);
});

test('reply pages receive the mobile skin without changing their native form or upstream assets', async t => {
  const html = '<!doctype html><html><head><title>Loom: reply needed</title></head><body><form method="post" action="./submit?k=fixture"><input name="payload_json" value="fixture"></form></body></html>';
  const backend = createServer((req, res) => {
    const spec = req.url?.includes('/spec');
    const content = spec ? '{"schema":{"type":"object"}}' : html;
    res.writeHead(200, { 'Content-Type': spec ? 'application/json' : 'text/html; charset=utf-8', 'Content-Length': Buffer.byteLength(content) });
    res.end(content);
  });
  await new Promise<void>(resolve => backend.listen(0, '127.0.0.1', resolve));
  t.after(() => { backend.closeAllConnections(); backend.close(); });
  const f = await fixture(t, `http://127.0.0.1:${(backend.address() as { port: number }).port}`);
  const page = await fetch(f.base + '/r/request/?k=fixture');
  const themed = await page.text();
  assert.match(themed, /href="\/control\/interaction.css"/);
  assert.match(themed, /src="\/control\/interaction.js" defer/);
  assert.match(themed, /action="\.\/submit\?k=fixture"/);
  assert.match(themed, /name="payload_json" value="fixture"/);
  assert.equal(Number(page.headers.get('content-length')), Buffer.byteLength(themed));
  assert.equal(page.headers.get('referrer-policy'), 'strict-origin');
  assert.equal(await (await fetch(f.base + '/r/request/spec?k=fixture')).text(), '{"schema":{"type":"object"}}');
  assert.equal(await (await fetch(f.base + '/static/upstream.html')).text(), html);
  for (const asset of ['interaction.css', 'interaction.js']) {
    const response = await fetch(f.base + '/control/' + asset);
    assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.ok(!(await response.text()).includes(f.owner));
  }
});

test('a late dispatch acknowledgement never starts expired work', async t => {
  const f = await fixture(t);
  const job = f.app.store.create('Test', 'Test', 'demo'); const claim = f.app.store.claim('one')!;
  f.app.store.db.prepare('UPDATE jobs SET updated=? WHERE id=?').run(Date.now() - 61_000, job.id);
  assert.equal((await f.call(`/control/runner/jobs/${job.id}/start`, claim.token, {})).status, 409);
  assert.equal(f.app.store.job(job.id)?.status, 'interrupted');
});

test('maximum retained results finish and release the next queued job', async t => {
  const f = await fixture(t);
  for (const output of ['\u754c'.repeat(64_000), '\u0000'.repeat(64_000)]) {
    const job = f.app.store.create('Large result', 'Test', 'demo');
    const claim = f.app.store.claim('one')!;
    f.app.store.start(job.id);
    const next = f.app.store.create('Next task', 'Test', 'demo');
    const result = { status: 'succeeded', output, error: '\u0000'.repeat(2000) };
    assert.ok(Buffer.byteLength(JSON.stringify(result)) > 128_000);
    assert.equal((await f.call(`/control/runner/jobs/${job.id}/finish`, claim.token, result)).status, 200);
    assert.equal(f.app.store.job(job.id)?.output, output);
    assert.equal(f.app.store.job(job.id)?.status, 'succeeded');
    const following = await (await f.call('/control/runner/claim', f.runner, { instance: 'one' })).json();
    assert.equal(following.job.id, next.id);
    assert.equal((await f.call(`/control/runner/jobs/${next.id}/finish`, following.token, { status: 'succeeded', output: 'Done' })).status, 200);
  }
});

test('the completion allowance stays bounded and does not raise owner request limits', async t => {
  const f = await fixture(t);
  const job = f.app.store.create('Test', 'Test', 'demo');
  const claim = f.app.store.claim('one')!;
  f.app.store.start(job.id);
  assert.equal((await f.call(`/control/runner/jobs/${job.id}/finish`, claim.token, { status: 'succeeded', output: 'x'.repeat(512_000) })).status, 413);
  assert.equal(f.app.store.job(job.id)?.status, 'running');
  assert.equal((await f.call('/control/api/jobs', f.owner, { title: 'Test', workspace: 'demo', prompt: 'x'.repeat(128_000) })).status, 413);
});
