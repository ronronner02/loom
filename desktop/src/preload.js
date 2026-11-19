'use strict';
/**
 * The isolated bridge for pairing, engine status and native folder selection.
 * The shared page owns its title strip and footer; no Node or filesystem API is exposed.
 */
const { contextBridge, ipcRenderer } = require('electron');

// Hand-off first, before the page's own scripts mount anything.
try {
  const token = ipcRenderer.sendSync('desktop:csrf-token');
  if (typeof token === 'string' && token.length > 0) {
    window.sessionStorage.setItem('loom.desktop.csrf', token);
  }
} catch {
  // No token, or storage unavailable: the page falls back to its own pairing form.
}

document.addEventListener('DOMContentLoaded', () => {
  document.documentElement.dataset.desktop = 'true';
}, { once: true });

let current = null;
ipcRenderer.on('desktop:state', (_event, status) => {
  current = status;
  document.dispatchEvent(new CustomEvent('desktop-status', { detail: status }));
});

contextBridge.exposeInMainWorld('loomDesktop', {
  /** The last status the window sent, or null before the first one. */
  status: async () => current ?? ipcRenderer.invoke('desktop:get-state'),
  pickFolder: () => ipcRenderer.invoke('desktop:pick-folder'),
  reconnect: () => ipcRenderer.invoke('desktop:reconnect'),
  /** Subscribe to status changes; returns an unsubscribe function. */
  onStatus: callback => {
    const listener = (_event, status) => callback(status);
    ipcRenderer.on('desktop:state', listener);
    return () => ipcRenderer.removeListener('desktop:state', listener);
  },
  /** The first-run page's Reconnect action: start the engine, or stop and start it again. */
  reconnectEngine: () => ipcRenderer.invoke('desktop:reconnect-engine'),
});