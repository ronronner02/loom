import { createServer, request as proxyRequest, type IncomingMessage, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Store, digest, secret, terminal, type Job, type Question, type QuestionSpec, type RunnerQuestion } from './store.js';
import { waitForAnswer } from './ask4me.js';

export interface ServerConfig {
  dataDir: string; publicUrl: string; ownerKey: string; runnerKey: string;
  askUrl: string; askKey: string; notificationsConfigured: boolean;
}
class HttpError extends Error { constructor(readonly status: number, message: string) { super(message); } }
const equal = (a: string, b: string) => timingSafeEqual(Buffer.from(digest(a), 'hex'), Buffer.from(digest(b), 'hex'));
const bearer = (req: IncomingMessage) => req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : '';
function text(value: unknown, name: string, limit = 20_000): string {
  if (typeof value !== 'string' || !value.trim() || value.length > limit) throw new HttpError(400, `Invalid ${name}.`);
  return value;
}
async function body(req: IncomingMessage, limit = 128_000): Promise<Record<string, unknown>> {
  if (!req.headers['content-type']?.startsWith('application/json')) throw new HttpError(415, 'JSON content is required.');
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, 'Request is too large.');
    chunks.push(chunk);
  }
  try {
    const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error();
    return result;
  } catch { throw new HttpError(400, 'Invalid JSON.'); }
}
function json(res: ServerResponse, status: number, value: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
}
async function interactionResponse(upstream: IncomingMessage, res: ServerResponse, page: boolean) {
  // Native form POSTs need a non-null Origin; never include the capability URL in referrers.
  const headers = { ...upstream.headers, 'Cache-Control': 'no-store', 'Referrer-Policy': 'strict-origin' };
  const status = upstream.statusCode ?? 502;
  if (!page || status !== 200 || !upstream.headers['content-type']?.startsWith('text/html')) {
    res.writeHead(status, headers); upstream.pipe(res); return;
  }
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of upstream) {
    size += chunk.length;
    if (size > 128_000) throw new Error('Interaction page exceeded its size limit.');
    chunks.push(chunk);
  }
  const html = Buffer.concat(chunks).toString('utf8').replace('</head>',
    '<link rel="stylesheet" href="/control/interaction.css"><script src="/control/interaction.js" defer></script></head>');
  delete headers['transfer-encoding'];
  headers['content-length'] = String(Buffer.byteLength(html));
  res.writeHead(status, headers); res.end(html);
}
function publicJob(job: Job) { const { token_hash: _token, ...rest } = job; return rest; }
function runnerQuestion(q: Question): RunnerQuestion { return { id: q.id, status: q.status, answer: q.answer, error: q.error }; }
function questionSpec(value: unknown): QuestionSpec {
  if (!value || typeof value !== 'object') throw new HttpError(400, 'Invalid question.');
  const q = value as Record<string, unknown>;
  const detail = text(q.detail, 'question details');
  if (q.kind === 'approval') return { kind: 'approval', detail };
  if (q.kind !== 'input' || !Array.isArray(q.fields) || q.fields.length < 1 || q.fields.length > 5) throw new HttpError(400, 'Invalid question fields.');
  return { kind: 'input', detail, fields: q.fields.map(f => ({
    id: text(f?.id, 'field ID', 200), question: text(f?.question, 'question', 2000),
    ...(Array.isArray(f?.options) ? { options: f.options.slice(0, 10).map((v: unknown) => text(v, 'option', 500)) } : {}),
  })) };
}

export function createControlServer(config: ServerConfig) {
  const origin = new URL(config.publicUrl).origin;
  const secure = origin.startsWith('https:');
  if (!secure && !['localhost', '127.0.0.1', '[::1]'].includes(new URL(origin).hostname)) throw new Error('Public access requires HTTPS.');
  if ([config.ownerKey, config.runnerKey, config.askKey].some(k => k.length < 32) || new Set([config.ownerKey, config.runnerKey, config.askKey]).size !== 3) {
    throw new Error('Three distinct keys of at least 32 characters are required.');
  }
  if (new URL(config.askUrl).protocol !== 'http:') throw new Error('The notification backend must use the private HTTP network.');
  mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
  const store = new Store(join(config.dataDir, 'loom.db'));
  const sessions = new Map<string, number>();
  const watchers = new Map<string, AbortController>();
  let closing = false;
  function watch(question: Question) {
    if (watchers.has(question.id) || question.status !== 'pending' || closing) return;
    if (!config.notificationsConfigured) {
      store.answerQuestion(question.id, {}, 'Notification setup is incomplete. No approval was granted.'); return;
    }
    const controller = new AbortController(); watchers.set(question.id, controller);
    void waitForAnswer(question, { endpoint: config.askUrl, key: config.askKey, publicUrl: origin }, url => store.linkQuestion(question.id, url), controller.signal)
      .then(result => { if (!closing && !controller.signal.aborted) store.answerQuestion(question.id, result.answer, result.error); })
      .finally(() => watchers.delete(question.id));
  }
  const tick = setInterval(() => {
    store.expireClaims();
    for (const [id, controller] of watchers) if (store.question(id)?.status !== 'pending') controller.abort();
    for (const q of store.questions()) watch(q);
  }, 1000);
  tick.unref();
  function owner(req: IncomingMessage) {
    if (bearer(req) && equal(bearer(req), config.ownerKey)) return;
    const cookie = req.headers.cookie?.split(';').map(v => v.trim()).find(v => v.startsWith('loom_session='))?.slice(13);
    if (!cookie || (sessions.get(digest(cookie)) ?? 0) <= Date.now()) throw new HttpError(401, 'Sign in to continue.');
    if (!['GET', 'HEAD'].includes(req.method!) && req.headers.origin !== origin) throw new HttpError(403, 'Origin check failed.');
  }
  function runner(req: IncomingMessage) { if (!equal(bearer(req), config.runnerKey)) throw new HttpError(401, 'Runner authentication failed.'); }
  function jobAuth(req: IncomingMessage, id: string) {
    const job = store.job(id);
    if (!job?.token_hash || !equal(digest(bearer(req)), job.token_hash)) throw new HttpError(401, 'Job authentication failed.');
    return job;
  }
  const server = createServer((req, res) => {
    res.setHeader('Referrer-Policy', 'no-referrer'); res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    void route(req, res).catch((error: unknown) => {
      const known = error instanceof HttpError;
      if (!res.headersSent) json(res, known ? error.status : 500, { error: known ? error.message : 'The request could not be completed.' });
      else res.end();
      if (!known) console.error('Request failed.');
    });
  });
  async function route(req: IncomingMessage, res: ServerResponse) {
    const raw = req.url ?? '';
    if (!raw.startsWith('/') || raw.startsWith('//') || raw.includes('\\')) throw new HttpError(404, 'Not found.');
    const url = new URL(raw, origin);
    const path = url.pathname;
    const method = req.method;
    if (req.headers.origin && req.headers.origin !== origin) throw new HttpError(403, 'Origin check failed.');
    if (path === '/healthz' && method === 'GET') return json(res, 200, { ok: true });
    if (path.startsWith('/r/') || path.startsWith('/static/')) {
      if (method !== 'GET' && method !== 'POST') throw new HttpError(405, 'Method not allowed.');
      const target = new URL(config.askUrl);
      target.pathname = path; target.search = url.search;
      const headers: Record<string, string> = {};
      for (const key of ['content-type', 'accept', 'content-length']) if (typeof req.headers[key] === 'string') headers[key] = req.headers[key]!;
      const unavailable = () => { if (!res.headersSent) json(res, 502, { error: 'Interaction service is not available.' }); else res.end(); };
      const upstream = proxyRequest(target, { method, headers }, response => {
        void interactionResponse(response, res, method === 'GET' && /^\/r\/[^/]+\/?$/.test(path)).catch(unavailable);
      });
      upstream.on('error', unavailable);
      req.on('aborted', () => upstream.destroy()); req.pipe(upstream); return;
    }
    if (path === '/') { res.writeHead(302, { Location: '/control/' }); res.end(); return; }
    const assets: Record<string, [string, string]> = {
      '/control/': ['index.html', 'text/html'], '/control/app.js': ['app.js', 'text/javascript'], '/control/style.css': ['style.css', 'text/css'],
      '/control/interaction.css': ['interaction.css', 'text/css'], '/control/interaction.js': ['interaction.js', 'text/javascript'],
    };
    if (method === 'GET' && assets[path]) {
      const [file, mime] = assets[path];
      res.setHeader('Content-Security-Policy', "default-src 'self'; style-src 'self'; script-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
      res.writeHead(200, { 'Content-Type': `${mime}; charset=utf-8`, 'Cache-Control': 'no-store' });
      res.end(readFileSync(fileURLToPath(new URL(`../web/${file}`, import.meta.url)))); return;
    }
    if (path === '/control/api/login' && method === 'POST') {
      if (req.headers.origin !== origin) throw new HttpError(403, 'Origin check failed.');
      const data = await body(req);
      if (!equal(text(data.key, 'access key', 200), config.ownerKey)) throw new HttpError(401, 'Access key is incorrect.');
      for (const [key, expires] of sessions) if (expires < Date.now()) sessions.delete(key);
      if (sessions.size >= 20) sessions.delete(sessions.keys().next().value!);
      const token = secret(); sessions.set(digest(token), Date.now() + 7 * 86_400_000);
      res.setHeader('Set-Cookie', `loom_session=${token}; Path=/control; HttpOnly; SameSite=Strict; Max-Age=604800${secure ? '; Secure' : ''}`);
      return json(res, 200, { ok: true });
    }
    if (path.startsWith('/control/api/')) {
      owner(req);
      if (path === '/control/api/status' && method === 'GET') {
        const current = store.runner();
        return json(res, 200, { runner: current ? { ...current, online: Date.now() - current.seen < 30_000 } : null,
          notificationsConfigured: config.notificationsConfigured, jobs: store.jobs().map(publicJob), questions: store.questions() });
      }
      if (path === '/control/api/jobs' && method === 'POST') {
        const data = await body(req);
        const workspace = text(data.workspace, 'workspace', 80);
        if (!store.runner()?.workspaces.some(w => w.id === workspace)) throw new HttpError(400, 'Workspace is not registered.');
        const requestId = data.requestId === undefined ? undefined : text(data.requestId, 'submission ID', 40);
        if (requestId && !/^[a-f0-9-]{36}$/.test(requestId)) throw new HttpError(400, 'Invalid submission ID.');
        try { return json(res, 201, publicJob(store.create(text(data.title, 'title', 160), text(data.prompt, 'prompt'), workspace, requestId))); }
        catch (error) { if (error instanceof HttpError) throw error; throw new HttpError(409, (error as Error).message); }
      }
      const cancel = path.match(/^\/control\/api\/jobs\/([a-f0-9-]+)\/cancel$/);
      if (cancel && method === 'POST') { store.cancel(cancel[1]); return json(res, 200, { ok: true }); }
      if (path === '/control/api/logout' && method === 'POST') {
        const cookie = req.headers.cookie?.split(';').map(v => v.trim()).find(v => v.startsWith('loom_session='))?.slice(13);
        if (cookie) sessions.delete(digest(cookie));
        res.setHeader('Set-Cookie', `loom_session=; Path=/control; HttpOnly; SameSite=Strict; Max-Age=0${secure ? '; Secure' : ''}`);
        return json(res, 200, { ok: true });
      }
    }
    if (path.startsWith('/control/runner/')) {
      const jobRoute = path.match(/^\/control\/runner\/jobs\/([a-f0-9-]+)(?:\/(start|finish|questions))?$/);
      if (jobRoute) {
        const job = jobAuth(req, jobRoute[1]); const action = jobRoute[2];
        if (!action && method === 'GET') return json(res, 200, { status: job.status, questions: store.questions(job.id).map(runnerQuestion) });
        if (action === 'finish' && method === 'POST') {
          // The retained 64k output and 2k error can expand sixfold when JSON-escaped.
          const data = await body(req, 512_000);
          if (data.status !== 'succeeded' && data.status !== 'failed') throw new HttpError(400, 'Invalid completion status.');
          store.finish(job.id, data.status, typeof data.output === 'string' ? data.output : '', typeof data.error === 'string' ? data.error : '');
          return json(res, 200, { ok: true });
        }
        if (terminal(job.status)) throw new HttpError(409, 'Job has ended.');
        if (action === 'start' && method === 'POST') {
          if (!store.start(job.id)) throw new HttpError(409, 'Job is not awaiting dispatch acknowledgement.');
          return json(res, 200, { ok: true });
        }
        if (action === 'questions' && method === 'POST') {
          const data = await body(req); const spec = questionSpec(data.spec);
          const q = store.addQuestion(job.id, text(data.callback, 'callback ID', 200), spec); watch(q);
          return json(res, 200, runnerQuestion(store.question(q.id)!));
        }
      }
      runner(req);
      if (path === '/control/runner/register' && method === 'POST') {
        const data = await body(req);
        if (!Array.isArray(data.workspaces) || !data.workspaces.length || data.workspaces.length > 20) throw new HttpError(400, 'Invalid workspaces.');
        const workspaces = data.workspaces.map(w => ({ id: text(w.id, 'workspace ID', 80), label: text(w.label, 'workspace label', 120) }));
        try { store.register({ instance: text(data.instance, 'instance ID', 80), label: text(data.label, 'runner label', 120), workspaces, seen: Date.now() }); }
        catch (error) { throw new HttpError(409, (error as Error).message); }
        return json(res, 200, { ok: true });
      }
      if (path === '/control/runner/heartbeat' && method === 'POST') {
        const data = await body(req);
        try { store.heartbeat(text(data.instance, 'instance ID', 80)); }
        catch { throw new HttpError(409, 'Runner registration expired.'); }
        return json(res, 200, { status: typeof data.jobId === 'string' ? store.job(data.jobId)?.status ?? 'missing' : 'idle' });
      }
      if (path === '/control/runner/claim' && method === 'POST') {
        const data = await body(req); const instance = text(data.instance, 'instance ID', 80);
        if (store.runner()?.instance !== instance) throw new HttpError(409, 'Runner registration expired.');
        const claim = store.claim(instance);
        return json(res, 200, claim ? { job: publicJob(claim.job), token: claim.token } : null);
      }
    }
    throw new HttpError(404, 'Not found.');
  }
  async function close() {
    closing = true; clearInterval(tick);
    for (const controller of watchers.values()) controller.abort();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    store.close();
  }
  return { server, store, close };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const env = process.env;
  const app = createControlServer({ dataDir: env.LOOM_DATA_DIR ?? './state', publicUrl: env.LOOM_PUBLIC_URL!, ownerKey: env.LOOM_OWNER_KEY!,
    runnerKey: env.LOOM_RUNNER_KEY!, askUrl: env.LOOM_ASK_URL ?? 'http://loom-ask4me:8080', askKey: env.LOOM_ASK_KEY!,
    notificationsConfigured: env.LOOM_NOTIFICATIONS_CONFIGURED === 'true' });
  app.server.listen(Number(env.PORT ?? 3000), env.HOST ?? '127.0.0.1', () => console.log('Loom control service is listening.'));
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => { void app.close().then(() => process.exit(0)); });
}
