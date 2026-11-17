'use strict';
/**
 * The window's connection steps: load the engine's own page after pairing, show the first-run
 * page again, and open the engine in the user's browser with a fresh one-time code.
 */

const { dialog, shell, clipboard } = require('electron');
const pairing = require('./pairing.js');

/**
 * @param {object} opts
 * @param {object} opts.windowModule – `window.js`
 * @param {(patch: object) => void} opts.publish – send a status patch to the window
 * @param {(token: string|null) => void} opts.setCsrfToken – hold the token for the preload's hand-off
 * @param {(ms: number) => Promise<void>} opts.settleDelay – a source-run screenshot delay
 */
function createViewModule(opts) {
  const { windowModule, publish, setCsrfToken, settleDelay } = opts;

  /**
   * Pair this window with the engine and load the engine's own UI.
   *
   * Publishes the phase it reaches, and reports whether the window is now on the engine's page.
   * The engine and its origin come from the lifecycle the caller passes, so a stop that lands
   * mid-connect is visible to the next read.
   */
  async function openTeamView(lifecycle) {
    const paired = await pairing.connect(lifecycle, publish);
    if (!paired) return false;
    // A stop that landed while pairing was in flight owns the outcome; do not load its page.
    if (lifecycle.getOrigin() !== paired.origin || !lifecycle.getEngine()) return false;
    if (process.env.MULTI_AGENT_DESKTOP_SCREENSHOT) {
      // The first-run page is on screen now; let it paint before the capture.
      await settleDelay(2_000);
      await windowModule.captureIfRequested('-setup');
    }
    setCsrfToken(paired.token);
    try {
      await windowModule.load(`${paired.origin}/team`);
    } catch {
      setCsrfToken(null);
      publish({ phase: 'connection-failed', message: 'The engine UI did not load.', connected: false });
      return false;
    }
    // The preload consumed the token at document start; forget our copy.
    setCsrfToken(null);
    console.log(`[desktop] window loaded ${paired.origin}/team after pairing`);
    publish({ phase: 'ready', message: 'Connected to the local engine.', connected: true });
    if (process.env.MULTI_AGENT_DESKTOP_SCREENSHOT) {
      await settleDelay(3_000);
      await windowModule.captureIfRequested();
    }
    return true;
  }

  /** After an unexpected engine exit, replace the orphaned engine page with the reconnect page. */
  function showFirstRunPage() {
    if (windowModule.showsEnginePage()) void windowModule.load(windowModule.FIRST_RUN_URL);
  }

  /**
   * "Open in browser". Mint a fresh one-time code, show and copy it, then open the daemon's own
   * team page in the default browser. The code is never put in the URL: the owner pastes it into
   * the page, which POSTs it to the existing exchange route.
   */
  async function openInBrowser(lifecycle) {
    const engine = lifecycle.getEngine();
    const origin = lifecycle.getOrigin();
    const window = windowModule.getWindow();
    const parent = window && !window.isDestroyed() ? window : null;
    const show = options => (parent ? dialog.showMessageBox(parent, options) : dialog.showMessageBox(options));

    if (!engine || !origin) {
      await show({
        type: 'info', buttons: ['OK'], title: 'Open in browser',
        message: 'Connect the desktop to the local engine before opening it in a browser.',
      });
      return;
    }
    let code;
    try { code = await engine.mintPairing(); } catch { code = null; }
    if (!code) {
      await show({
        type: 'error', buttons: ['OK'], title: 'Open in browser',
        message: 'The local engine did not issue a pairing code. Try again.',
      });
      return;
    }
    try { clipboard.writeText(code); } catch { /* clipboard unavailable; the dialog still shows the code */ }
    const { response } = await show({
      type: 'info', buttons: ['Open browser', 'Cancel'], defaultId: 0, cancelId: 1,
      title: 'Open in browser',
      message: 'Paste this one-time code into the pairing page.',
      detail: `Code: ${code}\n\nIt is copied to your clipboard and expires in one minute.`,
    });
    if (response !== 0) return;
    // Only the origin is opened — the code stays in the clipboard and the dialog, never in the URL.
    void shell.openExternal(`${origin}/team`);
  }

  return { openTeamView, showFirstRunPage, openInBrowser };
}

module.exports = { createViewModule };