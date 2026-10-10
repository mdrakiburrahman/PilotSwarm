import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { mkdir, open, readFile, rm, access, realpath } from 'node:fs/promises';
import { AuthError, DEVICE_URL, allowedAuthUrl, decide, profilePath } from './policy.mjs';
import { NodeProcesses, sleep } from './process.mjs';

/** @typedef {import('./process.mjs').ProcessAdapter} ProcessAdapter */
/** @typedef {{run:(code:string,signal:AbortSignal)=>Promise<void>,close:()=>Promise<void>}} BrowserAdapter */
const CODE_INPUT = 'input[name="user_code"]';
const CHALLENGE_INPUT = 'input[type="password"], input[type="email"], input[name="login"], input[name="username"], input[autocomplete="username"], input[autocomplete="current-password"], input[autocomplete="new-password"], input[autocomplete="one-time-code"], input[name="otp"], input[name="app_otp"]';
const CHALLENGE_TEXT = /two-factor authentication|enter.*verification code|verify your identity|confirm your identity|passkey|security key|windows hello|check your authenticator|select an account|choose an account/i;
const SUCCESS_TEXT = /congratulations.*all set|device (?:is |has been )?(?:activated|authenticated)|successfully authorized|you may now close/i;

/** @param {string} executable @param {string[]} args @returns {import('./process.mjs').Command} */
export function browserCommand(executable, args) {
  if (process.platform !== 'win32') return { file: executable, args };
  return {
    file: 'pwsh.exe',
    args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-File',
      fileURLToPath(new URL('./windows-browser-tree.ps1', import.meta.url)),
      '-Executable', executable, '-ArgumentsJson', Buffer.from(JSON.stringify(args)).toString('base64')],
  };
}

/** @param {import('@playwright/test').Page} page */
export async function snapshot(page) {
  return {
    url: page.url(),
    challenge: await page.locator(CHALLENGE_INPUT).count() > 0
      || await page.getByText(CHALLENGE_TEXT).count() > 0,
    codeInputs: await page.locator(CODE_INPUT).count(),
    continueButtons: await page.getByRole('button', { name: 'Continue', exact: true }).count(),
    authorizeButtons: await page.getByRole('button', { name: 'Authorize GitHub CLI', exact: true }).count(),
    success: await page.getByText(SUCCESS_TEXT).count() > 0,
  };
}

/** Startup tabs can disappear or hang on close while Edge replaces them.
 * @param {import('@playwright/test').BrowserContext} context @param {()=>void} unexpectedPage */
export async function ownPage(context, unexpectedPage) {
  const page = await context.newPage();
  context.on('page', popup => {
    if (popup !== page) { unexpectedPage(); void popup.close().catch(() => {}); }
  });
  return page;
}

/** @param {string} repoRoot @param {ProcessAdapter} [processes]
 * @param {(value:{stage:string,safePath?:boolean,challenge?:boolean,codeInputs?:number,continueButtons?:number,authorizeButtons?:number,success?:boolean})=>void} [diagnostic] */
export function createBrowser(repoRoot, processes = new NodeProcesses(), diagnostic) {
  /** @type {import('@playwright/test').Browser | undefined} */
  let browser;
  /** @type {import('./process.mjs').Running | undefined} */
  let launched;
  /** @type {import('node:fs/promises').FileHandle | undefined} */
  let lock;
  let directory = '';
  let closing = false;
  /** @type {Promise<void> | undefined} */
  let cleanup;
  const close = () => {
    closing = true;
    cleanup ??= (async () => {
      // Terminate the exact launched tree even if CDP disconnect/close hangs.
      try {
        if (browser) await Promise.race([browser.close().catch(() => {}), sleep(2000)]);
      } finally {
        try { await launched?.terminate(); }
        finally {
          if (lock) { await lock.close(); await rm(path.join(directory, 'pilotswarm-auth.lock'), { force: true }); }
        }
      }
    })();
    return cleanup;
  };
  /** @type {BrowserAdapter} */
  const adapter = {
    close,
    run: async (code, signal) => {
      if (!/^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(code)) throw new AuthError('INVALID_CODE', 'Only a short-lived gh device code may be entered.');
      if (process.platform === 'linux' && process.getuid?.() === 0) throw new AuthError('BROWSER_USER', 'Run Chromium as the non-root development user; this tool never disables its sandbox.');
      const { chromium } = await import('@playwright/test');
      diagnostic?.({ stage: 'profile' });
      if (closing || signal.aborted) throw new AuthError('CANCELLED', 'Authentication cancelled.');
      directory = profilePath(repoRoot);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const actual = await realpath(directory);
      const expected = path.resolve(directory);
      if ((process.platform === 'win32' ? actual.toLowerCase() !== expected.toLowerCase() : actual !== expected)) {
        throw new AuthError('UNSAFE_PROFILE', 'The dedicated profile must not be a symlink or junction to another browser profile.');
      }
      try { lock = await open(path.join(directory, 'pilotswarm-auth.lock'), 'wx', 0o600); }
      catch { throw new AuthError('PROFILE_BUSY', 'Dedicated PilotSwarm profile is busy. Close the other auth flow; do not use a normal browser profile.'); }
      if (closing || signal.aborted) {
        await lock.close();
        lock = undefined;
        await rm(path.join(directory, 'pilotswarm-auth.lock'), { force: true });
        throw new AuthError('CANCELLED', 'Authentication cancelled.');
      }
      const activePort = path.join(directory, 'DevToolsActivePort');
      await rm(activePort, { force: true });
      const executable = process.platform === 'win32' ? await edgeExecutable() : chromium.executablePath();
      if (closing || signal.aborted) throw new AuthError('CANCELLED', 'Authentication cancelled.');
      launched = processes.start(browserCommand(executable, [
          `--user-data-dir=${directory}`, '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1',
          '--no-first-run', '--no-default-browser-check', '--disable-extensions',
          '--disable-background-networking', '--no-service-autorun',
          '--edge-skip-compat-layer-relaunch', '--enable-automation', 'about:blank',
        ]));
      diagnostic?.({ stage: 'browser-ready' });
      const deadline = Date.now() + 15000;
      let endpoint = '';
      while (!endpoint && Date.now() < deadline) {
        if (signal.aborted || closing) throw new AuthError('CANCELLED', 'Authentication cancelled.');
        const text = await readFile(activePort, 'utf8').catch(() => '');
        const [port, socket] = text.trim().split(/\r?\n/);
        if (/^\d+$/.test(port ?? '') && Number(port) > 0 && Number(port) < 65536
          && /^\/devtools\/browser\/[a-zA-Z0-9-]+$/.test(socket ?? '')) {
          endpoint = `ws://127.0.0.1:${port}${socket}`;
        } else await sleep(100);
      }
      if (!endpoint) throw new AuthError('BROWSER_START', 'Dedicated browser did not become ready. Install Edge/Chromium or use manual login.');
      const connection = await chromium.connectOverCDP(endpoint, { timeout: 10000 });
      diagnostic?.({ stage: 'browser-connected' });
      if (closing || signal.aborted) { await connection.close(); throw new AuthError('CANCELLED', 'Authentication cancelled.'); }
      browser = connection;
      const context = browser.contexts()[0];
      if (!context) throw new AuthError('BROWSER_START', 'Dedicated browser context was unavailable.');
      const browserCdp = await browser.newBrowserCDPSession();
      await browserCdp.send('Browser.setDownloadBehavior', { behavior: 'deny' });
      context.setDefaultTimeout(3000);
      context.setDefaultNavigationTimeout(10000);
      let blocked = false;
      await context.route('**/*', async route => {
        const request = route.request();
        const url = new URL(request.url());
        const document = request.isNavigationRequest();
        // No external identity provider, popup, download, telemetry or arbitrary resource origin.
        const allowed = document ? allowedAuthUrl(url.href)
          : ['https://github.com', 'https://github.githubassets.com', 'https://avatars.githubusercontent.com'].includes(url.origin);
        if (!allowed) { if (document) blocked = true; await route.abort(); }
        else await route.continue();
      });
      // Edge may replace or close its startup tab after CDP attaches. Own a new
      // page rather than navigating a transient launcher/restoration tab.
      const page = await ownPage(context, () => { blocked = true; });
      diagnostic?.({ stage: 'owned-page' });
      if (closing || signal.aborted) throw new AuthError('CANCELLED', 'Authentication cancelled.');
      const cdp = await context.newCDPSession(page);
      await cdp.send('Network.setBypassServiceWorker', { bypass: true });
      diagnostic?.({ stage: 'navigation' });
      page.on('download', download => { blocked = true; void download.cancel(); });
      try { await page.goto(DEVICE_URL); }
      catch (error) {
        if (blocked) throw new AuthError('MANUAL_REQUIRED', 'GitHub requested identity verification outside the device flow. Complete gh auth login manually.');
        throw error;
      }
      const state = { entered: false, submitted: false, authorized: false };
      while (!signal.aborted) {
        if (blocked) throw new AuthError('MANUAL_REQUIRED', 'Unexpected navigation, popup or download requires manual authentication.');
        const observed = await snapshot(page);
        diagnostic?.({
          safePath: allowedAuthUrl(observed.url), challenge: observed.challenge,
          stage: 'controls',
          codeInputs: observed.codeInputs, continueButtons: observed.continueButtons,
          authorizeButtons: observed.authorizeButtons, success: observed.success,
        });
        const action = decide(observed, state);
        if (action === 'code') {
          await page.locator(CODE_INPUT).fill(code);
          state.entered = true;
        } else if (action === 'continue') {
          await page.getByRole('button', { name: 'Continue', exact: true }).click();
          state.submitted = true;
        } else if (action === 'authorize') {
          await page.getByRole('button', { name: 'Authorize GitHub CLI', exact: true }).click();
          state.authorized = true;
        } else if (action === 'complete') return;
        await sleep(200);
      }
      throw new AuthError('CANCELLED', 'Authentication cancelled.');
    },
  };
  return adapter;
}

async function edgeExecutable() {
  const candidates = [
    path.join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  ];
  for (const file of candidates) { try { await access(file); return file; } catch {} }
  throw new AuthError('BROWSER_INSTALL', 'Microsoft Edge is required on Windows. Install it manually; this tool never changes the host browser installation.');
}

/** Explicit optional command; never invoked by verify or login. */
/** @param {(specifier:string)=>string} [resolve] */
export function browserInstallCommand(resolve = createRequire(import.meta.url).resolve) {
  const executable = path.join(path.dirname(resolve('playwright/package.json')), 'cli.js');
  return { file: process.execPath, args: [executable, 'install', 'chromium'] };
}

/** @param {string} executable @param {(file:string)=>Promise<unknown>} [check] */
export async function browserExecutableAvailable(executable, check = access) {
  try { await check(executable); return true; }
  catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') return false;
    throw error;
  }
}

/** @param {AbortSignal} [signal] */
export async function installBrowser(signal) {
  if (process.platform === 'win32') { await edgeExecutable(); return; }
  if (process.platform !== 'linux') throw new AuthError('INVALID_HOST', 'Only Windows Edge and Linux Chromium are supported.');
  const { chromium } = await import('@playwright/test');
  // Source images provision this exact executable. Do not ask an unprivileged
  // dev user to modify the shared image browser directory when it is ready.
  if (await browserExecutableAvailable(chromium.executablePath())) return;
  // Installation remains the standard Playwright CLI, without privileged system-dependency changes.
  const command = new NodeProcesses().start(browserInstallCommand());
  const cancel = () => { void command.terminate(); };
  signal?.addEventListener('abort', cancel, { once: true });
  if (signal?.aborted) cancel();
  const timer = setTimeout(() => { void command.terminate(); }, 180000);
  try {
    if (await command.completion !== 0) throw new AuthError('BROWSER_INSTALL', 'Chromium installation failed. Install Playwright prerequisites explicitly.');
    await access(chromium.executablePath());
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', cancel);
    await command.terminate();
  }
}
