#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { loadAuthToken, proveRunningProxy } from './proxy-auth.mjs';

export async function proxyRequest(route, options = {}) {
  const port = Number(process.env.CDP_PROXY_PORT || '9400');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid proxy port');
  const base = `http://127.0.0.1:${port}`;
  const url = new URL(route, base);
  if (url.origin !== base || url.username || url.password || url.hash) {
    throw new Error('Only the configured local proxy may receive authenticated requests');
  }
  const token = loadAuthToken();
  if (!await proveRunningProxy(port, token)) {
    throw new Error('Proxy identity could not be verified; no credential or browser command was sent');
  }
  return fetch(url, {
    ...options,
    headers: { ...options.headers, 'X-CDP-Proxy-Token': token },
    redirect: 'error',
    signal: options.signal || AbortSignal.timeout(45000),
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    // Small curl-compatible surface lets existing documented endpoint recipes stay readable.
    let route, method = 'GET', body;
    const headers = {};
    for (let i = 2; i < process.argv.length; i++) {
      const arg = process.argv[i];
      if (arg === '-s') continue;
      if (arg === '-X') method = process.argv[++i];
      else if (arg === '-d') body = process.argv[++i];
      else if (arg === '-H') {
        const header = process.argv[++i] || '';
        const separator = header.indexOf(':');
        if (separator < 1 || header.slice(0, separator).toLowerCase() !== 'content-type') {
          throw new Error('Only a Content-Type header may be provided; credentials are managed internally');
        }
        headers['Content-Type'] = header.slice(separator + 1).trim();
      } else if (arg.startsWith('-') || route) throw new Error('Unsupported argument');
      else route = arg;
    }
    if (!route) throw new Error('Usage: node proxy-client.mjs ROUTE [-X POST -d BODY]');
    const response = await proxyRequest(route, { method, body, headers });
    process.stdout.write(await response.text() + '\n');
    if (!response.ok) process.exitCode = 1;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
