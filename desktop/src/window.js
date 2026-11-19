'use strict';
/**
 * The desktop window: creation, navigation policy, and the source-run diagnostics capture.
 *
 * The window may only ever show the daemon's current loopback origin, plus its own local
 * first-run page. Every other navigation is refused, and external links open in the user's
 * browser instead. The origin is not a constant — the daemon binds an OS-assigned port — so this
 * module asks the caller for it each time a navigation is decided.
 */
const { BrowserWindow, screen, shell } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { isAllowedNavigation } = require('./origin.js');

const BACKGROUND = '#faf8f5';

/** Built as a file URL so a checkout under `#` or `%` still loads the right page. */
const FIRST_RUN_URL = pathToFileURL(path.join(__dirname, 'first-run.html')).href;

/**
 * @param {object} opts
 * @param {(patch: object) => void} opts.publish – send a status patch to the window
 * @param {() => string|null} opts.getOrigin – the one origin the engine currently owns
 */
function createWindowModule({ publish, getOrigin }) {
  let window = null;

  function openExternal(rawUrl) {
    let parsed;
    try {
      parsed = new URL(rawUrl);
    } catch {
      return;
    }
    if (parsed.protocol === 'https:' || parsed.protocol === 'http:') void shell.openExternal(rawUrl);
  }

  /**
   * @param {object} opts
   * @param {(event: object) => void} opts.onClose – the close confirmation
   */
  function createWindow({ onClose }) {
    // The design targets 1440x940; a smaller screen gets the whole work area instead of a
    // window that hangs off the edge.
    const work = screen.getPrimaryDisplay().workAreaSize;
    window = new BrowserWindow({
      width: Math.min(1440, work.width),
      height: Math.min(940, work.height),
      minWidth: Math.min(960, work.width),
      minHeight: Math.min(640, work.height),
      backgroundColor: BACKGROUND,
      show: false,
      title: 'Loom',
      icon: path.join(__dirname, '..', 'build', 'icon.ico'),
      titleBarStyle: 'hidden',
      titleBarOverlay: { color: BACKGROUND, symbolColor: '#1c1b1a', height: 52 },
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
      },
    });

    window.once('ready-to-show', () => window.show());
    window.on('closed', () => { window = null; });
    window.on('close', onClose);

    const contents = window.webContents;
    contents.on('will-navigate', (event, url) => {
      if (isAllowedNavigation(url, getOrigin()) || url === FIRST_RUN_URL) return;
      event.preventDefault();
      openExternal(url);
    });
    contents.setWindowOpenHandler(({ url }) => {
      openExternal(url);
      return { action: 'deny' };
    });
    contents.on('will-attach-webview', event => event.preventDefault());
    contents.on('did-finish-load', () => publish({}));
    contents.on('did-fail-load', (_event, code, description) => {
      if (code === -3) return; // An aborted load is a navigation we replaced, not a failure.
      publish({ phase: 'connection-failed', message: `Page load failed: ${description}`, connected: false });
    });

    void window.loadURL(FIRST_RUN_URL);
    return window;
  }

  function getWindow() {
    return window;
  }

  function reload() {
    if (window && !window.isDestroyed()) window.webContents.reload();
  }

  /** Load one URL in the window. Rejects when Chromium refuses; the caller publishes why. */
  function load(url) {
    if (!window || window.isDestroyed()) return Promise.reject(new Error('The window is gone.'));
    return window.loadURL(url);
  }

  /** Whether the window currently shows something other than the first-run page. */
  function showsEnginePage() {
    return !!window && !window.isDestroyed() && window.webContents.getURL() !== FIRST_RUN_URL;
  }

  /**
   * A first-run diagnostic for a source run: capture this app's own window to a PNG and log the
   * text it rendered. It is off unless LOOM_DESKTOP_SCREENSHOT names a file, and it never
   * captures or reads anything but this app's own window.
   */
  async function captureIfRequested(suffix = '') {
    const target = process.env.LOOM_DESKTOP_SCREENSHOT;
    if (!target || !window || window.isDestroyed()) return;
    const file = suffix ? target.replace(/\.png$/i, `${suffix}.png`) : target;
    try {
      const image = await window.webContents.capturePage();
      fs.writeFileSync(file, image.toPNG());
      const url = window.webContents.getURL();
      const text = await window.webContents.executeJavaScript('document.body.innerText.replace(/\\s+/g, " ").slice(0, 400)');
      console.log(`[desktop] captured ${file} url=${url} text=${JSON.stringify(text)}`);
    } catch (error) {
      console.error(`[desktop] screenshot failed: ${error.message}`);
    }
  }

  return { createWindow, getWindow, reload, load, showsEnginePage, captureIfRequested, FIRST_RUN_URL };
}

module.exports = { createWindowModule, FIRST_RUN_URL };