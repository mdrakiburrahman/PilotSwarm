import assert from 'node:assert/strict';
import { test } from 'node:test';
import path from 'node:path';
import { readFile, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { browserCommand, ownPage } from '../src/browser.mjs';
import { allowedAuthUrl, AuthError, decide, DeviceCodeParser, DEVICE_URL, profilePath } from '../src/policy.mjs';
import { login } from '../src/auth.mjs';
import { ghCommand, exactName, transport } from '../src/target.mjs';
import { parseArgs } from '../src/cli.mjs';
import { NodeProcesses, sleep, status } from '../src/process.mjs';

function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}

function setup({ browserError, loginCode = 0, statusCode = 0, noCode = false, hang = false, cleanupError = false } = {}) {
  const done = deferred();
  const calls = [];
  const loginCommand = { file: 'fixture-gh', args: ['login'] };
  const statusCommand = { file: 'fixture-gh', args: ['status'] };
  const processes = {
    start(command, output) {
      calls.push(command.args[0]);
      if (command === statusCommand) return {
        completion: Promise.resolve(statusCode), write() {},
        async terminate() { calls.push('stop-status'); },
      };
      if (!noCode) queueMicrotask(() => {
        output('! First copy your one-time code: ABCD-');
        output('1234\nPress Enter to open https://github.com/login/device\n');
      });
      else if (!hang) queueMicrotask(() => done.resolve(loginCode));
      return {
        completion: done.promise,
        write(value) { assert.equal(value, '\n'); calls.push('enter'); },
        async terminate() { calls.push('stop-gh'); done.resolve(1); },
      };
    },
  };
  const browser = {
    async run(code, signal) {
      assert.equal(code, 'ABCD-1234');
      assert.ok(signal instanceof AbortSignal);
      calls.push('browser');
      if (browserError) throw browserError;
      if (!hang) done.resolve(loginCode);
      else await done.promise;
    },
    async close() {
      calls.push('stop-browser');
      if (cleanupError) throw new Error('fixture secret must never surface');
    },
  };
  return { options: { processes, browser, loginCommand, statusCommand, timeoutMs: 100 }, calls };
}

test('device parser accepts chunked gh output and does not expose retained output', () => {
  const parser = new DeviceCodeParser();
  assert.equal(parser.push('\u001b[33m! First copy your one-time code: ABCD-'), undefined);
  assert.deepEqual(parser.push('1234\u001b[0m\nPress Enter to open https://github.com/login/device\n'), {
    userCode: 'ABCD-1234', verificationUrl: DEVICE_URL,
  });
  assert.equal(parser.buffer, '');
  parser.clear();
  assert.equal(parser.details, undefined);
});

test('parser rejects lookalike, enterprise, insecure and unexpected verification URLs', () => {
  for (const url of ['https://github.com.evil.test/login/device', 'https://github.com/login/device?evil=1', 'https://example.test/login/device']) {
    assert.throws(() => new DeviceCodeParser().push(`one-time code: ABCD-1234\n${url}\n`), { code: 'UNSAFE_URL' });
  }
  assert.equal(new DeviceCodeParser().push('one-time code: ABCD-1234\nhttp://github.com/login/device\n'), undefined);
});

test('parser never accepts tokens or arbitrary code lengths', () => {
  for (const code of ['ghp_1234567890', 'ABCD-1234-ZZZZ', '123456', 'password']) {
    assert.equal(new DeviceCodeParser().push(`one-time code: ${code}\n${DEVICE_URL}\n`), undefined);
  }
});

test('exact URL policy rejects arbitrary origins, paths, ports and credentials', () => {
  assert.ok(allowedAuthUrl(DEVICE_URL));
  assert.ok(allowedAuthUrl('https://github.com/login/oauth/authorize_device?user_code=ABCD-1234'));
  for (const url of ['http://github.com/login/device', 'https://github.com:444/login/device', 'https://github.com.evil.test/login/device',
    'https://github.com/login', 'https://github.com/sessions/two-factor', 'https://user@github.com/login/device',
    'https://github.com/login/device#test', 'https://github.com/login/device/extra']) {
    assert.equal(allowedAuthUrl(url), false);
  }
});

const base = { url: DEVICE_URL, challenge: false, codeInputs: 1, continueButtons: 1, authorizeButtons: 0, success: false };
test('policy enters only code then Continue; no generic consent or account automation', () => {
  assert.equal(decide(base, { entered: false, submitted: false, authorized: false }), 'code');
  assert.equal(decide(base, { entered: true, submitted: false, authorized: false }), 'continue');
  assert.equal(decide({ ...base, url: 'https://github.com/login/device/code', codeInputs: 0, continueButtons: 0, authorizeButtons: 1 },
    { entered: true, submitted: true, authorized: false }), 'authorize');
  assert.equal(decide({ ...base, authorizeButtons: 1 }, { entered: false, submitted: false, authorized: false }), 'code');
});

test('policy aborts all identity challenges before filling or clicking', () => {
  assert.throws(() => decide({ ...base, challenge: true }, { entered: false, submitted: false, authorized: false }), { code: 'MANUAL_REQUIRED' });
  assert.throws(() => decide({ ...base, url: 'https://github.com/login' }, { entered: true, submitted: true, authorized: false }), { code: 'MANUAL_REQUIRED' });
  assert.throws(() => decide({ ...base, codeInputs: 2 }, { entered: false, submitted: false, authorized: false }), { code: 'MANUAL_REQUIRED' });
  assert.throws(() => decide({ ...base, url: 'https://github.com/login', challenge: true },
    { entered: false, submitted: false, authorized: false }), error => error.code === 'MANUAL_REQUIRED' && error.message.includes('No credentials were entered'));
});

test('browser owns a stable new page, never navigates or awaits closing transient Edge startup tabs', async () => {
  let unexpected = 0, popupClosed = 0;
  const startup = { close() { throw new Error('Startup close can hang; never call it.'); } };
  const stable = {};
  let onPage;
  const context = {
    pages() { return [startup]; },
    async newPage() { return stable; },
    on(event, handler) { assert.equal(event, 'page'); onPage = handler; },
  };
  assert.equal(await ownPage(context, () => { unexpected++; }), stable);
  onPage(stable);
  assert.equal(unexpected, 0);
  onPage({ async close() { popupClosed++; } });
  assert.equal(unexpected, 1);
  assert.equal(popupClosed, 1);
});
test('policy does not infer success before code submission or authorize twice', () => {
  assert.equal(decide({ ...base, success: true, codeInputs: 0 }, { entered: false, submitted: false, authorized: false }), 'wait');
  assert.equal(decide({ ...base, success: true }, { entered: true, submitted: true, authorized: false }), 'complete');
  assert.equal(decide({ ...base, url: 'https://github.com/login/device/code', codeInputs: 0, authorizeButtons: 1 },
    { entered: true, submitted: true, authorized: true }), 'wait');
});

test('dedicated profile is outside checkout, not a normal Edge/Chrome profile', () => {
  assert.equal(profilePath('C:\\git\\PilotSwarm', 'win32', 'C:\\Users\\dev'),
    'C:\\Users\\dev\\AppData\\Local\\PilotSwarm\\auth-automation\\edge-profile');
  assert.equal(profilePath('/workspaces/PilotSwarm', 'linux', '/home/dev'),
    '/home/dev/.local/share/PilotSwarm/auth-automation/chromium-profile');
  assert.throws(() => profilePath('/home/dev', 'linux', '/home/dev'), { code: 'UNSAFE_PROFILE' });
});

test('argument contract requires exact explicit Windows target and bounds timeout', () => {
  assert.deepEqual(parseArgs(['login', '--wsl', 'Ubuntu-24.04', '--timeout-ms', '45000']).target, { kind: 'wsl', distro: 'Ubuntu-24.04' });
  assert.deepEqual(parseArgs(['status', '--current']).target, { kind: 'current' });
  for (const args of [['login', '--wsl', '*'], ['login', '--wsl', 'ok;id'], ['login', '--current', '--wsl', 'Ubuntu-24.04'],
    ['login', '--timeout-ms', 'NaN'], ['login', '--timeout-ms', '300001'], ['browser-install', '--current'],
    ['login', '--wsl'], ['login', '--unknown'], ['login', '--wsl', 'ok', '--wsl', 'other']]) {
    assert.throws(() => parseArgs(args));
  }
  assert.throws(() => exactName('-all'));
});

test('gh command uses device/web flow with no-op browser and clean token environment', () => {
  const target = process.platform === 'win32' ? { kind: 'wsl', distro: 'Ubuntu-24.04' } : { kind: 'current' };
  const command = ghCommand(target, 'login');
  if (target.kind === 'wsl') {
    assert.equal(command.file, 'wsl.exe');
    assert.deepEqual(command.args.slice(0, 3), ['--distribution', target.distro, '--exec']);
    assert.ok(command.args.includes('setsid'));
    assert.equal(command.args[command.args.indexOf('setsid') + 1], '--wait');
    assert.deepEqual(command.remote, { file: 'wsl.exe', args: ['--distribution', target.distro, '--exec'] });
  } else {
    assert.equal(command.file, 'env');
    assert.equal(command.remote, undefined);
  }
  assert.ok(command.args.includes('--web'));
  assert.ok(command.args.includes('GH_BROWSER=/bin/true'));
  assert.ok(command.args.includes('GH_TOKEN'));
  assert.ok(command.args.includes('--skip-ssh-key'));
  assert.ok(command.args.includes('--clipboard=false'));
  assert.ok(!command.args.includes('--insecure-storage'));
  assert.ok(!command.args.includes('--with-token'));
});

test('removed container authentication and workspace options fail explicitly', () => {
  for (const args of [
    ['login', '--container', 'exact-id'],
    ['status', '--wsl', 'Ubuntu-24.04', '--container', 'exact-id'],
    ['login', '--workspace', '/home/dev/PilotSwarm'],
    ['login', '--wsl', 'Ubuntu-24.04', '--workspace', '/home/dev/PilotSwarm'],
    ['status', '--current', '--container'],
  ]) {
    assert.throws(() => parseArgs(args), error =>
      error.code === 'INVALID_TARGET' && error.message.includes('no longer supported') && error.message.includes('--wsl'));
  }
  const unsupported = { kind: 'container', container: 'exact-id' };
  assert.throws(() => transport(unsupported), { code: 'INVALID_TARGET' });
  assert.throws(() => ghCommand(unsupported, 'login'), { code: 'INVALID_TARGET' });
  assert.throws(() => ghCommand(unsupported, 'status'), { code: 'INVALID_TARGET' });
});

test('WSL and current commands enforce their host platform', () => {
  if (process.platform === 'win32') {
    assert.throws(() => ghCommand({ kind: 'current' }, 'status'), { code: 'INVALID_TARGET' });
    assert.throws(() => parseArgs(['login']), { code: 'USAGE' });
  } else {
    assert.throws(() => ghCommand({ kind: 'wsl', distro: 'Ubuntu-24.04' }, 'status'), { code: 'INVALID_TARGET' });
    if (process.platform === 'linux') assert.deepEqual(parseArgs(['login']).target, { kind: 'current' });
  }
});

test('successful login always verifies gh status and closes both resources', async () => {
  const fixture = setup();
  assert.deepEqual(await login(fixture.options), { authenticated: true, copilotVerified: false });
  assert.deepEqual(fixture.calls, ['login', 'enter', 'browser', 'status', 'stop-status', 'stop-browser', 'stop-gh']);
});

test('failed gh status is not reported as auth success', async () => {
  const fixture = setup({ statusCode: 1 });
  await assert.rejects(login(fixture.options), { code: 'GH_STATUS' });
  assert.ok(fixture.calls.includes('stop-browser'));
  assert.ok(fixture.calls.includes('stop-gh'));
});

test('identity challenge clearly aborts and still cleans up gh/browser', async () => {
  const fixture = setup({ browserError: new AuthError('MANUAL_REQUIRED', 'Use manual identity verification.') });
  await assert.rejects(login(fixture.options), { code: 'MANUAL_REQUIRED' });
  assert.ok(!fixture.calls.includes('status'));
  assert.ok(fixture.calls.includes('stop-browser'));
  assert.ok(fixture.calls.includes('stop-gh'));
});

test('process exits without code or with error fail', async () => {
  await assert.rejects(login(setup({ noCode: true }).options), { code: 'NO_DEVICE_CODE' });
  await assert.rejects(login(setup({ loginCode: 1 }).options), { code: 'GH_LOGIN' });
});

test('bounded timeout terminates launched resources, not unrelated processes', async () => {
  const fixture = setup({ hang: true });
  fixture.options.timeoutMs = 20;
  await assert.rejects(login(fixture.options), { code: 'TIMEOUT' });
  assert.ok(fixture.calls.includes('stop-browser'));
  assert.ok(fixture.calls.includes('stop-gh'));
  assert.ok(!fixture.calls.includes('status'));
});

test('cancel aborts and terminates exact launched resources', async () => {
  const fixture = setup({ hang: true });
  const controller = new AbortController();
  fixture.options.signal = controller.signal;
  const result = login(fixture.options);
  await sleep(5);
  controller.abort();
  await assert.rejects(result, { code: 'CANCELLED' });
  assert.ok(fixture.calls.includes('stop-browser'));
  assert.ok(fixture.calls.includes('stop-gh'));
});

test('pre-cancelled flow never launches gh or browser', async () => {
  const fixture = setup();
  fixture.options.signal = AbortSignal.abort();
  await assert.rejects(login(fixture.options), { code: 'CANCELLED' });
  assert.deepEqual(fixture.calls, ['stop-browser']);
});

test('browser cleanup failure does not prevent process cleanup; raw exception redacted', async () => {
  const fixture = setup({ cleanupError: true });
  await assert.rejects(login(fixture.options), error => error.code === 'CLEANUP_FAILED' && !error.message.includes('fixture secret'));
  assert.ok(fixture.calls.includes('stop-gh'));
});

test('invalid service timeout fails before starting', async () => {
  const fixture = setup();
  fixture.options.timeoutMs = Infinity;
  await assert.rejects(login(fixture.options), { code: 'INVALID_TIMEOUT' });
  assert.deepEqual(fixture.calls, []);
});

test('real local process adapter captures no secrets and kills only its launched tree', async () => {
  const processes = new NodeProcesses();
  const sentinel = processes.start({ file: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'] });
  const running = processes.start({ file: process.execPath, args: ['-e', 'process.stdout.write("fixture-ready");setInterval(()=>{},1000)'] });
  try {
    await sleep(100);
    await running.terminate();
    assert.notEqual(await running.completion, 0);
    const sentinelExited = await Promise.race([sentinel.completion.then(() => true), sleep(30).then(() => false)]);
    assert.equal(sentinelExited, false);
  } finally { await Promise.all([running.terminate(), sentinel.terminate()]); }
});

test('Windows browser job owns descendants even after the launcher exits, without killing a sentinel', {
  skip: process.platform !== 'win32' ? 'Windows Job Object coverage runs on Windows.' : false,
}, async () => {
  const file = path.join(process.cwd(), 'tools', 'auth-automation', 'test', `.fixture-child-${randomUUID()}.pid`);
  const processes = new NodeProcesses();
  const sentinel = processes.start({ file: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'] });
  const ready = `${file}.ready`;
  const childScript = `require('node:fs').writeFileSync(${JSON.stringify(ready)},'ready');setInterval(()=>{},1000);`;
  const script = `const fs=require('node:fs');const {spawn}=require('node:child_process'); const child=spawn(process.execPath,['-e',${JSON.stringify(childScript)}],{stdio:'ignore',detached:true});const poll=setInterval(()=>{if(fs.existsSync(${JSON.stringify(ready)})){fs.writeFileSync(${JSON.stringify(file)},JSON.stringify({child:child.pid,parent:process.pid}));clearInterval(poll);child.unref();}},20);`;
  const running = processes.start(browserCommand(process.execPath, ['-e', script]));
  try {
    let identity;
    const deadline = Date.now() + 10000;
    while (!identity && Date.now() < deadline) {
      const text = await readFile(file, 'utf8').catch(() => '');
      if (text) identity = JSON.parse(text);
      else await sleep(50);
    }
    assert.ok(identity?.child, 'The controlled browser descendant must start.');
    let parentExited = false;
    while (!parentExited && Date.now() < deadline) {
      try { process.kill(identity.parent, 0); await sleep(20); }
      catch (error) { assert.equal(error.code, 'ESRCH'); parentExited = true; }
    }
    assert.ok(parentExited, 'The controlled launcher must exit before job ownership is checked.');
    assert.equal(await Promise.race([running.completion.then(() => true), sleep(50).then(() => false)]), false,
      'Job supervisor must stay alive after launcher exits.');
    process.kill(identity.child, 0);
    await running.terminate();
    assert.throws(() => process.kill(identity.child, 0), { code: 'ESRCH' });
    assert.equal(await Promise.race([sentinel.completion.then(() => true), sleep(30).then(() => false)]), false);
  } finally {
    await Promise.all([running.terminate(), sentinel.terminate()]);
    await rm(file, { force: true });
    await rm(ready, { force: true });
  }
});

test('status suppresses output and cleans up on timeout/cancel', async () => {
  const processes = new NodeProcesses();
  assert.equal(await status({ file: process.execPath, args: ['-e', 'process.stdout.write("fixture-token");process.exit(0)'] }, processes), true);
  await assert.rejects(status({ file: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'] }, processes, 20), { code: 'TIMEOUT' });
  await assert.rejects(status({ file: process.execPath, args: ['-e', 'process.exit(0)'] }, processes, 100, AbortSignal.abort()), { code: 'CANCELLED' });
});

test('remote gh wrapper waits for setsid fork, preserves PID/output/exit, and cleans exact WSL group', {
  skip: process.env.PILOTSWARM_AUTH_TEST_WSL ? false : 'Explicit named WSL read-only process fixture not selected.',
}, async () => {
  const distro = exactName(process.env.PILOTSWARM_AUTH_TEST_WSL);
  const command = ghCommand({ kind: 'wsl', distro }, 'status');
  // Use a credential-free child. Running setsid through WSL exercises its
  // process-group-leader fork; no gh/browser/authentication is invoked.
  const ghIndex = command.args.indexOf('gh');
  command.args.splice(ghIndex, command.args.length - ghIndex,
    'sh', '-c', 'printf "fixture-ready\\n"; sleep 1; exit 7');
  let output = '';
  const processes = new NodeProcesses();
  const running = processes.start(command, chunk => { output += chunk; });
  try {
    assert.equal(await running.completion, 7);
    assert.ok(output.includes('fixture-ready'));
    assert.ok(!output.includes('PILOTSWARM_AUTH_PID='), 'Internal PID marker must never reach auth parser.');
  } finally { await running.terminate(); }
  command.args.splice(ghIndex, command.args.length - ghIndex,
    'sh', '-c', 'printf "fixture-ready\\n"; sleep 60');
  output = '';
  const longRunning = processes.start(command, chunk => { output += chunk; });
  try {
    const deadline = Date.now() + 5000;
    while (!output.includes('fixture-ready') && Date.now() < deadline) await sleep(20);
    assert.ok(output.includes('fixture-ready'), 'Remote fixture must emit output before targeted cancellation.');
    await longRunning.terminate();
    assert.notEqual(await longRunning.completion, 0);
  } finally { await longRunning.terminate(); }
});
