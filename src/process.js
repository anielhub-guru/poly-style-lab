import { spawn } from 'node:child_process';

/** The one line of stderr worth showing: an ERROR: line if present, else the last line that is not just a warning. */
export function errorSummary(stderr) {
  const lines = String(stderr).split('\n').map(line => line.trim()).filter(Boolean);
  const error = [...lines].reverse().find(line => /^ERROR:/i.test(line));
  const meaningful = [...lines].reverse().find(line => !/deprecat|warning/i.test(line));
  return (error || meaningful || lines.at(-1) || '').replace(/^ERROR:\s*(\[[^\]]+\]\s*)?/i, '').slice(0, 300);
}

/** Run a command without a shell. Rejects on non-zero exit, spawn error or timeout; the error carries stdout/stderr. */
export function runProcess(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: options.cwd, env: options.env || process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', timedOut = false;
    const timer = options.timeoutMs ? setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, options.timeoutMs) : null;
    const keep = (current, chunk) => (current + chunk).slice(-200_000);
    child.stdout.on('data', chunk => { stdout = keep(stdout, chunk); });
    child.stderr.on('data', chunk => { stderr = keep(stderr, chunk); });
    child.on('error', error => { clearTimeout(timer); reject(Object.assign(error, { stdout, stderr })); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code === 0) return resolve({ stdout, stderr });
      const reason = timedOut ? `timed out after ${Math.round(options.timeoutMs / 1000)}s` : `exited ${code}`;
      reject(Object.assign(new Error(`${command.split('/').at(-1)} ${reason}: ${errorSummary(stderr)}`), { stdout, stderr, code, timedOut }));
    });
  });
}
