import { AuthError } from './policy.mjs';

/** @typedef {import('./process.mjs').Command} Command */
/** @typedef {{kind:'current'}|{kind:'wsl',distro:string}} Target */

/** @param {string} value */
export function exactName(value) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(value)) {
    throw new AuthError('INVALID_TARGET', 'Specify an exact distribution name, not a pattern.');
  }
  return value;
}

/** @param {Target} target @returns {{file:string,args:string[]}} */
export function transport(target) {
  if (target.kind !== 'current' && target.kind !== 'wsl') {
    throw new AuthError('INVALID_TARGET', 'Authenticate on the WSL host with --wsl DISTRO or --current, not inside the UI container.');
  }
  if (target.kind === 'wsl') {
    if (process.platform !== 'win32') throw new AuthError('INVALID_TARGET', 'WSL targets require a Windows host.');
    return { file: 'wsl.exe', args: ['--distribution', exactName(target.distro), '--exec'] };
  }
  return { file: 'env', args: [] };
}

/** @param {Target} target @param {'login'|'status'} operation @returns {Command} */
export function ghCommand(target, operation) {
  if (target.kind === 'current' && process.platform !== 'linux') {
    throw new AuthError('INVALID_TARGET', 'Select --wsl DISTRO on Windows; current mode is Linux only.');
  }
  const prefix = transport(target);
  const args = operation === 'login'
    ? ['auth', 'login', '--hostname', 'github.com', '--git-protocol', 'https', '--web', '--skip-ssh-key', '--clipboard=false']
    : ['auth', 'status', '--hostname', 'github.com'];
  const envArgs = ['-u', 'GH_TOKEN', '-u', 'GITHUB_TOKEN', '-u', 'GH_ENTERPRISE_TOKEN', '-u', 'GITHUB_ENTERPRISE_TOKEN', '-u', 'GH_DEBUG', 'GH_BROWSER=/bin/true', 'BROWSER=/bin/true', 'GH_PROMPT_DISABLED=1'];
  if (target.kind === 'current') return { file: 'env', args: [...envArgs, 'gh', ...args] };
  const script = 'printf "PILOTSWARM_AUTH_PID=%s\\n" "$$"; exec env "$@"';
  return {
    file: prefix.file,
    args: [...prefix.args, 'setsid', '--wait', 'sh', '-c', script, 'pilotswarm-auth', ...envArgs, 'gh', ...args],
    remote: prefix,
  };
}
