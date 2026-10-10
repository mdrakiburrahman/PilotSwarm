import assert from 'node:assert/strict';
import { test } from 'node:test';
import path from 'node:path';
import { access } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { browserExecutableAvailable, browserInstallCommand } from '../src/browser.mjs';

test('browser installer resolves the public package manifest, not the unexported CLI subpath', () => {
  const packageFile = path.join(process.cwd(), 'node_modules', 'playwright', 'package.json');
  const calls = [];
  const command = browserInstallCommand(specifier => {
    calls.push(specifier);
    assert.equal(specifier, 'playwright/package.json');
    return packageFile;
  });
  assert.deepEqual(calls, ['playwright/package.json']);
  assert.deepEqual(command, {
    file: process.execPath,
    args: [path.join(path.dirname(packageFile), 'cli.js'), 'install', 'chromium'],
  });
  assert.ok(!command.args.includes('--with-deps'), 'Installer must not perform privileged system dependency changes.');
});

test('browser installer resolves the installed Playwright CLI executable', async () => {
  const require = createRequire(import.meta.url);
  const command = browserInstallCommand();
  assert.equal(command.args[0], path.join(path.dirname(require.resolve('playwright/package.json')), 'cli.js'));
  await access(command.args[0]);
});

test('preinstalled image executable needs no download or shared-directory mutation', async () => {
  const calls = [];
  assert.equal(await browserExecutableAvailable('/opt/playwright/chromium/chrome', async file => {
    calls.push(file);
  }), true);
  assert.deepEqual(calls, ['/opt/playwright/chromium/chrome']);
  assert.equal(await browserExecutableAvailable('/missing/chrome', async () => {
    throw Object.assign(new Error('missing'), { code: 'ENOENT' });
  }), false);
  await assert.rejects(browserExecutableAvailable('/restricted/chrome', async () => {
    throw Object.assign(new Error('restricted'), { code: 'EACCES' });
  }), { code: 'EACCES' });
});
