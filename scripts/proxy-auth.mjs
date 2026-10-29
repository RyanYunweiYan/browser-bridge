import fs from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const TOKEN_HEADER = 'x-cdp-proxy-token';

export function requireAuthToken(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{32,}$/.test(value)) {
    throw new Error('CDP_PROXY_AUTH_TOKEN must contain at least 32 base64url characters');
  }
  return value;
}

export function checkProxyRequest(req, port, token) {
  const peerError = checkProxyPeerRequest(req, port);
  if (peerError) return peerError;

  const supplied = req.headers[TOKEN_HEADER];
  if (typeof supplied !== 'string') {
    return { status: 401, error: 'Unauthorized' };
  }

  const expectedHash = createHash('sha256').update(token).digest();
  const suppliedHash = createHash('sha256').update(supplied).digest();
  if (!timingSafeEqual(expectedHash, suppliedHash)) {
    return { status: 401, error: 'Unauthorized' };
  }
  return null;
}

export function checkProxyPeerRequest(req, port) {
  if (req.headers.host !== `127.0.0.1:${port}` || req.headers.origin !== undefined) {
    return { status: 403, error: 'Forbidden' };
  }
  return null;
}

export function createChallengeProof(token, port, challenge) {
  return createHmac('sha256', token)
    .update('cdp-proxy-auth-v1\0')
    .update(String(port))
    .update('\0')
    .update(challenge)
    .digest('hex');
}

export function verifyChallengeProof(token, port, challenge, proof) {
  if (typeof proof !== 'string' || !/^[a-f0-9]{64}$/.test(proof)) return false;
  const expected = Buffer.from(createChallengeProof(token, port, challenge), 'hex');
  return timingSafeEqual(expected, Buffer.from(proof, 'hex'));
}

export async function proveRunningProxy(port, token, request = fetch) {
  const challenge = randomBytes(32).toString('hex');
  try {
    const response = await request(`http://127.0.0.1:${port}/auth-challenge`, {
      headers: { 'X-CDP-Proxy-Challenge': challenge },
      redirect: 'error',
      signal: AbortSignal.timeout(2000),
    });
    if (!response.ok || response.headers.get('x-cdp-proxy-auth') !== 'required') return false;
    const data = await response.json();
    return verifyChallengeProof(token, port, challenge, data.proof);
  } catch {
    return false;
  }
}

// Runtime state is outside the skill/repository; it must never enter a backup.
export function loadAuthToken({ create = false } = {}) {
  if (process.env.CDP_PROXY_AUTH_TOKEN !== undefined) {
    return requireAuthToken(process.env.CDP_PROXY_AUTH_TOKEN);
  }
  const directory = process.env.CDP_PROXY_STATE_DIR || path.join(homedir(), '.cache', 'browser-bridge');
  if (create) fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const state = fs.lstatSync(directory);
  if (!state.isDirectory() || state.isSymbolicLink() ||
      (process.getuid && (state.uid !== process.getuid() || (state.mode & 0o077)))) {
    throw new Error('Proxy state directory must be owned by this user and private (mode 0700)');
  }
  const tokenFile = path.join(directory, 'proxy-token');
  if (create) {
    let created;
    try {
      created = fs.openSync(tokenFile, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0), 0o600);
      fs.writeFileSync(created, randomBytes(32).toString('base64url'), 'utf8');
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    } finally {
      if (created !== undefined) fs.closeSync(created);
    }
  }
  const fd = fs.openSync(tokenFile, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 1024 ||
        (process.getuid && (stat.uid !== process.getuid() || (stat.mode & 0o077)))) {
      throw new Error('Proxy token file must be a private regular file owned by this user (mode 0600)');
    }
    return requireAuthToken(fs.readFileSync(fd, 'utf8').trim());
  } finally {
    fs.closeSync(fd);
  }
}

export function privateRuntimeDirectory() {
  const directory = process.env.CDP_PROXY_STATE_DIR || path.join(homedir(), '.cache', 'browser-bridge');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() ||
      (process.getuid && (stat.uid !== process.getuid() || (stat.mode & 0o077)))) {
    throw new Error('Proxy runtime directory must be private (mode 0700) and owned by this user');
  }
  return directory;
}

export function openPrivateLog() {
  const filename = path.join(privateRuntimeDirectory(), 'proxy.log');
  const fd = fs.openSync(filename, fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | (fs.constants.O_NOFOLLOW || 0), 0o600);
  const stat = fs.fstatSync(fd);
  if (!stat.isFile() || stat.nlink !== 1 ||
      (process.getuid && (stat.uid !== process.getuid() || (stat.mode & 0o077)))) {
    fs.closeSync(fd);
    throw new Error('Proxy log must be a private regular file owned by this user');
  }
  return { filename, fd };
}
