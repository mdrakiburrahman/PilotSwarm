import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { login } from './auth.mjs';
import { createBrowser, installBrowser } from './browser.mjs';
import { AuthError } from './policy.mjs';
import { NodeProcesses, status } from './process.mjs';
import { exactName, ghCommand, validateContainer } from './target.mjs';

/** @param {string[]} args */
export function parseArgs(args) {
  const [command, ...rest] = args;
  if (!['status', 'login', 'browser-install'].includes(command ?? '')) {
    throw new AuthError('USAGE', 'Usage: cli.mjs status|login --wsl DISTRO [--container EXACT_ID --workspace /native/checkout] | --container EXACT_ID | --current [--timeout-ms 120000]. browser-install checks Windows Edge or installs Linux Chromium explicitly.');
  }
  /** @type {Record<string,string>} */
  const flags = {};
  for (let index = 0; index < rest.length; index++) {
    const flag = rest[index];
    if (!['--wsl', '--container', '--current', '--timeout-ms', '--workspace'].includes(flag) || flag in flags) throw new AuthError('USAGE', 'Unknown or duplicate authentication option.');
    if (flag === '--current') flags[flag] = 'true';
    else {
      const value = rest[++index];
      if (!value || value.startsWith('--')) throw new AuthError('USAGE', 'Authentication option requires a value.');
      flags[flag] = value;
    }
  }
  if (flags['--current'] && (flags['--wsl'] || flags['--container'])) throw new AuthError('USAGE', 'Choose exactly one authentication target.');
  /** @type {import('./target.mjs').Target} */
  let target;
  if (flags['--container']) target = { kind: 'container', container: exactName(flags['--container']),
    ...(flags['--wsl'] ? { distro: exactName(flags['--wsl']) } : {}),
    ...(flags['--workspace'] ? { workspace: flags['--workspace'] } : {}) };
  else if (flags['--wsl']) target = { kind: 'wsl', distro: exactName(flags['--wsl']) };
  else if (flags['--current'] || process.platform === 'linux') target = { kind: 'current' };
  else if (command !== 'browser-install') throw new AuthError('USAGE', 'Windows requires a named --wsl distribution or exact --container ID.');
  else target = { kind: 'current' };
  if (flags['--workspace'] && (!flags['--wsl'] || !flags['--container'])) throw new AuthError('USAGE', '--workspace requires an exact --container and --wsl.');
  const timeoutMs = Number(flags['--timeout-ms'] ?? 120000);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 300000) throw new AuthError('USAGE', 'Timeout must be 1000–300000 milliseconds.');
  if (command === 'browser-install' && Object.keys(flags).length) throw new AuthError('USAGE', 'browser-install acts only on the current browser host and accepts no target flags.');
  return { command, target, timeoutMs };
}

/** @param {string[]} args */
export async function main(args) {
  const options = parseArgs(args);
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once('SIGINT', cancel);
  process.once('SIGTERM', cancel);
  try {
    if (options.command === 'browser-install') {
      await installBrowser(controller.signal);
      console.log('Dedicated browser prerequisite available.');
      return;
    }
    const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
    options.target = await validateContainer(repoRoot, options.target);
    const processes = new NodeProcesses();
    const statusCommand = ghCommand(options.target, 'status');
    if (options.command === 'status') {
      if (!await status(statusCommand, processes, 15000, controller.signal)) throw new AuthError('NOT_AUTHENTICATED', 'Selected target is not authenticated to github.com.');
    } else {
      await login({
        processes, browser: createBrowser(repoRoot, processes),
        loginCommand: ghCommand(options.target, 'login'), statusCommand,
        timeoutMs: options.timeoutMs, signal: controller.signal,
      });
    }
    console.log('GitHub CLI authenticated in the selected target. Copilot entitlement/model access has not been verified.');
  } finally {
    process.removeListener('SIGINT', cancel);
    process.removeListener('SIGTERM', cancel);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => {
    // Never print raw Playwright/process exceptions, URLs, page content, tokens or device codes.
    console.error(error instanceof AuthError ? `${error.code}: ${error.message}` : 'AUTH_FAILED: Authentication could not complete. Check tooling or use manual gh auth login.');
    process.exitCode = 1;
  });
}
