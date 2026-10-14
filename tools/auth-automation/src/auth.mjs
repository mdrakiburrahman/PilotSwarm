import { AuthError, DeviceCodeParser } from './policy.mjs';
import { status } from './process.mjs';

/** @typedef {import('./process.mjs').ProcessAdapter} ProcessAdapter */
/** @typedef {import('./browser.mjs').BrowserAdapter} BrowserAdapter */
/** @typedef {import('./process.mjs').Command} Command */

/**
 * The CLI owns gh's tokens. This coordinator holds only a short-lived device code.
 * @param {{processes:ProcessAdapter,browser:BrowserAdapter,loginCommand:Command,statusCommand:Command,
 * timeoutMs?:number,signal?:AbortSignal}} options
 */
export async function login(options) {
  const timeoutMs = options.timeoutMs ?? 120000;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 300000) {
    throw new AuthError('INVALID_TIMEOUT', 'Authentication timeout must be between 1 and 300000 milliseconds.');
  }
  const parser = new DeviceCodeParser();
  const controller = new AbortController();
  const abort = () => controller.abort();
  options.signal?.addEventListener('abort', abort, { once: true });
  if (options.signal?.aborted) controller.abort();
  /** @type {import('./process.mjs').Running | undefined} */
  let running;
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;
  /** @type {(value:{userCode:string,verificationUrl:string})=>void} */
  let resolveCode = () => {};
  /** @type {(error:unknown)=>void} */
  let rejectCode = () => {};
  let codeSent = false;
  const codeReady = new Promise((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });
  void codeReady.catch(() => {});
  const cancelled = new Promise((_, reject) => {
    controller.signal.addEventListener('abort', () => reject(new AuthError('CANCELLED', 'Authentication cancelled. Use gh auth login manually if identity verification is needed.')), { once: true });
  });
  void cancelled.catch(() => {});
  try {
    if (controller.signal.aborted) throw new AuthError('CANCELLED', 'Authentication cancelled.');
    running = options.processes.start(options.loginCommand, chunk => {
      try {
        const code = parser.push(chunk);
        if (code && !codeSent) { codeSent = true; resolveCode(code); }
      } catch (error) { rejectCode(error); }
    });
    const active = running;
    const operation = (async () => {
      const details = /** @type {{userCode:string,verificationUrl:string}} */ (await Promise.race([
        codeReady, active.completion.then(() => { throw new AuthError('NO_DEVICE_CODE', 'gh ended before emitting its device verification code. Check authentication status or use manual login.'); }),
      ]));
      // gh waits for Enter before calling the configured no-op browser.
      active.write('\n');
      const browserFlow = options.browser.run(details.userCode, controller.signal);
      const result = await Promise.race([
        browserFlow.then(() => active.completion),
        active.completion.then(code => {
          if (code !== 0) throw new AuthError('GH_LOGIN', 'GitHub CLI authentication failed. Use manual gh login.');
          return code;
        }),
      ]);
      if (result !== 0) throw new AuthError('GH_LOGIN', 'GitHub CLI authentication failed.');
      if (controller.signal.aborted) throw new AuthError('CANCELLED', 'Authentication cancelled.');
      if (!await status(options.statusCommand, options.processes, Math.min(15000, timeoutMs), controller.signal)) {
        throw new AuthError('GH_STATUS', 'gh auth status did not confirm authentication. Copilot access is a separate check.');
      }
      return { authenticated: true, copilotVerified: false };
    })();
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        reject(new AuthError('TIMEOUT', 'Authentication timed out. Retry manually; no identity challenge is automated.'));
        controller.abort();
      }, timeoutMs);
    });
    return await Promise.race([operation, timeout, cancelled]);
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', abort);
    controller.abort();
    parser.clear();
    // Independent cleanup attempts: browser failure must not leave remote gh running.
    const cleanup = await Promise.allSettled([options.browser.close(), running?.terminate()]);
    if (cleanup.some(result => result.status === 'rejected')) {
      throw new AuthError('CLEANUP_FAILED', 'Authentication cleanup failed. Inspect only the selected target and dedicated PilotSwarm profile.');
    }
  }
}
