import { spawn } from 'node:child_process';
import { AuthError } from './policy.mjs';

/**
 * @typedef {{file:string, args:string[], remote?:{file:string,args:string[]}}} Command
 * @typedef {{completion:Promise<number>, write:(text:string)=>void, terminate:()=>Promise<void>}} Running
 * @typedef {{start:(command:Command,onOutput?:(chunk:string)=>void)=>Running}} ProcessAdapter
 */

/** No output capture: neither authentication codes nor token diagnostics are logged. */
export class NodeProcesses {
  /** @param {Command} command @param {(chunk:string)=>void} [onOutput] @returns {Running} */
  start(command, onOutput = () => {}) {
    const env = { ...process.env };
    for (const name of ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN', 'GH_DEBUG']) delete env[name];
    const child = spawn(command.file, command.args, {
      env, shell: false, detached: process.platform !== 'win32',
      windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    });
    let exited = false;
    let pending = '';
    /** @type {number | undefined} */
    let remotePid;
    const completion = new Promise((resolve, reject) => {
      child.once('error', () => {
        exited = true;
        reject(new AuthError('PROCESS_START', 'Could not start the selected authentication process. Check tool installation.'));
      });
      child.once('close', code => { exited = true; resolve(code ?? 1); });
    });
    // Prevent unhandled rejection if the browser fails before completion is awaited.
    void completion.catch(() => {});
    /** @param {string} chunk */
    function output(chunk) {
      if (command.remote && !remotePid) {
        pending = (pending + chunk).slice(-8192);
        const marker = pending.match(/^PILOTSWARM_AUTH_PID=(\d+)\r?\n/m);
        if (!marker) return;
        remotePid = Number(marker[1]);
        chunk = pending.slice((marker.index ?? 0) + marker[0].length);
        pending = '';
      }
      try { onOutput(chunk); } catch { /* The service owns output-handler errors. */ }
    }
    child.stdout.setEncoding('utf8').on('data', output);
    child.stderr.setEncoding('utf8').on('data', output);
    child.stdin.on('error', () => {});
    /** @type {Promise<void> | undefined} */
    let terminating;
    return {
      completion: /** @type {Promise<number>} */ (completion),
      write: text => { if (!exited) child.stdin.write(text); },
      terminate: () => {
        terminating ??= (async () => {
          if (exited || !child.pid) return;
          if (command.remote) {
            // The remote wrapper emits its own setsid process-group leader before gh starts.
            const deadline = Date.now() + 1000;
            while (!remotePid && !exited && Date.now() < deadline) await sleep(25);
            if (!exited && remotePid && remotePid > 1) {
              await quietCommand(command.remote.file, [
                ...command.remote.args, 'sh', '-c',
                '/bin/kill -KILL -- "-$1" 2>/dev/null || { /bin/kill -0 -- "-$1" 2>/dev/null && exit 3; exit 0; }',
                'pilotswarm-auth-cleanup', String(remotePid),
              ]);
            } else if (!exited) {
              await killLocal(child.pid);
              throw new AuthError('CLEANUP_FAILED', 'Remote process identity was unavailable; inspect the selected target manually.');
            }
          }
          if (!exited) await killLocal(child.pid);
          await Promise.race([completion.catch(() => 1), sleep(2000)]);
        })();
        return terminating;
      },
    };
  }
}

/** @param {number} ms */
export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/** @param {number} pid */
async function killLocal(pid) {
  if (process.platform === 'win32') {
    await quietCommand('taskkill.exe', ['/PID', String(pid), '/T', '/F'], true);
    try {
      process.kill(pid, 0);
      throw new AuthError('CLEANUP_FAILED', 'The launched Windows process is still running after targeted cleanup.');
    } catch (error) {
      if (error instanceof AuthError) throw error;
      if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'ESRCH') throw new AuthError('CLEANUP_FAILED', 'Unable to confirm targeted Windows process cleanup.');
    }
  } else {
    try { process.kill(-pid, 'SIGKILL'); } catch (error) {
      if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'ESRCH') throw new AuthError('CLEANUP_FAILED', 'Unable to terminate the launched process group.');
    }
  }
}

/** Bounded helper, no shell interpolation or output capture.
 * @param {string} file @param {string[]} args @param {boolean} [allowMissing] */
async function quietCommand(file, args, allowMissing = false) {
  await new Promise((resolve, reject) => {
    const child = spawn(file, args, { shell: false, windowsHide: true, stdio: 'ignore', detached: process.platform !== 'win32' });
    const timer = setTimeout(() => {
      if (child.pid) {
        if (process.platform === 'win32') child.kill();
        else { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }
      }
      reject(new AuthError('CLEANUP_FAILED', 'Process cleanup helper timed out.'));
    }, 5000);
    child.once('error', () => { clearTimeout(timer); reject(new AuthError('CLEANUP_FAILED', 'Could not start process cleanup helper.')); });
    child.once('close', code => {
      clearTimeout(timer);
      // kill/taskkill can race normal process exit; no unrelated resource is targeted.
      if (code === 0 || (allowMissing && (code === 1 || code === 128))) resolve(undefined);
      else reject(new AuthError('CLEANUP_FAILED', 'The launched process could not be cleaned up.'));
    });
  });
}

/** @param {Command} command @param {ProcessAdapter} adapter @param {number} timeoutMs @param {AbortSignal} [signal] */
export async function status(command, adapter, timeoutMs = 15000, signal) {
  if (signal?.aborted) throw new AuthError('CANCELLED', 'Authentication cancelled.');
  const running = adapter.start(command);
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;
  /** @type {()=>void} */
  let abort = () => {};
  try {
    return await Promise.race([
      running.completion,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new AuthError('TIMEOUT', 'GitHub authentication status timed out.')), timeoutMs);
        abort = () => reject(new AuthError('CANCELLED', 'Authentication cancelled.'));
        signal?.addEventListener('abort', abort, { once: true });
      }),
    ]) === 0;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
    await running.terminate();
  }
}
