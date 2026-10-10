import assert from 'node:assert/strict';
import { test } from 'node:test';
import path from 'node:path';
import { readFile, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { browserCommand, ownPage } from '../src/browser.mjs';
import { allowedAuthUrl, AuthError, decide, DeviceCodeParser, DEVICE_URL, profilePath } from '../src/policy.mjs';
import { login } from '../src/auth.mjs';
import { ghCommand, exactName, parseJsonc, validateContainer } from '../src/target.mjs';
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
  assert.deepEqual(parseArgs(['status', '--container', 'abc123', '--wsl', 'Ubuntu-24.04']).target,
    { kind: 'container', container: 'abc123', distro: 'Ubuntu-24.04' });
  for (const args of [['login', '--wsl', '*'], ['login', '--wsl', 'ok;id'], ['login', '--current', '--container', 'id'],
    ['login', '--timeout-ms', 'NaN'], ['login', '--timeout-ms', '300001'], ['browser-install', '--current'],
    ['login', '--wsl'], ['login', '--unknown'], ['login', '--wsl', 'ok', '--wsl', 'other']]) {
    assert.throws(() => parseArgs(args));
  }
  assert.throws(() => exactName('-all'));
});

test('gh command uses device/web flow with no-op browser and clean token environment', () => {
  const command = ghCommand({ kind: 'container', container: 'exact-id' }, 'login');
  assert.deepEqual(command.args.slice(0, 3), ['exec', '-i', 'exact-id']);
  assert.ok(command.args.includes('setsid'));
  assert.equal(command.args[command.args.indexOf('setsid') + 1], '--wait');
  assert.ok(command.args.includes('--web'));
  assert.ok(command.args.includes('GH_BROWSER=/bin/true'));
  assert.ok(command.args.includes('GH_TOKEN'));
  assert.ok(command.args.includes('--skip-ssh-key'));
  assert.ok(command.args.includes('--clipboard=false'));
  assert.ok(!command.args.includes('--insecure-storage'));
  assert.ok(!command.args.includes('--with-token'));
  assert.deepEqual(command.remote, { file: 'docker', args: ['exec', '-i', 'exact-id'] });
});

test('JSONC parser preserves URLs/comments inside strings and supports trailing commas', () => {
  assert.deepEqual(parseJsonc('{//comment\n"service":"dev", "url":"https://github.com/*safe*/", /*x*/ "files":["a",],}'),
    { service: 'dev', url: 'https://github.com/*safe*/', files: ['a'] });
});

test('container validation fails closed without source config', async () => {
  await assert.rejects(validateContainer('C:\\git\\PilotSwarm', { kind: 'container', container: 'id' }, async () => '',
    async () => { throw new Error('absent'); }), { code: 'INVALID_CONFIG' });
});

test('container validation rejects another checkout/service/stopped container', async () => {
  const config = JSON.stringify({ service: 'dev', workspaceFolder: '/workspaces/PilotSwarm', remoteUser: 'vscode', dockerComposeFile: 'compose.yaml' });
  for (const container of [
    { State: { Running: false } },
    { State: { Running: true }, Config: { Labels: { 'com.docker.compose.service': 'other' } } },
    { State: { Running: true }, Config: { Labels: { 'com.docker.compose.service': 'dev', 'devcontainer.local_folder': '/other' } } },
  ]) {
    await assert.rejects(validateContainer(process.cwd(), { kind: 'container', container: 'id' },
      async () => JSON.stringify([container]), async () => config), { code: 'INVALID_TARGET' });
  }
});

test('source devcontainer validation accepts exact container and executes as configured non-root user', async () => {
  const root = process.cwd();
  const config = JSON.stringify({
    service: 'workspace', workspaceFolder: '/workspaces/PilotSwarm',
    remoteUser: 'vscode', dockerComposeFile: ['compose.yml', '.state/mounts.json'],
  });
  const container = {
    State: { Running: true },
    Config: { Labels: {
      'com.docker.compose.service': 'workspace', 'io.pilotswarm.devcontainer': 'source',
      'devcontainer.local_folder': root,
      'devcontainer.config_file': path.join(root, '.devcontainer', 'devcontainer.json'),
      'com.docker.compose.project.config_files': [
        path.join(root, '.devcontainer', 'compose.yml'),
        path.join(root, '.devcontainer', '.state', 'mounts.json'),
      ].join(','),
    } },
    Mounts: [{ Source: root, Destination: '/workspaces/PilotSwarm' }],
  };
  const target = await validateContainer(root, { kind: 'container', container: 'exact-id' },
    async (file, args) => {
      assert.equal(file, 'docker');
      const format = args[args.indexOf('--format') + 1];
      assert.ok(!format.includes('Env'), 'Inspection must never return credential-bearing Env fields.');
      return JSON.stringify(container);
    }, async () => config);
  assert.equal(target.user, 'vscode');
  assert.deepEqual(ghCommand(target, 'status').args.slice(0, 7),
    ['exec', '-i', '--user', 'vscode', '--workdir', '/workspaces/PilotSwarm', 'exact-id']);
});

test('Windows native WSL checkout uses its source config, not the Windows checkout or first container', async () => {
  const config = JSON.stringify({
    service: 'workspace', workspaceFolder: '/workspaces/PilotSwarm', remoteUser: 'vscode',
    dockerComposeFile: ['compose.yml', '.state/mounts.json'],
  });
  const target = { kind: 'container', container: 'abc123', distro: 'Ubuntu-24.04', workspace: '/workspaces/PilotSwarm' };
  const container = {
    State: { Running: true }, Config: { Labels: {
      'com.docker.compose.service': 'workspace', 'io.pilotswarm.devcontainer': 'source',
      'devcontainer.local_folder': target.workspace,
      'devcontainer.config_file': `${target.workspace}/.devcontainer/devcontainer.json`,
      'com.docker.compose.project.config_files': `${target.workspace}/.devcontainer/compose.yml,${target.workspace}/.devcontainer/.state/mounts.json`,
    } },
    Mounts: [{ Source: target.workspace, Destination: '/workspaces/PilotSwarm' }],
  };
  const calls = [];
  const validated = await validateContainer('C:\\git\\PilotSwarm', target, async (file, args) => {
    calls.push([file, args]);
    assert.equal(file, 'wsl.exe');
    assert.deepEqual(args.slice(0, 3), ['--distribution', 'Ubuntu-24.04', '--exec']);
    return args[3] === 'cat' ? config : JSON.stringify(container);
  }, async () => { throw new Error('Must not read Windows source for the native WSL target.'); });
  assert.equal(validated.user, 'vscode');
  assert.equal(calls.length, 2);
  assert.equal(calls[0][1][4], '/workspaces/PilotSwarm/.devcontainer/devcontainer.json');
});

test('container validation rejects wrong Compose files, mounts, root user, and invalid workspace path', async () => {
  const root = process.cwd();
  const config = {
    service: 'workspace', workspaceFolder: '/workspaces/PilotSwarm', remoteUser: 'vscode', dockerComposeFile: 'compose.yml',
  };
  const container = {
    State: { Running: true }, Config: { Labels: {
      'com.docker.compose.service': 'workspace', 'io.pilotswarm.devcontainer': 'source',
      'com.docker.compose.project.config_files': path.join(root, '.devcontainer', 'compose.yml'),
    } },
    Mounts: [{ Source: root, Destination: '/workspaces/PilotSwarm' }],
  };
  await assert.rejects(validateContainer(root, { kind: 'container', container: 'id' },
    async () => JSON.stringify({ ...container, Mounts: [] }), async () => JSON.stringify(config)), { code: 'INVALID_TARGET' });
  await assert.rejects(validateContainer(root, { kind: 'container', container: 'id' },
    async () => JSON.stringify(container), async () => JSON.stringify({ ...config, dockerComposeFile: 'other.yml' })), { code: 'INVALID_TARGET' });
  await assert.rejects(validateContainer(root, { kind: 'container', container: 'id' },
    async () => JSON.stringify(container), async () => JSON.stringify({ ...config, remoteUser: 'root' })), { code: 'INVALID_CONFIG' });
  await assert.rejects(validateContainer(root, { kind: 'container', container: 'id', distro: 'Ubuntu-24.04', workspace: 'relative' }), { code: 'INVALID_TARGET' });
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
