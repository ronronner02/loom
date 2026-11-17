'use strict';
/**
 * Load the desktop main-process modules into one `vm` context, so every `require('electron')`
 * in the graph answers with the test's mock and every sibling `require('./x.js')` shares it.
 *
 * The modules are plain CommonJS with no build step; running them in a context that carries the
 * mock is enough, and it keeps the tests free of an Electron binary.
 */
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = path.resolve(__dirname, '..', '..', 'src');

/**
 * @param {object} opts
 * @param {object} opts.electron – the Electron mock every module in the graph sees
 * @param {object} [opts.externals] – replaces bare or sibling `require` targets by specifier
 * @param {object} [opts.globals] – extra globals for the shared context (`process`, `fetch`, …)
 */
function desktopContext({ electron, externals = {}, globals = {} }) {
  const cache = new Map();
  const context = vm.createContext({
    console,
    URL,
    Buffer,
    setTimeout,
    clearTimeout,
    setImmediate,
    AbortSignal: { timeout: () => undefined },
    ...globals,
  });

  function loadFile(full, externals) {
    if (cache.has(full)) return cache.get(full).exports;
    const module = { exports: {} };
    cache.set(full, module);
    const dir = path.dirname(full);
    const source = fs.readFileSync(full, 'utf8');
    const run = vm.runInContext(`(function (module, exports, require, __dirname, __filename) {\n${source}\n})`, context);
    run(module, module.exports, name => resolve(name, dir, externals), dir, full);
    return module.exports;
  }

  function resolve(name, dir, externals) {
    if (name === 'electron') return electron;
    if (externals && externals[name]) return externals[name];
    if (name.startsWith('./') || name.startsWith('../')) return loadFile(path.resolve(dir, name), externals);
    return require(name);
  }

  /** Load a module from `desktop/src`. */
  function load(name) {
    return loadFile(path.resolve(SRC, name), externals);
  }

  /** Load `main.js` and report its context. */
  function loadMain() {
    load('main.js');
    return context;
  }

  return { context, load, loadMain };
}

module.exports = { desktopContext };