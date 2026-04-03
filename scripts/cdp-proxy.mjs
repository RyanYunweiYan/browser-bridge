#!/usr/bin/env node
// CDP Proxy — HTTP server bridging Chrome DevTools Protocol
// Zero external dependencies, Node.js 24 native WebSocket

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { homedir } from 'node:os';

const PROXY_PORT = parseInt(process.env.CDP_PROXY_PORT || '9400', 10);
const SCREENSHOT_DIR = '/tmp/cdp-shots';
const CMD_TIMEOUT = 30_000;
const LOAD_TIMEOUT = 15_000;

// ─── CdpClient ──────────────────────────────────────────────────────────────

class CdpClient {
  constructor() {
    this.ws = null;
    this.nextId = 1;
    this.pending = new Map();
    this.sessions = new Map();      // targetId -> sessionId
    this.attachLocks = new Map();   // targetId -> Promise
    this.guardedSessions = new Set();
    this.chromePort = null;
    this.chromeWsPath = null;
    this.connectPromise = null;
    this.eventHandlers = new Map(); // method -> Set<fn>
  }

  // ── Port Discovery ──────────────────────────────────────────────────────

  async discoverPort() {
    const home = homedir();
    const platform = process.platform;

    const profileDirs = [];
    if (platform === 'darwin') {
      profileDirs.push(
        path.join(home, 'Library', 'Application Support', 'Google', 'Chrome'),
        path.join(home, 'Library', 'Application Support', 'Google', 'Chrome Canary'),
        path.join(home, 'Library', 'Application Support', 'Chromium'),
      );
    } else if (platform === 'linux') {
      profileDirs.push(
        path.join(home, '.config', 'google-chrome'),
        path.join(home, '.config', 'chromium'),
      );
    } else if (platform === 'win32') {
      const local = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
      profileDirs.push(
        path.join(local, 'Google', 'Chrome', 'User Data'),
        path.join(local, 'Chromium', 'User Data'),
      );
    }

    // Try DevToolsActivePort file in each profile dir
    for (const dir of profileDirs) {
      const filePath = path.join(dir, 'DevToolsActivePort');
      try {
        const content = fs.readFileSync(filePath, 'utf-8').trim();
        const lines = content.split('\n');
        const port = parseInt(lines[0], 10);
        const wsPath = lines[1] || null;
        if (port && await this.probePort(port)) {
          this.chromePort = port;
          this.chromeWsPath = wsPath;
          return;
        }
      } catch { /* file not found or unreadable */ }
    }

    // Fallback: scan well-known ports
    for (const port of [9222, 9229, 9333]) {
      if (await this.probePort(port)) {
        this.chromePort = port;
        this.chromeWsPath = null;
        return;
      }
    }

    throw new Error(
      'Cannot find Chrome DevTools port. Launch Chrome with:\n' +
      '  google-chrome --remote-debugging-port=9222\n' +
      '  or on macOS:\n' +
      '  /Applications/Google\\ Chrome.app/Contents/MacOS/Google\\ Chrome --remote-debugging-port=9222'
    );
  }

  probePort(port) {
    return new Promise((resolve) => {
      const sock = new net.Socket();
      sock.setTimeout(1000);
      sock.once('connect', () => { sock.destroy(); resolve(true); });
      sock.once('error', () => { sock.destroy(); resolve(false); });
      sock.once('timeout', () => { sock.destroy(); resolve(false); });
      sock.connect(port, '127.0.0.1');
    });
  }

  // ── WebSocket Connection ────────────────────────────────────────────────

  connect() {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return Promise.resolve();
    if (this.connectPromise) return this.connectPromise;

    this.connectPromise = (async () => {
      if (!this.chromePort) await this.discoverPort();

      const wsUrl = this.chromeWsPath
        ? `ws://127.0.0.1:${this.chromePort}${this.chromeWsPath}`
        : `ws://127.0.0.1:${this.chromePort}/devtools/browser`;

      return new Promise((resolve, reject) => {
        const ws = new WebSocket(wsUrl);

        ws.onopen = () => {
          this.ws = ws;
          resolve();
        };

        ws.onerror = (err) => {
          this.ws = null;
          this.chromePort = null;
          this.chromeWsPath = null;
          reject(new Error(`WebSocket error: ${err.message || 'connection failed'}`));
        };

        ws.onclose = () => {
          this.onDisconnect();
        };

        ws.onmessage = (event) => {
          this.onMessage(event.data);
        };
      });
    })().finally(() => {
      this.connectPromise = null;
    });

    return this.connectPromise;
  }

  // ── Disconnect Cleanup ──────────────────────────────────────────────────

  onDisconnect() {
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error('WebSocket disconnected'));
    }
    this.pending.clear();
    this.sessions.clear();
    this.attachLocks.clear();
    this.guardedSessions.clear();
    this.ws = null;
    this.chromePort = null;
    this.chromeWsPath = null;
  }

  // ── Message Handler ─────────────────────────────────────────────────────

  onMessage(raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    // Response to a command
    if (msg.id && this.pending.has(msg.id)) {
      const { resolve, reject, timer } = this.pending.get(msg.id);
      clearTimeout(timer);
      this.pending.delete(msg.id);
      if (msg.error) {
        reject(new Error(`CDP ${msg.error.code}: ${msg.error.message}`));
      } else {
        resolve(msg.result || {});
      }
      return;
    }

    // Target attached
    if (msg.method === 'Target.attachedToTarget' && msg.params) {
      const { sessionId, targetInfo } = msg.params;
      if (targetInfo?.targetId) {
        this.sessions.set(targetInfo.targetId, sessionId);
      }
    }

    // Port guard: intercept requests to Chrome's debug port
    if (msg.method === 'Fetch.requestPaused' && msg.params) {
      const sessionId = msg.sessionId; // top-level sessionId
      if (sessionId) {
        this.send('Fetch.failRequest', {
          requestId: msg.params.requestId,
          errorReason: 'ConnectionRefused',
        }, sessionId).catch(() => {});
      }
    }

    // Dispatch to event handlers
    if (msg.method && this.eventHandlers.has(msg.method)) {
      for (const fn of this.eventHandlers.get(msg.method)) {
        try { fn(msg); } catch { /* swallow handler errors */ }
      }
    }
  }

  // ── Send Command ────────────────────────────────────────────────────────

  async send(method, params = {}, sessionId) {
    await this.connect();
    const id = this.nextId++;
    const msg = { id, method, params };
    if (sessionId) msg.sessionId = sessionId;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP timeout: ${method} (${CMD_TIMEOUT}ms)`));
      }, CMD_TIMEOUT);

      this.pending.set(id, { resolve, reject, timer });
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        this.pending.delete(id);
        clearTimeout(timer);
        return reject(new Error('WebSocket not connected'));
      }
      this.ws.send(JSON.stringify(msg));
    });
  }

  // ── Session Management ──────────────────────────────────────────────────

  ensureSession(targetId) {
    if (this.sessions.has(targetId)) {
      return Promise.resolve(this.sessions.get(targetId));
    }
    if (this.attachLocks.has(targetId)) {
      return this.attachLocks.get(targetId);
    }

    const promise = (async () => {
      const { sessionId } = await this.send('Target.attachToTarget', {
        targetId,
        flatten: true,
      });
      this.sessions.set(targetId, sessionId);
      await this.enablePortGuard(sessionId);
      return sessionId;
    })().finally(() => {
      this.attachLocks.delete(targetId);
    });

    this.attachLocks.set(targetId, promise);
    return promise;
  }

  async enablePortGuard(sessionId) {
    if (this.guardedSessions.has(sessionId)) return;
    try {
      const patterns = [];
      if (this.chromePort) {
        patterns.push(
          { urlPattern: `*://127.0.0.1:${this.chromePort}/*`, requestStage: 'Request' },
          { urlPattern: `*://localhost:${this.chromePort}/*`, requestStage: 'Request' },
        );
      }
      if (patterns.length) {
        await this.send('Fetch.enable', { patterns }, sessionId);
        this.guardedSessions.add(sessionId);
      }
    } catch { /* silently ignore */ }
  }

  // ── Page Load Waiting ───────────────────────────────────────────────────

  waitForLoad(sessionId) {
    return new Promise((resolve) => {
      let settled = false;
      const done = (reason) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.off('Page.loadEventFired', handler);
        resolve(reason);
      };

      const handler = (msg) => {
        const sid = msg.sessionId;
        if (sid === sessionId) done('loaded');
      };

      // Register handler BEFORE enabling Page domain
      this.on('Page.loadEventFired', handler);

      const timer = setTimeout(() => done('timeout'), LOAD_TIMEOUT);

      this.send('Page.enable', {}, sessionId).catch(() => done('error'));
    });
  }

  // ── Targets ─────────────────────────────────────────────────────────────

  async getTargets() {
    const { targetInfos } = await this.send('Target.getTargets');
    return (targetInfos || []).filter((t) => t.type === 'page');
  }

  // ── Event Handler Management ────────────────────────────────────────────

  on(evt, fn) {
    if (!this.eventHandlers.has(evt)) this.eventHandlers.set(evt, new Set());
    this.eventHandlers.get(evt).add(fn);
  }

  off(evt, fn) {
    const set = this.eventHandlers.get(evt);
    if (set) {
      set.delete(fn);
      if (set.size === 0) this.eventHandlers.delete(evt);
    }
  }
}

// ─── HTTP Helpers ───────────────────────────────────────────────────────────

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString()));
    req.on('error', reject);
  });
}

function json(res, data, status = 200) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function ok(res, data = {}) {
  json(res, { ok: true, ...data });
}

function fail(res, error, status = 400) {
  json(res, { ok: false, error: String(error) }, status);
}

// ─── Routes ─────────────────────────────────────────────────────────────────

const cdp = new CdpClient();

const routes = {};

function route(method, path, handler) {
  routes[`${method} ${path}`] = handler;
}

// GET /health
route('GET', '/health', async (_req, res) => {
  const connected = cdp.ws && cdp.ws.readyState === WebSocket.OPEN;
  ok(res, { connected, chromePort: cdp.chromePort });
});

// GET /targets
route('GET', '/targets', async (_req, res) => {
  const pages = await cdp.getTargets();
  ok(res, {
    targets: pages.map((t) => ({ id: t.targetId, title: t.title, url: t.url })),
  });
});

// GET /new?url=...
route('GET', '/new', async (req, res) => {
  const params = new URL(req.url, 'http://localhost').searchParams;
  const url = params.get('url') || 'about:blank';
  const { targetId } = await cdp.send('Target.createTarget', { url, background: true });

  if (url !== 'about:blank') {
    try {
      const sessionId = await cdp.ensureSession(targetId);
      await cdp.waitForLoad(sessionId);
    } catch { /* non-fatal */ }
  }

  ok(res, { targetId, url });
});

// GET /close?target=...
route('GET', '/close', async (req, res) => {
  const params = new URL(req.url, 'http://localhost').searchParams;
  const target = params.get('target');
  if (!target) return fail(res, 'target parameter required');

  await cdp.send('Target.closeTarget', { targetId: target });
  cdp.sessions.delete(target);
  ok(res, { closed: target });
});

// GET /navigate?target=...&url=...
route('GET', '/navigate', async (req, res) => {
  const params = new URL(req.url, 'http://localhost').searchParams;
  const target = params.get('target');
  const url = params.get('url');
  if (!target) return fail(res, 'target parameter required');
  if (!url) return fail(res, 'url parameter required');

  const sessionId = await cdp.ensureSession(target);

  // Set up load waiter BEFORE navigating
  const loadPromise = cdp.waitForLoad(sessionId);
  await cdp.send('Page.navigate', { url }, sessionId);
  await loadPromise;

  // Get final URL
  const result = await cdp.send('Runtime.evaluate', {
    expression: 'location.href',
    returnByValue: true,
  }, sessionId);

  ok(res, { url: result.result?.value || url });
});

// GET /info?target=...
route('GET', '/info', async (req, res) => {
  const params = new URL(req.url, 'http://localhost').searchParams;
  const target = params.get('target');
  if (!target) return fail(res, 'target parameter required');

  const sessionId = await cdp.ensureSession(target);
  const result = await cdp.send('Runtime.evaluate', {
    expression: 'JSON.stringify({ title: document.title, url: location.href, readyState: document.readyState })',
    returnByValue: true,
  }, sessionId);

  const info = JSON.parse(result.result?.value || '{}');
  ok(res, info);
});

// POST /eval?target=...  body = JS expression
route('POST', '/eval', async (req, res) => {
  const params = new URL(req.url, 'http://localhost').searchParams;
  const target = params.get('target');
  if (!target) return fail(res, 'target parameter required');

  const expression = (await readBody(req)).trim();
  if (!expression) return fail(res, 'request body must contain a JS expression');

  const sessionId = await cdp.ensureSession(target);
  const result = await cdp.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  }, sessionId);

  if (result.exceptionDetails) {
    const errText = result.exceptionDetails.exception?.description
      || result.exceptionDetails.text
      || 'evaluation error';
    return fail(res, errText);
  }

  ok(res, { value: result.result?.value });
});

// POST /click?target=...  body = CSS selector
route('POST', '/click', async (req, res) => {
  const params = new URL(req.url, 'http://localhost').searchParams;
  const target = params.get('target');
  if (!target) return fail(res, 'target parameter required');

  const selector = (await readBody(req)).trim();
  if (!selector) return fail(res, 'request body must contain a CSS selector');

  const sessionId = await cdp.ensureSession(target);
  const result = await cdp.send('Runtime.evaluate', {
    expression: `(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return JSON.stringify({ found: false });
      el.scrollIntoView({ block: 'center', behavior: 'instant' });
      el.click();
      return JSON.stringify({ found: true, tag: el.tagName.toLowerCase(), text: (el.textContent || '').trim().slice(0, 100) });
    })()`,
    returnByValue: true,
    awaitPromise: true,
  }, sessionId);

  const data = JSON.parse(result.result?.value || '{"found":false}');
  if (!data.found) return fail(res, `Element not found: ${selector}`);
  ok(res, data);
});

// POST /type?target=...  body = JSON { selector, text }
route('POST', '/type', async (req, res) => {
  const params = new URL(req.url, 'http://localhost').searchParams;
  const target = params.get('target');
  if (!target) return fail(res, 'target parameter required');

  let body;
  try { body = JSON.parse(await readBody(req)); } catch {
    return fail(res, 'request body must be JSON { selector, text }');
  }
  const { selector, text } = body;
  if (!selector || text == null) return fail(res, 'selector and text required');

  const sessionId = await cdp.ensureSession(target);

  // Focus and clear the element
  const focusResult = await cdp.send('Runtime.evaluate', {
    expression: `(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return JSON.stringify({ found: false });
      el.focus();
      el.value = '';
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return JSON.stringify({ found: true });
    })()`,
    returnByValue: true,
    awaitPromise: true,
  }, sessionId);

  const focusData = JSON.parse(focusResult.result?.value || '{"found":false}');
  if (!focusData.found) return fail(res, `Element not found: ${selector}`);

  // Insert text via Input domain
  await cdp.send('Input.insertText', { text }, sessionId);

  ok(res, { typed: text, selector });
});

// POST /press?target=...  body = key name
route('POST', '/press', async (req, res) => {
  const params = new URL(req.url, 'http://localhost').searchParams;
  const target = params.get('target');
  if (!target) return fail(res, 'target parameter required');

  const key = (await readBody(req)).trim();
  if (!key) return fail(res, 'request body must contain a key name');

  const keyMap = {
    Enter:      { code: 'Enter',      keyCode: 13, key: 'Enter' },
    Tab:        { code: 'Tab',        keyCode: 9,  key: 'Tab' },
    Escape:     { code: 'Escape',     keyCode: 27, key: 'Escape' },
    Backspace:  { code: 'Backspace',  keyCode: 8,  key: 'Backspace' },
    ArrowDown:  { code: 'ArrowDown',  keyCode: 40, key: 'ArrowDown' },
    ArrowUp:    { code: 'ArrowUp',    keyCode: 38, key: 'ArrowUp' },
    ArrowLeft:  { code: 'ArrowLeft',  keyCode: 37, key: 'ArrowLeft' },
    ArrowRight: { code: 'ArrowRight', keyCode: 39, key: 'ArrowRight' },
    Space:      { code: 'Space',      keyCode: 32, key: ' ' },
  };

  const mapped = keyMap[key];
  if (!mapped) return fail(res, `Unknown key: ${key}. Supported: ${Object.keys(keyMap).join(', ')}`);

  const sessionId = await cdp.ensureSession(target);

  await cdp.send('Input.dispatchKeyEvent', {
    type: 'keyDown',
    key: mapped.key,
    code: mapped.code,
    windowsVirtualKeyCode: mapped.keyCode,
    nativeVirtualKeyCode: mapped.keyCode,
  }, sessionId);

  await cdp.send('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: mapped.key,
    code: mapped.code,
    windowsVirtualKeyCode: mapped.keyCode,
    nativeVirtualKeyCode: mapped.keyCode,
  }, sessionId);

  ok(res, { pressed: key });
});

// GET /screenshot?target=...
route('GET', '/screenshot', async (req, res) => {
  const params = new URL(req.url, 'http://localhost').searchParams;
  const target = params.get('target');
  if (!target) return fail(res, 'target parameter required');

  const sessionId = await cdp.ensureSession(target);
  const result = await cdp.send('Page.captureScreenshot', { format: 'png' }, sessionId);

  const filename = `shot-${Date.now()}.png`;
  const filepath = path.join(SCREENSHOT_DIR, filename);
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
  fs.writeFileSync(filepath, Buffer.from(result.data, 'base64'));

  ok(res, { path: filepath });
});

// GET /scroll?target=...&y=800&direction=down
route('GET', '/scroll', async (req, res) => {
  const params = new URL(req.url, 'http://localhost').searchParams;
  const target = params.get('target');
  if (!target) return fail(res, 'target parameter required');

  const y = parseInt(params.get('y') || '800', 10);
  const direction = params.get('direction') || 'down';

  const sessionId = await cdp.ensureSession(target);

  let scrollExpr;
  switch (direction) {
    case 'up':     scrollExpr = `window.scrollBy(0, -${y})`; break;
    case 'top':    scrollExpr = `window.scrollTo(0, 0)`; break;
    case 'bottom': scrollExpr = `window.scrollTo(0, document.body.scrollHeight)`; break;
    case 'down':
    default:       scrollExpr = `window.scrollBy(0, ${y})`; break;
  }

  await cdp.send('Runtime.evaluate', {
    expression: scrollExpr,
    returnByValue: true,
  }, sessionId);

  // Wait for lazy-loaded content
  await new Promise((r) => setTimeout(r, 600));

  ok(res, { direction, pixels: y });
});

// ─── Server ─────────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const key = `${req.method} ${url.pathname}`;

  const handler = routes[key];
  if (!handler) {
    return fail(res, `Not found: ${key}`, 404);
  }

  try {
    await handler(req, res);
  } catch (err) {
    fail(res, err.message, 500);
  }
});

async function main() {
  // Check for existing instance
  try {
    const resp = await fetch(`http://127.0.0.1:${PROXY_PORT}/health`);
    if (resp.ok) {
      console.error(`CDP Proxy already running on port ${PROXY_PORT}`);
      process.exit(1);
    }
  } catch { /* not running, good */ }

  // Ensure screenshot directory
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

  // Start server
  server.listen(PROXY_PORT, '127.0.0.1', () => {
    console.log(`CDP Proxy listening on http://127.0.0.1:${PROXY_PORT}`);
  });

  // Pre-connect to Chrome
  try {
    await cdp.connect();
    console.log(`Connected to Chrome on port ${cdp.chromePort}`);
  } catch (err) {
    console.warn(`Chrome not found yet: ${err.message}`);
    console.warn('Will retry on first request.');
  }
}

// ─── Graceful Shutdown ──────────────────────────────────────────────────────

function shutdown(signal) {
  console.log(`\n${signal} received, shutting down...`);
  server.close(() => {
    if (cdp.ws) cdp.ws.close();
    process.exit(0);
  });
  // Force exit after 3s
  setTimeout(() => process.exit(1), 3000);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
});
process.on('unhandledRejection', (err) => {
  console.error('Unhandled rejection:', err);
});

main();
