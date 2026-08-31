/**
 * The exact ESM source installed as OMP's custom share handler by
 * `quire setup omp` (see commands/setup.ts). OMP's interactive /share
 * imports the default export and passes the temporary HTML export path of
 * the exact active session.
 *
 * Kept as a string so the installer writes the same bytes the tests import,
 * and so the installed asset stays dependency-free: Bun globals only, no
 * Quire imports, no shell. The CLI is spawned with an argument array, so
 * export paths containing spaces or metacharacters pass through untouched.
 */
export const OMP_SHARE_HANDLER_SOURCE = String.raw`// Quire OMP custom share handler.
//
// Installed by quire setup omp as the OMP agent directory's share.mjs.
// OMP's interactive /share imports the default export below and passes the
// exact temporary HTML export path of the active session. This handler
// publishes that export through the Quire CLI with strict redaction, no
// password, and no expiry, and returns { url, message } to OMP.
//
// Dependency-free (Bun globals only) and never shells out: the CLI is
// spawned with an argument array, so export paths containing spaces or
// metacharacters are passed through untouched.

const QUIRE_BIN = process.platform === 'win32' ? 'quire.cmd' : 'quire';
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

function parseResult(stdout) {
  const lines = stdout.split(/\r?\n/);
  const published = lines.filter((line) => line.startsWith('Published: '));
  if (published.length !== 1) {
    throw new Error('Quire did not return exactly one published URL');
  }
  const url = published[0].slice('Published: '.length).trim();
  if (!/^https?:\/\//.test(url)) {
    throw new Error('Quire returned an invalid published URL');
  }
  // The Messages line carries the count and redaction summary. It never
  // carries transcript content, so it is safe to surface to OMP.
  const summary = lines.find((line) => line.startsWith('Messages: ')) ?? 'Session published by Quire';
  return { url, message: summary };
}

async function runQuire(htmlPath, bun, timeoutMs) {
  const runtime = bun !== undefined ? bun : globalThis.Bun;
  if (!runtime || typeof runtime.spawn !== 'function') {
    throw new Error('Quire OMP share handler requires the Bun runtime');
  }
  const cmd = [QUIRE_BIN, 'publish', htmlPath, '--harness', 'omp', '--preset', 'strict', '--yes'];
  let proc;
  try {
    proc = runtime.spawn({ cmd, stdout: 'pipe', stderr: 'pipe' });
  } catch {
    throw new Error('Quire executable not found. Install the Quire CLI and retry /share');
  }
  const timeout = timeoutMs !== undefined ? timeoutMs : DEFAULT_TIMEOUT_MS;
  let timer;
  const { promise: timedOut, reject: rejectTimeout } = Promise.withResolvers();
  timer = setTimeout(() => {
    try { proc.kill(); } catch { /* already gone */ }
    rejectTimeout(new Error('Quire publish timed out after ' + Math.round(timeout / 1000) + 's'));
  }, timeout);
  if (typeof timer.unref === 'function') timer.unref();
  const result = (async () => {
    // stderr is drained but never surfaced: Quire diagnostics must not leak
    // transcript bytes into OMP, and a nonzero exit gets a fixed message.
    const [stdout, , code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (code !== 0) {
      throw new Error('Quire publish failed (exit ' + code + '). Check QUIRE_SERVER_URL and QUIRE_API_KEY.');
    }
    return parseResult(stdout);
  })();
  try {
    return await Promise.race([result, timedOut]);
  } finally {
    clearTimeout(timer);
  }
}

export { runQuire, parseResult };
export default (htmlPath) => runQuire(htmlPath);
`;
