import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, digest } from '../store.js';

function fixture(t: { after(fn: () => void): void }) {
  const dir = mkdtempSync(join(tmpdir(), 'loom-store-'));
  const store = new Store(join(dir, 'state.db'));
  t.after(() => { store.close(); rmSync(dir, { recursive: true }); });
  store.register({ instance: 'one', label: 'Local', workspaces: [{ id: 'demo', label: 'Demo' }], seen: Date.now() });
  return store;
}

test('dispatch is exclusive and the bearer token is stored only as a digest', t => {
  const s = fixture(t);
  s.create('One', 'First', 'demo'); s.create('Two', 'Second', 'demo');
  const claim = s.claim('one')!;
  assert.equal(claim.job.status, 'claimed');
  assert.equal(claim.job.token_hash, digest(claim.token));
  assert.equal(s.claim('one'), null);
  s.start(claim.job.id);
  s.finish(claim.job.id, 'succeeded', 'Done', '');
  assert.ok(s.claim('one'));
});

test('only a locally registered workspace is accepted', t => {
  const s = fixture(t);
  assert.throws(() => s.create('Bad', 'Test', '../../elsewhere'), /not registered/);
});

test('cancelled work never resumes from a late approval or completion', t => {
  const s = fixture(t);
  const job = s.create('One', 'First', 'demo');
  s.claim('one'); s.start(job.id);
  const q = s.addQuestion(job.id, 'rpc-1', { kind: 'approval', detail: 'Run a test' });
  s.cancel(job.id);
  s.answerQuestion(q.id, { decision: 'accept' });
  s.finish(job.id, 'succeeded', 'Late output', '');
  assert.equal(s.job(job.id)!.status, 'cancelled');
  assert.equal(s.question(q.id)!.status, 'cancelled');
});

test('repeated callbacks are idempotent, but changed questions are rejected', t => {
  const s = fixture(t);
  const job = s.create('One', 'First', 'demo');
  s.claim('one'); s.start(job.id);
  const spec = { kind: 'approval' as const, detail: 'Run a test' };
  const q = s.addQuestion(job.id, 'rpc-1', spec);
  assert.equal(s.addQuestion(job.id, 'rpc-1', spec).id, q.id);
  assert.throws(() => s.addQuestion(job.id, 'rpc-1', { ...spec, detail: 'Something else' }), /different content/);
  s.answerQuestion(q.id, { decision: 'decline' });
  assert.equal(s.job(job.id)!.status, 'running');
});

test('a replacement runner neither takes over a live connection nor replays old work', t => {
  const s = fixture(t);
  const job = s.create('One', 'First', 'demo');
  s.claim('one');
  const runner = { instance: 'two', label: 'Local', workspaces: [{ id: 'demo', label: 'Demo' }], seen: Date.now() };
  assert.throws(() => s.register(runner), /Another runner/);
  const old = s.runner()!; old.seen = 0;
  s.db.prepare("UPDATE settings SET value=? WHERE key='runner'").run(JSON.stringify(old));
  s.register(runner);
  assert.equal(s.job(job.id)!.status, 'interrupted');
  assert.equal(s.claim('two'), null);
});

test('a lost claim response expires without replay or blocking the next task', t => {
  const s = fixture(t);
  const first = s.create('Lost', 'First', 'demo');
  s.claim('one');
  s.db.prepare('UPDATE jobs SET updated=? WHERE id=?').run(Date.now() - 61_000, first.id);
  const next = s.create('Next', 'Second', 'demo');
  assert.equal(s.claim('one')?.job.id, next.id);
  assert.equal(s.job(first.id)?.status, 'interrupted');
  s.start(first.id);
  assert.equal(s.job(first.id)?.status, 'interrupted');
  s.start(next.id);
  s.db.prepare('UPDATE jobs SET updated=? WHERE id=?').run(Date.now() - 61_000, next.id);
  assert.equal(s.claim('one'), null);
  assert.equal(s.job(next.id)?.status, 'running');
});
