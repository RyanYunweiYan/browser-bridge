#!/usr/bin/env node
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PROXY_PORT = parseInt(process.env.CDP_PROXY_PORT || '9400');
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

async function main() {
  const chromePort = await findChromePort();
  if (!chromePort) {
    console.log('chrome: not connected');
    console.log('  Launch Chrome with: open -a "Google Chrome" --args --remote-debugging-port=9222');
    console.log('  Or enable at: chrome://inspect/#remote-debugging');
    process.exit(1);
  }
  console.log(`chrome: ok (port ${chromePort})`);

  try {
    const resp = await fetch(`http://127.0.0.1:${PROXY_PORT}/targets`, { signal: AbortSignal.timeout(2000) });
    const data = await resp.json();
    if (data.ok) {
      console.log(`proxy: ready (${data.targets.length} tabs visible)`);
      return;
    }
  } catch {}

  console.log('proxy: starting...');
  const logFile = path.join(os.tmpdir(), 'cdp-proxy.log');
  const logFd = fs.openSync(logFile, 'a');
  const child = spawn(process.execPath, [PROXY_SCRIPT], {
    detached: true,
    stdio: ['ignore', logFd, logFd],
  });
  child.unref();
  fs.closeSync(logFd);

  for (let i = 0; i < 15; i++) {
    await new Promise(r => setTimeout(r, 1000));
    try {
      const resp = await fetch(`http://127.0.0.1:${PROXY_PORT}/targets`, { signal: AbortSignal.timeout(2000) });
      const data = await resp.json();
      if (data.ok) {
        console.log(`proxy: ready (${data.targets.length} tabs visible)`);
        return;
      }
    } catch {}
    if (i === 0) console.log('  If Chrome shows a permission dialog, click Allow...');
  }

  console.log(`proxy: timeout. Check log: ${logFile}`);
  process.exit(1);
}

await main();
