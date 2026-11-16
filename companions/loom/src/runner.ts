import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync, openSync, closeSync, realpathSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { runCodex } from './codex.js';
import { terminal, type Job, type RunnerQuestion, type QuestionSpec } from './store.js';

export interface RunnerConfig {
  serverUrl: string; runnerKey: string; stateDir: string; label: string;
  command: string; args: string[]; env: Record<string, string>;
  workspaces: { id: string; label: string; path: string }[];
}
interface Result { id: string; token: string; status: 'succeeded' | 'failed'; output: string; error: string }

export async function runRunner(config: RunnerConfig, shutdown: AbortSignal) {
  const server = new URL(config.serverUrl);
  if (server.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(server.hostname)) throw new Error('The runner requires HTTPS.');
  if (config.runnerKey.length < 32 || !config.workspaces.length) throw new Error('Runner configuration is incomplete.');
  const workspaces = config.workspaces.map(w => ({ ...w, path: realpathSync(w.path) }));
  mkdirSync(config.stateDir, { recursive: true, mode: 0o700 });
  const lockPath = join(config.stateDir, 'runner.lock');
  if (existsSync(lockPath)) {
    const oldPid = Number(readFileSync(lockPath, 'utf8'));
    let running = true;
    try { process.kill(oldPid, 0); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') running = false; }
    if (running) throw new Error('A local runner already owns this state directory.');
    unlinkSync(lockPath);
  }
  const lock = openSync(lockPath, 'wx', 0o600); writeFileSync(lock, String(process.pid)); closeSync(lock);
  const instance = randomUUID(); let active: { id: string; controller: AbortController } | null = null;
  let heartbeatRunning = false;
  const pendingPath = join(config.stateDir, 'pending-result.json');
  async function request(path: string, token: string, data?: unknown) {
    const response = await fetch(new URL(path, server), { method: data === undefined ? 'GET' : 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      ...(data !== undefined ? { body: JSON.stringify(data) } : {}), signal: AbortSignal.any([shutdown, AbortSignal.timeout(20_000)]) });
    if (!response.ok) throw new Error(`Control request returned HTTP ${response.status}.`);
    return response.json();
  }
  const heartbeat = setInterval(() => {
    if (heartbeatRunning || shutdown.aborted) return; heartbeatRunning = true;
    void request('/control/runner/heartbeat', config.runnerKey, { instance, jobId: active?.id })
      .then(data => { if (active && (terminal(data.status) || data.status === 'missing')) active.controller.abort(); })
      .catch(() => { process.stderr.write('Control connection interrupted; no new job was dispatched.\n'); })
      .finally(() => { heartbeatRunning = false; });
  }, 5000);
  heartbeat.unref();
  const stop = () => active?.controller.abort(); shutdown.addEventListener('abort', stop, { once: true });
  async function flushResult() {
    if (!existsSync(pendingPath)) return;
    const result: Result = JSON.parse(readFileSync(pendingPath, 'utf8'));
    await request(`/control/runner/jobs/${result.id}/finish`, result.token, { status: result.status, output: result.output, error: result.error });
    unlinkSync(pendingPath);
  }
  try {
    while (!shutdown.aborted) {
      try {
        await flushResult();
        await request('/control/runner/register', config.runnerKey, { instance, label: config.label, workspaces: workspaces.map(({ id, label }) => ({ id, label })) });
        break;
      } catch { await sleep(5000, undefined, { signal: shutdown }).catch(() => undefined); }
    }
    while (!shutdown.aborted) {
      try {
        await flushResult();
        const claim = await request('/control/runner/claim', config.runnerKey, { instance }) as { job: Job; token: string } | null;
        if (!claim) { await sleep(2000, undefined, { signal: shutdown }); continue; }
        const { job, token } = claim; const workspace = workspaces.find(w => w.id === job.workspace);
        const controller = new AbortController(); active = { id: job.id, controller };
        const signal = AbortSignal.any([shutdown, controller.signal]);
        let result: Result = { id: job.id, token, status: 'failed', output: '', error: '' };
        try {
          if (!workspace || realpathSync(workspace.path) !== workspace.path) throw new Error('Configured workspace is not available.');
          await request(`/control/runner/jobs/${job.id}/start`, token, {});
          const ask = async (callback: string, spec: QuestionSpec) => {
            const q = await request(`/control/runner/jobs/${job.id}/questions`, token, { callback, spec }) as RunnerQuestion;
            while (!signal.aborted) {
              const state = await request(`/control/runner/jobs/${job.id}`, token) as { status: string; questions: RunnerQuestion[] };
              if (terminal(state.status)) throw new Error('Task has ended.');
              const answer = state.questions.find(item => item.id === q.id);
              if (answer?.status === 'answered') return JSON.parse(answer.answer) as Record<string, string>;
              if (answer && answer.status !== 'pending') throw new Error('The owner response was not available.');
              await sleep(1500, undefined, { signal });
            }
            throw new Error('Task cancelled.');
          };
          const env: NodeJS.ProcessEnv = {};
          for (const key of ['SystemRoot', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATH', 'Path', 'PATHEXT', 'OS', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE']) {
            if (process.env[key]) env[key] = process.env[key];
          }
          Object.assign(env, config.env);
          // The scheduler credential and job capability are never inherited by the local runtime.
          delete env.LOOM_RUNNER_KEY; delete env.LOOM_OWNER_KEY; delete env.LOOM_ASK_KEY;
          result.output = await runCodex({ command: config.command, args: config.args, cwd: workspace.path, env }, job.prompt, ask, signal);
          result.status = 'succeeded';
        } catch (error) {
          result.error = signal.aborted ? 'Task cancelled.' : error instanceof Error ? error.message.slice(0, 2000) : 'Local execution failed.';
        } finally { active = null; }
        writeFileSync(`${pendingPath}.tmp`, JSON.stringify(result), { mode: 0o600 }); renameSync(`${pendingPath}.tmp`, pendingPath);
        await flushResult();
      } catch {
        if (!shutdown.aborted) { process.stderr.write('Waiting for the control connection.\n'); await sleep(3000, undefined, { signal: shutdown }).catch(() => undefined); }
      }
    }
  } finally {
    clearInterval(heartbeat); shutdown.removeEventListener('abort', stop);
    if (existsSync(lockPath) && readFileSync(lockPath, 'utf8') === String(process.pid)) unlinkSync(lockPath);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const path = process.argv[2];
  if (!path) throw new Error('Usage: node dist/runner.js PATH_TO_PRIVATE_CONFIG');
  const config: RunnerConfig = JSON.parse(readFileSync(resolve(path), 'utf8'));
  const controller = new AbortController();
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => controller.abort());
  void runRunner(config, controller.signal).catch(error => { console.error(error.message); process.exitCode = 1; });
}
