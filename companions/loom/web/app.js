'use strict';
const $ = id => document.getElementById(id);
let signedIn = false, refreshing = false, submitting = false;
let submissionId = null, submissionText = '', submissionTarget = '';
const done = status => ['succeeded', 'failed', 'cancelled', 'interrupted'].includes(status);
const labels = { queued: 'Queued', claimed: 'Starting', running: 'Running', waiting: 'Needs reply', succeeded: 'Done', failed: 'Failed', cancelled: 'Cancelled', interrupted: 'Interrupted' };
function error(message) { $('error').textContent = message; $('error').hidden = !message; }
async function api(path, data) {
  const response = await fetch('/control/api/' + path, { method: data === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json' }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
  const result = await response.json();
  if (!response.ok) { if (response.status === 401) showLogin(); throw new Error(result.error || 'Request failed.'); }
  return result;
}
function showLogin() { signedIn = false; $('login').hidden = false; $('workspace').hidden = true; $('logout').hidden = true; }
function node(tag, text, className) { const el = document.createElement(tag); if (text !== undefined) el.textContent = text; if (className) el.className = className; return el; }
function render(state) {
  signedIn = true; $('login').hidden = true; $('workspace').hidden = false; $('logout').hidden = false;
  const runner = state.runner;
  $('connection').textContent = runner ? `${runner.label} · ${runner.online ? 'Connected' : 'Offline'}` : 'Waiting for your computer';
  $('connection').className = runner?.online ? 'online' : 'offline';
  $('notifications').textContent = state.notificationsConfigured ? 'Phone notifications ready' : 'Notification setup pending';
  $('notifications').className = state.notificationsConfigured ? '' : 'warning';
  const selected = $('target').value;
  $('target').replaceChildren(...(runner?.workspaces || []).map(w => { const option = node('option', w.label); option.value = w.id; return option; }));
  if ([...$('target').options].some(o => o.value === selected)) $('target').value = selected;
  $('submit').disabled = submitting || !$('target').value;
  $('queue-hint').textContent = runner?.online ? '' : 'Queued tasks wait until your computer is online.';
  $('questions').replaceChildren(); $('attention').hidden = !state.questions.length;
  for (const question of state.questions) {
    const spec = JSON.parse(question.spec); const card = node('article', undefined, 'card question');
    card.append(node('h3', spec.kind === 'approval' ? 'Operation approval' : 'A task needs your reply'));
    card.append(node('p', spec.detail));
    if (question.url) {
      const link = node('a', 'Review and respond', 'action');
      const target = new URL(question.url, location.origin);
      if (target.origin === location.origin && target.pathname.startsWith('/r/')) { link.href = target.href; link.rel = 'noreferrer'; card.append(link); }
    } else card.append(node('span', 'Preparing the interaction link…', 'muted'));
    $('questions').append(card);
  }
  $('count').textContent = String(state.jobs.length); $('jobs').replaceChildren();
  if (!state.jobs.length) $('jobs').append(node('p', 'No tasks yet.', 'muted'));
  for (const job of state.jobs) {
    const card = node('article', undefined, 'job'); const heading = node('div', undefined, 'job-heading');
    heading.append(node('h3', job.title), node('span', labels[job.status] || job.status, `badge ${job.status}`));
    card.append(heading, node('time', new Date(job.created).toLocaleString()));
    const details = node('details'); details.append(node('summary', 'Task details'), node('pre', job.prompt)); card.append(details);
    if (job.output) { const result = node('details'); result.open = true; result.append(node('summary', 'Result'), node('pre', job.output)); card.append(result); }
    if (job.error) card.append(node('p', job.error, 'danger'));
    if (!done(job.status)) {
      const cancel = node('button', 'Cancel task', 'quiet danger');
      cancel.onclick = async () => {
        if (!confirm('Cancel this task? Running local work will be stopped when the computer receives the cancellation.')) return;
        try { await api(`jobs/${job.id}/cancel`, {}); await refresh(); } catch (e) { error(e.message); }
      }; card.append(cancel);
    }
    $('jobs').append(card);
  }
}
async function refresh() {
  if (refreshing || document.hidden) return;
  refreshing = true;
  try { render(await api('status')); error(''); }
  catch (e) { if (signedIn) error('Connection interrupted. Your queued tasks are preserved.'); }
  finally { refreshing = false; }
}
$('login-form').onsubmit = async event => {
  event.preventDefault();
  try { await api('login', { key: $('key').value }); $('key').value = ''; await refresh(); }
  catch (e) { error(e.message); }
};
$('task-form').onsubmit = async event => {
  event.preventDefault(); if (submitting) return;
  const prompt = $('prompt').value.trim(); const workspace = $('target').value; if (!prompt || !workspace) return;
  if (!submissionId || submissionText !== prompt || submissionTarget !== workspace) { submissionId = crypto.randomUUID(); submissionText = prompt; submissionTarget = workspace; }
  submitting = true; $('submit').disabled = true;
  try {
    await api('jobs', { title: prompt.split('\n')[0].slice(0, 100), prompt, workspace, requestId: submissionId });
    $('prompt').value = ''; submissionId = null; await refresh();
  } catch (e) { error(e.message); }
  finally { submitting = false; $('submit').disabled = !$('target').value; }
};
$('logout').onclick = async () => { try { await api('logout', {}); showLogin(); } catch (e) { error(e.message); } };
document.addEventListener('visibilitychange', () => { if (!document.hidden) void refresh(); });
setInterval(() => { if (signedIn) void refresh(); }, 4000);
void refresh();
