'use strict';
/**
 * The main-process actions the engine page may call, and the sender check that gates them.
 *
 * Every handler here is reachable only from this app's own window, on its top frame, at the
 * engine's current origin. No handler returns the owner session cookie or the pairing code.
 */
const { dialog } = require('electron');
const { isAllowedNavigation } = require('./origin.js');

/**
 * @param {object} opts
 * @param {() => object|null} opts.getWindow – this app's window, or null
 * @param {() => string|null} opts.getOrigin – the origin the engine currently owns
 * @param {() => string|null} opts.getCsrfToken – the token the preload is about to read
 * @param {() => Promise<string|null>} opts.pairOwnerSession – mint and exchange a new session
 */
function createIpcModule({ getWindow, getOrigin, getCsrfToken, pairOwnerSession }) {
  /** Whether an IPC event came from this app's own window at the engine's origin. */
  function isTeamSender(event, target = getWindow()) {
    return !!target && !target.isDestroyed() && event.sender === target.webContents
      && event.senderFrame === target.webContents.mainFrame && isAllowedNavigation(event.senderFrame.url, getOrigin());
  }

  /** Renew without navigating away from the owner's current form or project. */
  async function reconnectOwnerSession(event) {
    const currentWindow = getWindow();
    if (!currentWindow || !isTeamSender(event, currentWindow)) throw new Error('Reconnection is available only in the active app window.');
    const token = await pairOwnerSession();
    return getWindow() === currentWindow && isTeamSender(event, currentWindow) ? token : null;
  }

  /**
   * The native Windows folder dialog. It hands the UI the selected Windows path unchanged: the
   * daemon accepts native paths at its team boundary, so nothing converts `D:\code\app`.
   */
  async function pickFolder(event) {
    const currentWindow = getWindow();
    if (!currentWindow || !isTeamSender(event, currentWindow)) {
      throw new Error('Folder selection is available only in the active app window.');
    }
    const result = await dialog.showOpenDialog(currentWindow, { properties: ['openDirectory', 'createDirectory'] });
    if (result.canceled || !result.filePaths[0]) return null;
    return result.filePaths[0];
  }

  /**
   * Register the handlers. `reconnectEngine` and `getState` come from the caller so that the
   * lifecycle and the status projection stay in their own modules.
   */
  function register(ipcMain, { reconnectEngine, getState, getEngineStatus }) {
    ipcMain.handle('desktop:get-state', () => getState());
    ipcMain.handle('desktop:engine-status', () => getEngineStatus());
    ipcMain.handle('desktop:pick-folder', pickFolder);
    ipcMain.handle('desktop:reconnect', reconnectOwnerSession);
    ipcMain.on('desktop:csrf-token', (event) => {
      // Synchronous by design: the preload needs the value before the page's scripts run.
      // Any sender other than our own window gets nothing.
      event.returnValue = isTeamSender(event) ? getCsrfToken() : null;
    });
    ipcMain.handle('desktop:reconnect-engine', () => reconnectEngine());
  }

  return { isTeamSender, register };
}

module.exports = { createIpcModule };