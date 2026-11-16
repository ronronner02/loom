import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { setTimeout as sleep } from 'node:timers/promises';
import type { QuestionSpec } from './store.js';

export interface LocalRuntime { command: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv }
export type AskOwner = (callback: string, spec: QuestionSpec) => Promise<Record<string, string>>;
type ObjectValue = Record<string, unknown>;
type Packet = { id?: string | number; method?: string; params?: ObjectValue; result?: unknown; error?: { code?: number; message?: string } };
const object = (value: unknown): ObjectValue => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as ObjectValue : {};

async function stopProcess(child: ChildProcessWithoutNullStreams) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.stdin.end();
  await Promise.race([new Promise<void>(resolve => child.once('close', () => resolve())), sleep(1500)]);
  if (child.exitCode !== null || child.signalCode !== null || !child.pid) return;
  if (process.platform === 'win32') {
    await new Promise<void>(resolve => {
      const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      killer.once('error', () => resolve()); killer.once('exit', () => resolve());
    });
  } else {
    try { process.kill(-child.pid, 'SIGTERM'); } catch { child.kill('SIGTERM'); }
  }
  await Promise.race([new Promise<void>(resolve => child.once('close', () => resolve())), sleep(1500)]);
}

export async function answerCallback(method: string, params: ObjectValue, callback: string, ask: AskOwner): Promise<unknown> {
  if (method === 'item/commandExecution/requestApproval' || method === 'item/fileChange/requestApproval') {
    if (Array.isArray(params.availableDecisions) && !params.availableDecisions.includes('accept')) return { decision: 'decline' };
    const detail = [
      method.includes('commandExecution') ? 'Approve the following local operation?' : 'Approve the following local file access?',
      typeof params.command === 'string' ? params.command : '',
      typeof params.cwd === 'string' ? `Working directory: ${params.cwd}` : '',
      typeof params.reason === 'string' ? `Reason: ${params.reason}` : '',
      typeof params.grantRoot === 'string' ? `Requested write scope: ${params.grantRoot}` : '',
      params.additionalPermissions ? `Requested permissions: ${JSON.stringify(params.additionalPermissions)}` : '',
    ].filter(Boolean).join('\n\n').slice(0, 20_000);
    const answer = await ask(callback, { kind: 'approval', detail });
    return { decision: answer.decision === 'accept' ? 'accept' : 'decline' };
  }
  if (method === 'item/tool/requestUserInput') {
    const questions = Array.isArray(params.questions) ? params.questions.map(object) : [];
    if (!questions.length || questions.length > 5 || questions.some(q => q.isSecret === true)) throw new Error('Secret input belongs in local configuration.');
    const fields = questions.map((q, index) => ({
      id: typeof q.id === 'string' ? q.id : String(index), question: String(q.question ?? 'Your response'),
      options: Array.isArray(q.options) ? q.options.map(v => String(object(v).label ?? '')) : [],
    }));
    const answer = await ask(callback, { kind: 'input', detail: 'Your task needs the following information.', fields });
    const answers: Record<string, { answers: string[] }> = Object.create(null);
    fields.forEach((field, index) => { answers[field.id] = { answers: [answer[`field_${index}`] ?? ''] }; });
    return { answers };
  }
  if (method === 'item/tool/call' && params.tool === 'ask_owner') {
    const question = object(params.arguments).question;
    if (typeof question !== 'string' || !question.trim() || question.length > 10_000) throw new Error('Invalid owner question.');
    const answer = await ask(callback, { kind: 'input', detail: question, fields: [{ id: 'reply', question: 'Your reply' }] });
    return { contentItems: [{ type: 'inputText', text: answer.field_0 ?? '' }], success: true };
  }
  throw new Error(`Unsupported local request: ${method}`);
}

export async function runCodex(runtime: LocalRuntime, prompt: string, ask: AskOwner, signal: AbortSignal): Promise<string> {
  const child = spawn(runtime.command, [...runtime.args, 'app-server', '--stdio'], {
    cwd: runtime.cwd, env: runtime.env, shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: 'pipe',
  });
  let counter = 0; let output = ''; let lastError = '';
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout }>();
  let finish!: (value: string) => void; let fail!: (error: Error) => void;
  const completed = new Promise<string>((resolve, reject) => { finish = resolve; fail = reject; });
  // Register the rejection handler before initialization; a process can fail immediately.
  void completed.catch(() => undefined);
  function send(packet: Packet) {
    if (child.stdin.destroyed) throw new Error('Local runtime connection closed.');
    child.stdin.write(`${JSON.stringify(packet)}\n`);
  }
  function rpc(method: string, params: ObjectValue) {
    const id = ++counter;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Local request timed out: ${method}`)); }, 60_000);
      pending.set(id, { resolve, reject, timer }); send({ id, method, params });
    });
  }
  const lines = createInterface({ input: child.stdout });
  const abort = () => { fail(new Error('Task cancelled.')); void stopProcess(child); };
  signal.addEventListener('abort', abort, { once: true });
  child.once('error', error => { for (const request of pending.values()) request.reject(error); fail(error); });
  child.stdin.on('error', () => fail(new Error('Local runtime input closed.')));
  child.stderr.on('data', (chunk: Buffer) => { lastError = (lastError + chunk.toString()).slice(-3000); });
  child.once('close', code => {
    const error = new Error(`Local runtime exited before completion (exit ${code ?? 'signal'}).`);
    for (const request of pending.values()) request.reject(error);
    fail(error);
  });
  lines.on('line', line => {
    if (line.length > 4_000_000) { fail(new Error('Local event exceeded its size limit.')); return; }
    let packet: Packet;
    try { packet = JSON.parse(line); } catch { fail(new Error('Local runtime returned invalid protocol data.')); return; }
    if (packet.method && packet.id !== undefined) {
      void answerCallback(packet.method, object(packet.params), String(packet.id), ask)
        .then(result => { if (!signal.aborted && !child.stdin.destroyed) send({ id: packet.id, result }); })
        .catch(() => {
          if (signal.aborted || child.stdin.destroyed) return;
          if (packet.method?.endsWith('/requestApproval')) send({ id: packet.id, result: { decision: 'decline' } });
          else if (packet.method === 'item/tool/call') send({ id: packet.id, result: { contentItems: [{ type: 'inputText', text: 'The owner response was not available; stop and report the blocker.' }], success: false } });
          else send({ id: packet.id, error: { code: -32000, message: 'Owner response was not available.' } });
        });
      return;
    }
    if (typeof packet.id === 'number' && pending.has(packet.id)) {
      const request = pending.get(packet.id)!; pending.delete(packet.id); clearTimeout(request.timer);
      if (packet.error) { lastError = JSON.stringify(packet.error); request.reject(new Error('Local protocol request failed; check local provider configuration.')); } else request.resolve(packet.result);
      return;
    }
    if (packet.method === 'item/completed') {
      const item = object(packet.params?.item);
      if (item.type === 'agentMessage' && typeof item.text === 'string') output = (output + (output ? '\n\n' : '') + item.text).slice(-64_000);
    }
    if (packet.method === 'turn/completed') {
      const turn = object(packet.params?.turn);
      if (turn.status === 'completed') finish(output || 'Task completed.');
      else { lastError = JSON.stringify(turn.error); fail(new Error(`Local turn ended: ${String(turn.status)}. Check the local runtime configuration.`)); }
    }
  });
  try {
    signal.throwIfAborted();
    await rpc('initialize', { clientInfo: { name: 'loom-local', version: '0.1.0' }, capabilities: { experimentalApi: true } });
    send({ method: 'initialized' });
    const result = object(await rpc('thread/start', {
      cwd: runtime.cwd, sandbox: 'workspace-write', approvalPolicy: 'on-request', approvalsReviewer: 'user', ephemeral: true,
      developerInstructions: 'Work only on the requested task in the selected workspace. Use ask_owner when a clarification or decision is needed. Native operation approvals are handled separately. Never request passwords, tokens, or login codes through ask_owner. Do not modify account configuration, services, scheduled tasks, or credentials. Explain results in English unless the task explicitly requests another language.',
      dynamicTools: [{ name: 'ask_owner', description: 'Ask the owner a blocking question and wait for their reply on their phone.', inputSchema: {
        type: 'object', properties: { question: { type: 'string' } }, required: ['question'], additionalProperties: false,
      } }],
    }));
    const thread = object(result.thread);
    if (typeof thread.id !== 'string') throw new Error('Local runtime did not create a thread.');
    await rpc('turn/start', { threadId: thread.id, input: [{ type: 'text', text: prompt, text_elements: [] }] });
    return await completed;
  } catch (error) {
    // Keep native stderr local; provider errors can contain account or endpoint details.
    if (lastError) process.stderr.write('Local runtime reported diagnostics; no raw diagnostics were uploaded.\n');
    throw error;
  } finally {
    signal.removeEventListener('abort', abort); lines.close();
    for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new Error('Local runtime closed.')); }
    pending.clear(); await stopProcess(child);
  }
}
