'use strict';
/**
 * First-run dependency rows.
 *
 * The daemon's own resolver (`domain/executable-resolver.ts`) decides what is installed and
 * where it is; this file only puts that answer into the owner's terms — a label, the resolved
 * path when found, and one install line when it is not. No second resolver exists.
 *
 * Order is the order the screen shows: the two tools every project needs, then the clients.
 */

const DEPENDENCIES = [
  { client: 'git', label: 'Git', missing: 'Install Git for Windows: https://git-scm.com/download/win.' },
  { client: 'gh', label: 'GitHub CLI', missing: 'Reinstall Loom to restore the bundled gh.exe, or install GitHub CLI: https://cli.github.com.' },
  { client: 'claude', label: 'Claude Code', missing: 'Install Claude Code: npm install -g @anthropic-ai/claude-code.' },
  { client: 'codex', label: 'Codex', missing: 'Install Codex: npm install -g @openai/codex.' },
  { client: 'gemini', label: 'Gemini CLI', missing: 'Install Gemini CLI: npm install -g @google/gemini-cli.' },
];

/**
 * Map resolver output to the rows the first-run page draws.
 *
 * A client the resolver did not report is missing, because the screen must never claim an
 * install it did not see. A client that runs through Node reports its JavaScript entry as the
 * path, because that is what the owner installed.
 */
function dependencyRows(resolutions) {
  const found = new Map((Array.isArray(resolutions) ? resolutions : []).map(result => [result.client, result]));
  return DEPENDENCIES.map(({ client, label, missing }) => {
    const resolution = found.get(client);
    return resolution && resolution.ok === true
      ? { client, label, ok: true, path: String(resolution.args?.[0] ?? resolution.path) }
      : { client, label, ok: false, reason: resolution && resolution.reason ? String(resolution.reason) : 'not-found', hint: missing };
  });
}

module.exports = { dependencyRows };