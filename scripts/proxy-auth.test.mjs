import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { checkProxyRequest, createChallengeProof, verifyChallengeProof, loadAuthToken, openPrivateLog } from './proxy-auth.mjs';
import { proxyRequest } from './proxy-client.mjs';

const fixtureToken = 'fixture-only-' + 'A'.repeat(40);

test('access checks run before any browser command', () => {
  const req = (extra = {}) => ({ headers: { host: '127.0.0.1:9400', ...extra } });
  assert.equal(checkProxyRequest(req(), 9400, fixtureToken).status, 401);
  assert.equal(checkProxyRequest(req({ 'x-cdp-proxy-token': 'wrong' }), 9400, fixtureToken).status, 401);
  assert.equal(checkProxyRequest(req({ 'x-cdp-proxy-token': fixtureToken, origin: 'null' }), 9400, fixtureToken).status, 403);
  assert.equal(checkProxyRequest(req({ 'x-cdp-proxy-token': fixtureToken, host: 'localhost:9400' }), 9400, fixtureToken).status, 403);
  assert.equal(checkProxyRequest(req({ 'x-cdp-proxy-token': fixtureToken }), 9400, fixtureToken), null);
});

test('a proof is bound to both the one-time challenge and port', () => {
  const challenge = 'b'.repeat(64);
  const proof = createChallengeProof(fixtureToken, 9400, challenge);
  assert.ok(verifyChallengeProof(fixtureToken, 9400, challenge, proof));
  assert.ok(!verifyChallengeProof(fixtureToken, 9401, challenge, proof));
  assert.ok(!verifyChallengeProof(fixtureToken, 9400, 'c'.repeat(64), proof));
  assert.ok(!verifyChallengeProof(fixtureToken, 9400, challenge, 'bad'));
});

test('runtime credentials and logs stay private; unsafe files are refused', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'proxy-auth-fixture-'));
  const saved = { state: process.env.CDP_PROXY_STATE_DIR, token: process.env.CDP_PROXY_AUTH_TOKEN };
  delete process.env.CDP_PROXY_AUTH_TOKEN;
  process.env.CDP_PROXY_STATE_DIR = path.join(directory, 'state');
  try {
    const token = loadAuthToken({ create: true });
    const file = path.join(process.env.CDP_PROXY_STATE_DIR, 'proxy-token');
    assert.match(token, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(loadAuthToken(), token);
    assert.equal(fs.statSync(process.env.CDP_PROXY_STATE_DIR).mode & 0o777, 0o700);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    const log = openPrivateLog(); fs.closeSync(log.fd);
    assert.equal(fs.statSync(log.filename).mode & 0o777, 0o600);
    fs.chmodSync(file, 0o644); assert.throws(() => loadAuthToken(), /private regular file/);
    fs.chmodSync(file, 0o600);
    const safeCopy = path.join(directory, 'copy'); fs.renameSync(file, safeCopy); fs.symlinkSync(safeCopy, file);
    assert.throws(() => loadAuthToken());
  } finally {
    for (const [name, value] of [['CDP_PROXY_STATE_DIR', saved.state], ['CDP_PROXY_AUTH_TOKEN', saved.token]]) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('client never sends a credential or business request to an unverified service', async () => {
  const saved = { token: process.env.CDP_PROXY_AUTH_TOKEN, port: process.env.CDP_PROXY_PORT };
  let requests = 0;
  let leaked = false;
  const server = http.createServer((req, res) => {
    requests++;
    leaked ||= !!req.headers['x-cdp-proxy-token'];
    assert.equal(req.url, '/auth-challenge');
    res.setHeader('Content-Type', 'application/json'); res.end('{}');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  process.env.CDP_PROXY_AUTH_TOKEN = fixtureToken;
  process.env.CDP_PROXY_PORT = String(server.address().port);
  try {
    await assert.rejects(proxyRequest('/targets'), /could not be verified/);
    assert.equal(requests, 1); assert.equal(leaked, false);
    await assert.rejects(proxyRequest('https://example.invalid/'), /Only the configured local proxy/);
    await assert.rejects(proxyRequest('//example.invalid/'), /Only the configured local proxy/);
    assert.equal(requests, 1);
  } finally {
    await new Promise(resolve => server.close(resolve));
    for (const [name, value] of [['CDP_PROXY_AUTH_TOKEN', saved.token], ['CDP_PROXY_PORT', saved.port]]) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  }
});
