#!/usr/bin/env node
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { proveRunningProxy, loadAuthToken, openPrivateLog } from './proxy-auth.mjs';

const PROXY_PORT = parseInt(process.env.CDP_PROXY_PORT || '9400');
const AUTH_TOKEN = loadAuthToken({ create: true });
const PROXY_SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'cdp-proxy.mjs');

const major = parseInt(process.versions.node.split('.')[0]);
console.log(`node: ${major >= 22 ? 'ok' : 'warn'} (v${process.versions.node})`);

function probePort(port) {
  return new Promise(resolve => {
    const sock = net.createConnection(port, '127.0.0.1');
    const timer = setTimeout(() => { sock.destroy(); resolve(false); }, 1000);
    sock.once('connect', () => { clearTimeout(timer); sock.destroy(); resolve(true); });
    sock.once('error', () => { clearTimeout(timer); resolve(false); });
  });
}

async function findChromePort() {
  if (process.env.CDP_CHROME_PORT) {
    const port = Number(process.env.CDP_CHROME_PORT);
    return Number.isInteger(port) && port > 0 && port < 65536 && await probePort(port) ? port : null;
  }
  const home = os.homedir();
  const paths = [];
  const plat = os.platform();
  if (plat === 'darwin') {
    paths.push(
      path.join(home, 'Library/Application Support/Google/Chrome/DevToolsActivePort'),
      path.join(home, 'Library/Application Support/Google/Chrome Canary/DevToolsActivePort'),
      path.join(home, 'Library/Application Support/Chromium/DevToolsActivePort'),
    );
  } else if (plat === 'linux') {
    paths.push(
      path.join(home, '.config/google-chrome/DevToolsActivePort'),
      path.join(home, '.config/chromium/DevToolsActivePort'),
    );
  } else if (plat === 'win32') {
    const ld = process.env.LOCALAPPDATA || '';
    paths.push(
      path.join(ld, 'Google/Chrome/User Data/DevToolsActivePort'),
      path.join(ld, 'Chromium/User Data/DevToolsActivePort'),
    );
  }
  for (const p of paths) {
    try {
      const lines = fs.readFileSync(p, 'utf-8').trim().split('\n');
      const port = parseInt(lines[0]);
      if (port > 0 && port < 65536 && await probePort(port)) return port;
    } catch {}
  }
  for (const port of [9222, 9229, 9333]) {
    if (await probePort(port)) return port;
  }
  return null;
}

async function proxyState() {
  if (!await probePort(PROXY_PORT)) return { kind: 'absent' };
  if (!await proveRunningProxy(PROXY_PORT, AUTH_TOKEN)) return { kind: 'unverified' };

  try {
    const resp = await fetch(`http://127.0.0.1:${PROXY_PORT}/targets`, {
      headers: { 'X-CDP-Proxy-Token': AUTH_TOKEN },
      redirect: 'error',
      signal: AbortSignal.timeout(2000),
    });
    if (resp.headers.get('x-cdp-proxy-auth') !== 'required') return { kind: 'incompatible' };
    if (!resp.ok) return { kind: 'error' };
    const data = await resp.json();
    if (data.ok && Array.isArray(data.targets)) return { kind: 'ready', count: data.targets.length };
    return { kind: 'error' };
  } catch {
    return { kind: 'error' };
  }
}

function stopIfExistingProxyFailed(state) {
  if (state.kind === 'unverified') {
    console.error('proxy: port is occupied by an unverified service; inspect it before retrying');
    process.exit(1);
  }
  if (state.kind === 'incompatible') {
    console.error('proxy: an existing server does not require this token; stop it before using this candidate');
    process.exit(1);
  }
  if (state.kind === 'error') {
    console.error('proxy: an existing authenticated server rejected the request or failed');
    process.exit(1);
  }
}

async function main() {
  const chromePort = await findChromePort();
  if (!chromePort) {
    console.log('chrome: not connected');
    console.log('  Launch Chrome with: open -a "Google Chrome" --args --remote-debugging-port=9222');
    console.log('  Or enable at: chrome://inspect/#remote-debugging');
    process.exit(1);
  }
  console.log(`chrome: ok (port ${chromePort})`);

  const existing = await proxyState();
  stopIfExistingProxyFailed(existing);
  if (existing.kind === 'ready') {
    console.log(`proxy: ready (${existing.count} tabs visible)`);
    return;
  }

  console.log('proxy: starting...');
  const { filename: logFile, fd: logFd } = openPrivateLog();
  const child = spawn(process.execPath, [PROXY_SCRIPT], {
    detached: true,
    stdio: ['ignore', logFd, logFd],
  });
  child.unref();
  fs.closeSync(logFd);

  for (let i = 0; i < 15; i++) {
    await new Promise(r => setTimeout(r, 1000));
    const state = await proxyState();
    stopIfExistingProxyFailed(state);
    if (state.kind === 'ready') {
      console.log(`proxy: ready (${state.count} tabs visible)`);
      return;
    }
    if (i === 0) console.log('  If Chrome shows a permission dialog, click Allow...');
  }

  console.log(`proxy: timeout. Check log: ${logFile}`);
  process.exit(1);
}

await main();
