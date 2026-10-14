import path from 'node:path';
import os from 'node:os';

export class AuthError extends Error {
  /** @param {string} code @param {string} message */
  constructor(code, message) {
    super(message);
    this.name = 'AuthError';
    this.code = code;
  }
}

export const DEVICE_URL = 'https://github.com/login/device';
const AUTH_PATHS = new Set([
  '/login/device', '/login/device/code', '/login/device/success',
  '/login/oauth/authorize', '/login/oauth/authorize_device',
]);

/** Exact GitHub.com only: enterprise/SSO and identity challenges are manual.
 * @param {string} value */
export function allowedAuthUrl(value) {
  try {
    const url = new URL(value);
    return url.origin === 'https://github.com' && !url.username && !url.password
      && !url.hash && AUTH_PATHS.has(url.pathname);
  } catch {
    return false;
  }
}

export class DeviceCodeParser {
  buffer = '';
  /** @type {{ userCode: string, verificationUrl: string } | undefined} */
  details;

  /** @param {string} chunk */
  push(chunk) {
    if (this.details) return this.details;
    this.buffer = (this.buffer + chunk).slice(-8192);
    const clean = this.buffer.replace(/\u001b\[[0-9;]*[a-zA-Z]/g, '');
    const code = clean.match(/(?:one-time|device|user)\s+code:\s*([A-Z0-9]{4}-[A-Z0-9]{4})(?![A-Z0-9-])/i)?.[1];
    const urls = clean.match(/https:\/\/[^\s"'<>]+/g) ?? [];
    if (!code || !urls.length) return undefined;
    if (urls.some(url => url !== DEVICE_URL)) {
      throw new AuthError('UNSAFE_URL', 'gh emitted an unexpected verification URL. Use manual authentication.');
    }
    this.details = { userCode: code.toUpperCase(), verificationUrl: DEVICE_URL };
    this.buffer = '';
    return this.details;
  }

  clear() {
    this.buffer = '';
    this.details = undefined;
  }
}

/**
 * @typedef {{url:string, challenge:boolean, codeInputs:number, continueButtons:number,
 * authorizeButtons:number, success:boolean}} Snapshot
 * @typedef {{entered:boolean, submitted:boolean, authorized:boolean}} FlowState
 */

/** Fail closed; no arbitrary "Next", account tiles, or generic consent clicks.
 * @param {Snapshot} snapshot @param {FlowState} state */
export function decide(snapshot, state) {
  if (snapshot.challenge) throw new AuthError('MANUAL_REQUIRED', 'Username, password, MFA, passkey, or identity verification requires manual authentication. No credentials were entered.');
  if (!allowedAuthUrl(snapshot.url)) throw new AuthError('MANUAL_REQUIRED', 'Navigation outside the exact GitHub device authorization paths requires manual authentication.');
  const pathname = new URL(snapshot.url).pathname;
  if (snapshot.success && state.submitted) return 'complete';
  if (pathname === '/login/device' && !state.entered && snapshot.codeInputs === 1) return 'code';
  if (pathname === '/login/device' && state.entered && !state.submitted && snapshot.continueButtons === 1) return 'continue';
  if (['/login/device/code', '/login/oauth/authorize', '/login/oauth/authorize_device'].includes(pathname)
    && state.submitted && !state.authorized && snapshot.authorizeButtons === 1) return 'authorize';
  if (snapshot.codeInputs > 1 || snapshot.continueButtons > 1 || snapshot.authorizeButtons > 1) {
    throw new AuthError('MANUAL_REQUIRED', 'Ambiguous authorization controls require manual authentication.');
  }
  return 'wait';
}

/** @param {string} repoRoot @param {NodeJS.Platform} [platform] @param {string} [home] */
export function profilePath(repoRoot, platform = process.platform, home = os.homedir()) {
  const api = platform === 'win32' ? path.win32 : path.posix;
  const directory = platform === 'win32'
    ? api.join(home, 'AppData', 'Local', 'PilotSwarm', 'auth-automation', 'edge-profile')
    : api.join(home, '.local', 'share', 'PilotSwarm', 'auth-automation', 'chromium-profile');
  const relative = api.relative(api.resolve(repoRoot), directory);
  if (!relative || (!relative.startsWith(`..${api.sep}`) && relative !== '..' && !api.isAbsolute(relative))) {
    throw new AuthError('UNSAFE_PROFILE', 'The dedicated PilotSwarm browser profile must be outside the repository.');
  }
  return directory;
}
