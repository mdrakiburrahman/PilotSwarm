import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import path from 'node:path';
import { access, mkdir, open, readFile, rm } from 'node:fs/promises';
import { profilePath, decide, DEVICE_URL } from '../src/policy.mjs';
import { NodeProcesses, sleep } from '../src/process.mjs';
import { browserCommand, snapshot } from '../src/browser.mjs';

test('real controlled local DOM fixture: device input, exact consent, manual challenges, no user authentication', async t => {
  let chromium;
  try { ({ chromium } = await import('@playwright/test')); }
  catch { t.skip('Playwright dependency not restored; controlled browser fixture unavailable.'); return; }
  const executable = process.platform === 'win32'
    ? path.join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Microsoft', 'Edge', 'Application', 'msedge.exe')
    : chromium.executablePath();
  try { await access(executable); }
  catch { t.skip('Installed Edge/Chromium unavailable; no browser installation performed.'); return; }
  if (process.platform === 'linux' && process.getuid?.() === 0) {
    t.skip('Browser fixture needs a non-root user; sandbox is not disabled.'); return;
  }
  const directory = path.join(path.dirname(profilePath(process.cwd())), 'controlled-fixture-profile');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const lockFile = path.join(directory, 'pilotswarm-fixture.lock');
  const lock = await open(lockFile, 'wx', 0o600);
  const server = createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.end('<!doctype html><title>PilotSwarm controlled fixture</title><main id="fixture"></main>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const activePort = path.join(directory, 'DevToolsActivePort');
  await rm(activePort, { force: true });
  const processes = new NodeProcesses();
  let launchOutput = '';
  let launchExit;
  const running = process.platform === 'win32' ? processes.start(browserCommand(executable, [
      `--user-data-dir=${directory}`, '--headless=new', '--remote-debugging-port=0',
      '--remote-debugging-address=127.0.0.1', '--no-first-run', '--disable-extensions',
      '--disable-background-networking', '--no-service-autorun',
      '--edge-skip-compat-layer-relaunch', '--enable-automation', 'about:blank',
    ]), chunk => { launchOutput = (launchOutput + chunk).slice(-8192); }) : undefined;
  void running?.completion.then(code => { launchExit = code; });
  let browser;
  let context;
  let stage = 'browser readiness';
  try {
    if (process.platform === 'linux') {
      // This empty local-only fixture uses the same headless launcher as the
      // container doctor, including its crashpad launch defaults. Container
      // user namespaces prohibit Chromium's sandbox; this setting is never
      // used by the real authentication adapter.
      context = await chromium.launchPersistentContext(directory, {
        headless: true, chromiumSandbox: false, timeout: 15000,
        args: ['--disable-extensions', '--disable-background-networking'],
      });
    } else {
      let endpoint = '';
      const deadline = Date.now() + 15000;
      while (!endpoint && Date.now() < deadline) {
        if (launchExit !== undefined) break;
        const content = await readFile(activePort, 'utf8').catch(() => '');
        const [debugPort, socket] = content.trim().split(/\r?\n/);
        if (/^\d+$/.test(debugPort ?? '') && /^\/devtools\/browser\/[a-zA-Z0-9-]+$/.test(socket ?? '')) {
          endpoint = `ws://127.0.0.1:${debugPort}${socket}`;
        } else await sleep(100);
      }
      assert.ok(endpoint, `Controlled fixture browser must become responsive. ${JSON.stringify({
        exit: launchExit,
        sandbox: /sandbox|namespace|Operation not permitted|zygote/i.test(launchOutput),
        crashpad: /crashpad/i.test(launchOutput),
        display: /X server|DISPLAY|platform.*initializ/i.test(launchOutput),
        missingLibrary: /shared librar|cannot open shared object/i.test(launchOutput),
        profileBusy: /Singleton|profile.*use|lock/i.test(launchOutput),
      })}`);
      stage = 'CDP connection';
      browser = await chromium.connectOverCDP(endpoint, { timeout: 10000 });
      context = browser.contexts()[0];
    }
    context.setDefaultTimeout(3000);
    context.setDefaultNavigationTimeout(10000);
    const page = context.pages()[0] ?? await context.newPage();
    let unsafeRequest = false;
    await context.route('**/*', async route => {
      if (new URL(route.request().url()).origin !== `http://127.0.0.1:${port}`) {
        unsafeRequest = true;
        await route.abort();
      } else await route.continue();
    });
    await page.goto(`http://127.0.0.1:${port}`);
    stage = 'DOM assertions';
    await page.locator('#fixture').evaluate(element => {
      element.innerHTML = '<input name="user_code"><button>Continue</button><button>Authorize Other App</button>';
    });
    const state = { entered: false, submitted: false, authorized: false };
    const fixtureSnapshot = async () => ({ ...await snapshot(page), url: DEVICE_URL });
    assert.equal(decide(await fixtureSnapshot(), state), 'code');
    await page.locator('input[name="user_code"]').fill('ABCD-1234');
    state.entered = true;
    assert.equal(await page.locator('input[name="user_code"]').inputValue(), 'ABCD-1234');
    assert.equal(decide(await fixtureSnapshot(), state), 'continue');
    assert.equal((await snapshot(page)).authorizeButtons, 0);
    for (const html of [
      '<input name="login" autocomplete="username">', '<input type="password">',
      '<input autocomplete="one-time-code">', '<p>Sign in with a passkey</p>',
      '<p>Verify your identity</p>', '<p>Two-factor authentication</p>',
    ]) {
      await page.locator('#fixture').evaluate((element, value) => { element.innerHTML = value; }, html);
      const challenge = await fixtureSnapshot();
      assert.throws(() => decide(challenge, state), { code: 'MANUAL_REQUIRED' });
      assert.equal((await snapshot(page)).challenge, true);
    }
    await page.locator('#fixture').evaluate(element => { element.innerHTML = '<button>Authorize GitHub CLI</button>'; });
    assert.equal((await snapshot(page)).authorizeButtons, 1);
    assert.equal(decide({ ...await snapshot(page), url: 'https://github.com/login/device/code' },
      { entered: true, submitted: true, authorized: false }), 'authorize');
    assert.equal(unsafeRequest, false, 'Fixture must not visit GitHub or an identity provider.');
  } catch (error) {
    console.error(`Controlled fixture failed during ${stage}; error type ${error?.constructor?.name}.`);
    throw error;
  } finally {
    try {
      if (browser) await Promise.race([browser.close(), sleep(2000)]);
      else if (context) await context.close();
    }
    finally {
      try { await running?.terminate(); }
      finally {
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
        await lock.close();
        await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      }
    }
  }
});
