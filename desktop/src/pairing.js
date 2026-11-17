'use strict';
/**
 * Pairing the window with the engine it started.
 *
 * The window pairs the way a browser would: the daemon mints a one-time code over its private
 * parent channel, main exchanges the code for an owner session, and Chromium's own jar keeps the
 * HttpOnly cookie. The code and the cookie never reach a URL, a log line, or the settings file.
 */
const { session } = require('electron');
const { isDaemonHealth } = require('./origin.js');

const OWNER_COOKIE = 'multi_agent_owner';

/**
 * Mint a one-time code over the daemon's private parent channel and exchange it.
 *
 * Returns the anti-forgery token, or null when pairing failed.
 *
 * @param {object} engine – the running engine handle
 * @param {string} origin – the origin the engine currently owns
 */
async function pairOwnerSession(engine, origin) {
  if (!engine || !origin || typeof engine.mintPairing !== 'function') return null;
  let code;
  try { code = await engine.mintPairing(); } catch { return null; }
  if (typeof code !== 'string' || code.length === 0) return null;
  let response;
  try {
    response = await fetch(`${origin}/api/team-control/owner-session/exchange`, {
      method: 'POST',
      headers: { Origin: origin, 'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    return null;
  }
  if (!response.ok) return null;
  const setCookie = response.headers.get('set-cookie') || '';
  const match = new RegExp(`(?:^|,\\s*)${OWNER_COOKIE}=([A-Za-z0-9_-]+)`).exec(setCookie);
  let body;
  try { body = await response.json(); } catch { return null; }
  const antiForgeryToken = body && typeof body.antiForgeryToken === 'string' ? body.antiForgeryToken : null;
  if (!match || !antiForgeryToken) return null;
  try {
    await session.defaultSession.cookies.set({
      url: origin, name: OWNER_COOKIE, value: match[1], httpOnly: true, sameSite: 'strict', path: '/api',
    });
  } catch {
    return null;
  }
  return antiForgeryToken;
}

/**
 * Health-check the engine and mint a fresh owner session for it.
 *
 * Returns the origin and anti-forgery token, or null after publishing `connection-failed`: the
 * engine is not answering as the process this app forked, or it will not pair.
 *
 * @param {object} lifecycle – the engine lifecycle: `getEngine()`, `getOrigin()`, `getPid()`
 * @param {(patch: object) => void} publish – send a status patch to the window
 */
async function connect(lifecycle, publish) {
  const origin = lifecycle.getOrigin();
  const engine = lifecycle.getEngine();
  if (!origin) return null;
  publish({ phase: 'pairing', message: 'Connecting this window to the local engine…', connected: false });
  try {
    const response = await fetch(`${origin}/healthz`, { signal: AbortSignal.timeout(2_500) });
    if (!response.ok) throw new Error(`health check failed: ${response.status}`);
    if (!isDaemonHealth(await response.text(), engine && lifecycle.getPid())) throw new Error('not the expected daemon');
  } catch (error) {
    publish({ phase: 'connection-failed', message: `The local engine did not answer: ${error.message}`, connected: false });
    return null;
  }
  const token = await pairOwnerSession(engine, origin);
  if (!token) {
    publish({ phase: 'connection-failed', message: 'The desktop could not connect to the local engine.', connected: false });
    return null;
  }
  return { origin, token };
}

module.exports = { pairOwnerSession, connect };