import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { AuthError } from './policy.mjs';

/** @typedef {import('./process.mjs').Command} Command */
/** @typedef {{kind:'current'}|{kind:'wsl',distro:string}|{kind:'container',container:string,distro?:string,workspace?:string,user?:string,workspaceFolder?:string}} Target */

/** @param {string} value */
export function exactName(value) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(value)) {
    throw new AuthError('INVALID_TARGET', 'Specify an exact distribution or container name/ID, not a pattern.');
  }
  return value;
}

/** @param {Target} target @returns {{file:string,args:string[]}} */
export function transport(target) {
  if (target.kind === 'wsl') {
    if (process.platform !== 'win32') throw new AuthError('INVALID_TARGET', 'WSL targets require a Windows host.');
    return { file: 'wsl.exe', args: ['--distribution', exactName(target.distro), '--exec'] };
  }
  if (target.kind === 'container') {
    const docker = ['docker', 'exec', '-i',
      ...(target.user ? ['--user', target.user] : []),
      ...(target.workspaceFolder ? ['--workdir', target.workspaceFolder] : []),
      exactName(target.container)];
    return target.distro
      ? { file: 'wsl.exe', args: ['--distribution', exactName(target.distro), '--exec', ...docker] }
      : { file: 'docker', args: docker.slice(1) };
  }
  return { file: 'env', args: [] };
}

/** @param {Target} target @param {'login'|'status'} operation @returns {Command} */
export function ghCommand(target, operation) {
  if (target.kind === 'current' && process.platform !== 'linux') {
    throw new AuthError('INVALID_TARGET', 'Select --wsl DISTRO or --container EXACT_ID on Windows; current mode is Linux/container only.');
  }
  const prefix = transport(target);
  const args = operation === 'login'
    ? ['auth', 'login', '--hostname', 'github.com', '--git-protocol', 'https', '--web', '--skip-ssh-key', '--clipboard=false']
    : ['auth', 'status', '--hostname', 'github.com'];
  const envArgs = ['-u', 'GH_TOKEN', '-u', 'GITHUB_TOKEN', '-u', 'GH_ENTERPRISE_TOKEN', '-u', 'GITHUB_ENTERPRISE_TOKEN', '-u', 'GH_DEBUG', 'GH_BROWSER=/bin/true', 'BROWSER=/bin/true', 'GH_PROMPT_DISABLED=1'];
  if (target.kind === 'current') return { file: 'env', args: [...envArgs, 'gh', ...args] };
  // Only fixed strings enter this shell. Names/IDs are separate transport arguments.
  const script = 'printf "PILOTSWARM_AUTH_PID=%s\\n" "$$"; exec env "$@"';
  return {
    file: prefix.file,
    // WSL may start setsid as a process-group leader. Its implicit fork must be
    // waited for, otherwise wsl.exe exits before gh can emit the device code.
    args: [...prefix.args, 'setsid', '--wait', 'sh', '-c', script, 'pilotswarm-auth', ...envArgs, 'gh', ...args],
    remote: prefix,
  };
}

/** Parse JSONC without treating comments inside string values as comments.
 * @param {string} source */
export function parseJsonc(source) {
  let result = '';
  let quoted = false;
  let escaped = false;
  for (let i = 0; i < source.length; i++) {
    const c = source[i], next = source[i + 1];
    if (quoted) {
      result += c;
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') quoted = false;
    } else if (c === '"') { quoted = true; result += c; }
    else if (c === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') i++;
      result += '\n';
    } else if (c === '/' && next === '*') {
      i += 2;
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) i++;
      i++;
      result += ' ';
    } else result += c;
  }
  // Remove trailing commas outside strings.
  return JSON.parse(result.replace(/("(?:\\.|[^"\\])*")|,\s*(?=[}\]])/g, (match, string) => string ?? ''));
}

/** @param {string} file @param {string[]} args */
export async function query(file, args) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: 15000, maxBuffer: 1024 * 1024, windowsHide: true, encoding: 'utf8' }, (error, stdout) => {
      if (error) reject(new AuthError('TARGET_LOOKUP', 'Could not inspect the exact devcontainer target. Start it and check the selected Docker context.'));
      else resolve(stdout);
    });
  });
}

/**
 * Validate an explicit container ID against source service, Compose files, and workspace.
 * No "first matching container" fallback or image/container-name heuristic.
 * @param {string} repoRoot @param {Target} target
 * @param {typeof query} [run] @param {typeof readFile} [read]
 */
export async function validateContainer(repoRoot, target, run = query, read = readFile) {
  if (target.kind !== 'container') return target;
  if (target.workspace && (!target.distro || !target.workspace.startsWith('/') || target.workspace.includes('\n') || target.workspace.includes('\0'))) {
    throw new AuthError('INVALID_TARGET', '--workspace must be an absolute native Linux checkout path with --wsl and --container.');
  }
  const root = target.workspace ?? repoRoot;
  const pathApi = target.workspace ? path.posix : path;
  const source = pathApi.join(root, '.devcontainer', 'devcontainer.json');
  let config;
  try {
    const text = target.workspace && target.distro
      ? await run('wsl.exe', ['--distribution', exactName(target.distro), '--exec', 'cat', source])
      : await read(source, 'utf8');
    config = parseJsonc(String(text));
  }
  catch { throw new AuthError('INVALID_CONFIG', 'Source .devcontainer/devcontainer.json is missing or invalid.'); }
  if (typeof config.service !== 'string' || typeof config.workspaceFolder !== 'string'
    || typeof config.remoteUser !== 'string' || !/^[a-z_][a-z0-9_-]*$/.test(config.remoteUser)
    || config.remoteUser === 'root' || !config.dockerComposeFile) {
    throw new AuthError('INVALID_CONFIG', 'Source devcontainer must declare service, workspaceFolder, and dockerComposeFile.');
  }
  /** @type {unknown[]} */
  const compose = Array.isArray(config.dockerComposeFile) ? config.dockerComposeFile : [config.dockerComposeFile];
  if (!compose.length || compose.some(file => typeof file !== 'string')) throw new AuthError('INVALID_CONFIG', 'Invalid source Compose file list.');
  const docker = target.distro
    ? { file: 'wsl.exe', args: ['--distribution', exactName(target.distro), '--exec', 'docker'] }
    : { file: 'docker', args: [] };
  // Deliberately omit Config.Env: container credentials are not diagnostic output.
  const format = '{"State":{{json .State}},"Config":{"Labels":{{json .Config.Labels}}},"Mounts":{{json .Mounts}}}';
  const raw = await run(docker.file, [...docker.args, 'inspect', '--type', 'container', '--format', format, exactName(target.container)]);
  let inspected;
  try { inspected = JSON.parse(String(raw)); if (!Array.isArray(inspected)) inspected = [inspected]; }
  catch { throw new AuthError('TARGET_LOOKUP', 'Invalid Docker inspection result.'); }
  if (!Array.isArray(inspected) || inspected.length !== 1) throw new AuthError('INVALID_TARGET', 'Expected exactly one container.');
  const container = inspected[0];
  const labels = container.Config?.Labels ?? {};
  // Dev Containers writes these labels from the source used to create the workspace.
  const localFolder = labels['devcontainer.local_folder'];
  const configFile = labels['devcontainer.config_file'];
  const normalize = /** @param {string} value */ value => value.replace(/\\/g, '/').replace(/\/+$/, '');
  const expectedRoot = normalize(root);
  const expectedConfig = normalize(source);
  const mappedRoot = !target.workspace && process.platform === 'win32' && target.distro
    ? String(await run('wsl.exe', ['--distribution', exactName(target.distro), '--exec', 'wslpath', '-a', root])).trim()
    : root;
  const validRoots = new Set([expectedRoot, normalize(mappedRoot)]);
  const validConfigs = new Set([expectedConfig, `${normalize(mappedRoot)}/.devcontainer/devcontainer.json`]);
  if (!container.State?.Running || labels['com.docker.compose.service'] !== config.service
    || labels['io.pilotswarm.devcontainer'] !== 'source'
    || (localFolder !== undefined && (typeof localFolder !== 'string' || !validRoots.has(normalize(localFolder))))
    || (configFile !== undefined && (typeof configFile !== 'string' || !validConfigs.has(normalize(configFile))))) {
    throw new AuthError('INVALID_TARGET', 'Container is not the running source devcontainer for this exact checkout.');
  }
  const files = String(labels['com.docker.compose.project.config_files'] ?? '').split(',').map(normalize);
  for (const file of compose) {
    const resolved = normalize(pathApi.resolve(pathApi.dirname(source), /** @type {string} */ (file)));
    const mapped = path.posix.resolve(normalize(mappedRoot), '.devcontainer', /** @type {string} */ (file));
    if (!files.includes(resolved) && !files.includes(mapped)) throw new AuthError('INVALID_TARGET', 'Container Compose files do not match the source devcontainer.');
  }
  const mounts = container.Mounts ?? [];
  if (!mounts.some(/** @param {{Destination?:string,Source?:string}} mount */ mount =>
    mount.Destination === config.workspaceFolder && typeof mount.Source === 'string' && validRoots.has(normalize(mount.Source)))) {
    throw new AuthError('INVALID_TARGET', 'Container workspace mount does not match the exact checkout.');
  }
  return { ...target, user: config.remoteUser, workspaceFolder: config.workspaceFolder };
}
