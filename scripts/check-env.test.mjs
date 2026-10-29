import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createChallengeProof } from './proxy-auth.mjs';

const script = fileURLToPath(new URL('./check-env.mjs', import.meta.url));
const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
const close = (server) => new Promise((resolve) => server.close(resolve));
function run(proxyPort, chromePort, credential) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script], {
      env: { PATH: process.env.PATH, CDP_PROXY_PORT: String(proxyPort), CDP_CHROME_PORT: String(chromePort), CDP_PROXY_AUTH_TOKEN: credential },
    });
    let out = '', err = '';
    child.stdout.on('data', (data) => { out += data; });
    child.stderr.on('data', (data) => { err += data; });
    child.on('error', reject);
    child.on('exit', (code) => resolve({ code, out, err }));
  });
}

test('waits for Chrome after proving an existing proxy identity', async () => {
  const credential = randomBytes(32).toString('base64url');
  const chrome = net.createServer((socket) => socket.end());
  const chromePort = await listen(chrome);
  let attempts = 0, proxyPort;
  const proxy = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('X-CDP-Proxy-Auth', 'required');
    if (req.url === '/auth-challenge') {
      assert.equal(req.headers['x-cdp-proxy-token'], undefined);
      res.end(JSON.stringify({ proof: createChallengeProof(credential, proxyPort, req.headers['x-cdp-proxy-challenge']) }));
    } else {
      assert.equal(req.url, '/targets');
      assert.equal(req.headers['x-cdp-proxy-token'], credential);
      attempts += 1;
      res.statusCode = attempts < 3 ? 503 : 200;
      res.end(JSON.stringify(attempts < 3 ? { ok: false, error: 'Chrome permission pending' } : { ok: true, targets: [] }));
    }
  });
  proxyPort = await listen(proxy);
  try {
    const result = await run(proxyPort, chromePort, credential);
    assert.equal(result.code, 0, result.err);
    assert.equal(attempts, 3);
    assert.match(result.out, /proxy: ready/);
    assert.ok(!(result.out + result.err).includes(credential));
  } finally { await close(proxy); await close(chrome); }
});

test('does not retry business requests to an unverified occupied port', async () => {
  const credential = randomBytes(32).toString('base64url');
  const chrome = net.createServer((socket) => socket.end());
  const chromePort = await listen(chrome);
  let businessCalls = 0, receivedCredential = false;
  const proxy = http.createServer((req, res) => {
    if (req.url !== '/auth-challenge') businessCalls += 1;
    receivedCredential ||= Boolean(req.headers['x-cdp-proxy-token']);
    res.setHeader('Content-Type', 'application/json');
    res.end('{}');
  });
  const proxyPort = await listen(proxy);
  try {
    const result = await run(proxyPort, chromePort, credential);
    assert.equal(result.code, 1);
    assert.equal(businessCalls, 0);
    assert.equal(receivedCredential, false);
    assert.match(result.err, /unverified service/);
  } finally { await close(proxy); await close(chrome); }
});
