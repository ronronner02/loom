import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { answerCallback, runCodex } from '../codex.js';

test('a native operation receives only the decision returned for that callback', async () => {
  let seen = '';
  const result = await answerCallback('item/commandExecution/requestApproval', { command: 'echo test', cwd: 'workspace' }, 'request-17', async (id, spec) => {
    seen = id; assert.match(spec.detail, /echo test/); return { decision: 'accept' };
  });
  assert.equal(seen, 'request-17'); assert.deepEqual(result, { decision: 'accept' });
});
test('unsupported and session-wide approvals are never silently granted', async () => {
  const result = await answerCallback('item/commandExecution/requestApproval', { command: 'echo test' }, 'one', async () => ({ decision: 'acceptForSession' }));
  assert.deepEqual(result, { decision: 'decline' });
  await assert.rejects(answerCallback('unknown/request', {}, 'two', async () => ({ decision: 'accept' })), /Unsupported/);
});
test('mobile answers map back to the exact native question IDs', async () => {
  const result = await answerCallback('item/tool/requestUserInput', { questions: [
    { id: 'choice', question: 'Which file?' }, { id: 'reason', question: 'Why?' },
  ] }, 'three', async () => ({ field_0: 'example.txt', field_1: 'A test' }));
  assert.deepEqual(JSON.parse(JSON.stringify(result)), { answers: { choice: { answers: ['example.txt'] }, reason: { answers: ['A test'] } } });
});
test('the owner-question tool returns the reply to the same local call', async () => {
  const result = await answerCallback('item/tool/call', { tool: 'ask_owner', arguments: { question: 'Choose a filename.' } }, 'four', async () => ({ field_0: 'note.txt' }));
  assert.deepEqual(result, { contentItems: [{ type: 'inputText', text: 'note.txt' }], success: true });
});
test('secret-entry requests stay off the notification channel', async () => {
  let asked = false;
  await assert.rejects(answerCallback('item/tool/requestUserInput', { questions: [{ id: 'token', question: 'Token?', isSecret: true }] }, 'five', async () => { asked = true; return {}; }), /local configuration/);
  assert.equal(asked, false);
});

test('a real subprocess exchanges approvals and replies through the structured protocol', async () => {
  const fixture = fileURLToPath(new URL('../../src/test/fixtures/native.mjs', import.meta.url));
  const seen: string[] = [];
  const result = await runCodex({ command: process.execPath, args: [fixture], cwd: process.cwd(), env: process.env }, 'Test the protocol', async (id, spec): Promise<Record<string, string>> => {
    seen.push(id);
    return spec.kind === 'approval' ? { decision: 'decline' } : { field_0: 'The reply reached the same local turn.' };
  }, AbortSignal.timeout(10_000));
  assert.deepEqual(seen, ['permission-1', 'question-1']);
  assert.equal(result, 'The reply reached the same local turn.');
});
