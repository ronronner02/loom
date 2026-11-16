import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

export const digest = (value: string) => createHash('sha256').update(value).digest('hex');
export const secret = () => randomBytes(32).toString('base64url');
export const terminal = (status: string) => ['succeeded', 'failed', 'cancelled', 'interrupted'].includes(status);

export interface Job {
  id: string; title: string; prompt: string; workspace: string; status: string;
  created: number; updated: number; output: string; error: string; token_hash: string;
}
export interface Workspace { id: string; label: string }
export interface Runner { instance: string; label: string; workspaces: Workspace[]; seen: number }
export interface QuestionSpec {
  kind: 'approval' | 'input'; detail: string;
  fields?: { id: string; question: string; options?: string[] }[];
}
export interface Question {
  id: string; job_id: string; spec: string; request_id: string; url: string;
  status: string; answer: string; error: string; created: number;
}
export type RunnerQuestion = Pick<Question, 'id' | 'status' | 'answer' | 'error'>;

export class Store {
  readonly db: DatabaseSync;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, prompt TEXT NOT NULL, workspace TEXT NOT NULL,
        status TEXT NOT NULL, created INTEGER NOT NULL, updated INTEGER NOT NULL,
        output TEXT NOT NULL DEFAULT '', error TEXT NOT NULL DEFAULT '', token_hash TEXT NOT NULL DEFAULT '');
      CREATE TABLE IF NOT EXISTS questions (
        id TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES jobs(id), spec TEXT NOT NULL,
        request_id TEXT NOT NULL, url TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'pending',
        answer TEXT NOT NULL DEFAULT '', error TEXT NOT NULL DEFAULT '', created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
  }
  close() { this.db.close(); }
  job(id: string) { return this.db.prepare('SELECT * FROM jobs WHERE id=?').get(id) as unknown as Job | undefined; }
  jobs() { return this.db.prepare('SELECT * FROM jobs ORDER BY created DESC LIMIT 100').all() as unknown as Job[]; }
  runner(): Runner | null {
    const row = this.db.prepare("SELECT value FROM settings WHERE key='runner'").get();
    return row ? JSON.parse(row.value as string) : null;
  }
  register(runner: Runner) {
    const previous = this.runner();
    if (previous && previous.instance !== runner.instance) {
      if (Date.now() - previous.seen < 45_000) throw new Error('Another runner is online.');
      this.db.exec("UPDATE jobs SET status='interrupted', error='Local runner restarted; no automatic replay.' WHERE status IN ('claimed','running','waiting')");
      this.db.exec("UPDATE questions SET status='cancelled' WHERE status='pending'");
    }
    this.db.prepare("INSERT OR REPLACE INTO settings(key,value) VALUES('runner',?)").run(JSON.stringify(runner));
  }
  heartbeat(instance: string) {
    const runner = this.runner();
    if (!runner || runner.instance !== instance) throw new Error('Runner registration expired.');
    runner.seen = Date.now();
    this.db.prepare("UPDATE settings SET value=? WHERE key='runner'").run(JSON.stringify(runner));
  }
  create(title: string, prompt: string, workspace: string, id: string = randomUUID()) {
    if (!this.runner()?.workspaces.some(w => w.id === workspace)) throw new Error('Workspace is not registered.');
    const old = this.job(id);
    if (old) {
      if (old.title !== title || old.prompt !== prompt || old.workspace !== workspace) throw new Error('Submission ID was reused with different content.');
      return old;
    }
    const now = Date.now();
    this.db.prepare("INSERT INTO jobs(id,title,prompt,workspace,status,created,updated) VALUES(?,?,?,?,'queued',?,?)")
      .run(id, title, prompt, workspace, now, now);
    return this.job(id)!;
  }
  claim(instance: string): { job: Job; token: string } | null {
    this.heartbeat(instance);
    this.expireClaims();
    // One durable slot prevents concurrent polling connections from dispatching two jobs.
    if (this.db.prepare("SELECT id FROM jobs WHERE status IN ('claimed','running','waiting') LIMIT 1").get()) return null;
    const row = this.db.prepare("SELECT id FROM jobs WHERE status='queued' ORDER BY created,id LIMIT 1").get();
    if (!row) return null;
    const token = secret();
    this.db.prepare("UPDATE jobs SET status='claimed', token_hash=?, updated=? WHERE id=? AND status='queued'")
      .run(digest(token), Date.now(), row.id);
    return { job: this.job(row.id as string)!, token };
  }
  start(id: string) {
    this.expireClaims();
    return this.db.prepare("UPDATE jobs SET status='running',updated=? WHERE id=? AND status='claimed'").run(Date.now(), id).changes > 0;
  }
  expireClaims() {
    const now = Date.now();
    this.db.prepare("UPDATE jobs SET status='interrupted',error='Dispatch acknowledgement timed out; no automatic replay.',updated=? WHERE status='claimed' AND updated<?")
      .run(now, now - 60_000);
  }
  finish(id: string, status: 'succeeded' | 'failed', output: string, error: string) {
    const job = this.job(id);
    if (!job) throw new Error('Job not found.');
    if (terminal(job.status)) return;
    if (job.status === 'queued') throw new Error('Job has not been dispatched.');
    this.db.prepare('UPDATE jobs SET status=?,output=?,error=?,updated=? WHERE id=?')
      .run(status, output.slice(-64_000), error.slice(0, 2000), Date.now(), id);
    this.db.prepare("UPDATE questions SET status='cancelled' WHERE job_id=? AND status='pending'").run(id);
  }
  cancel(id: string) {
    const job = this.job(id);
    if (!job || terminal(job.status)) return;
    this.db.prepare("UPDATE jobs SET status='cancelled',updated=? WHERE id=?").run(Date.now(), id);
    this.db.prepare("UPDATE questions SET status='cancelled' WHERE job_id=? AND status='pending'").run(id);
  }
  questions(jobId?: string) {
    return (jobId
      ? this.db.prepare('SELECT * FROM questions WHERE job_id=? ORDER BY created').all(jobId)
      : this.db.prepare("SELECT * FROM questions WHERE status='pending' ORDER BY created").all()) as unknown as Question[];
  }
  question(id: string) { return this.db.prepare('SELECT * FROM questions WHERE id=?').get(id) as unknown as Question | undefined; }
  addQuestion(jobId: string, callbackId: string, spec: QuestionSpec) {
    const id = digest(`${jobId}:${callbackId}`).slice(0, 40);
    const old = this.question(id);
    if (old) {
      if (old.spec !== JSON.stringify(spec)) throw new Error('Question identity was reused with different content.');
      return old;
    }
    const job = this.job(jobId);
    if (!job || !['running', 'waiting'].includes(job.status)) throw new Error('Job is not running.');
    this.db.prepare('INSERT INTO questions(id,job_id,spec,request_id,created) VALUES(?,?,?,?,?)')
      .run(id, jobId, JSON.stringify(spec), `req_${id}`, Date.now());
    this.db.prepare("UPDATE jobs SET status='waiting',updated=? WHERE id=?").run(Date.now(), jobId);
    return this.question(id)!;
  }
  linkQuestion(id: string, url: string) { this.db.prepare("UPDATE questions SET url=? WHERE id=? AND status='pending'").run(url, id); }
  answerQuestion(id: string, answer: unknown, error = '') {
    const question = this.question(id);
    if (!question || question.status !== 'pending') return;
    this.db.prepare('UPDATE questions SET status=?,answer=?,error=? WHERE id=?')
      .run(error ? 'failed' : 'answered', JSON.stringify(answer), error.slice(0, 500), id);
    if (!this.questions(question.job_id).some(q => q.status === 'pending')) {
      this.db.prepare("UPDATE jobs SET status='running',updated=? WHERE id=? AND status='waiting'")
        .run(Date.now(), question.job_id);
    }
  }
}
