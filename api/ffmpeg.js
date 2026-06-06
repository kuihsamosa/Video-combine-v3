const { spawn } = require('child_process');

function createLineEmitter(onLine) {
  if (typeof onLine !== 'function') return null;
  let buffered = '';
  return (chunk) => {
    buffered += chunk;
    const parts = buffered.split(/\r?\n/);
    buffered = parts.pop() || '';
    for (const line of parts) {
      const trimmed = line.trimEnd();
      if (trimmed) onLine(trimmed);
    }
  };
}

function runProcess(command, args, {
  cwd,
  env,
  timeoutMs = 10 * 60 * 1000,
  logger = console,
  onStdoutLine,
  onStderrLine
} = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, ...(env || {}) },
      stdio: ['ignore', 'pipe', 'pipe']
    });

    const stdoutLines = [];
    const stderrLines = [];
    const maxLines = 400; // keep recent output for debugging

    const pushLine = (arr, line) => {
      arr.push(line);
      if (arr.length > maxLines) arr.shift();
    };

    const emitStdout = createLineEmitter((line) => {
      pushLine(stdoutLines, line);
      onStdoutLine?.(line);
    });
    const emitStderr = createLineEmitter((line) => {
      pushLine(stderrLines, line);
      onStderrLine?.(line);
    });

    if (child.stdout) {
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk) => emitStdout?.(chunk));
    }
    if (child.stderr) {
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk) => emitStderr?.(chunk));
    }

    let timeoutHandle = null;
    if (timeoutMs && Number.isFinite(timeoutMs) && timeoutMs > 0) {
      timeoutHandle = setTimeout(() => {
        try {
          logger.error(`[process] timeout after ${timeoutMs}ms: ${command} ${args.join(' ')}`);
        } catch (_) {}
        child.kill('SIGKILL');
      }, timeoutMs);
    }

    child.on('error', (err) => {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      reject(err);
    });

    child.on('close', (code, signal) => {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      resolve({
        code: code ?? -1,
        signal: signal || null,
        stdout: stdoutLines.join('\n'),
        stderr: stderrLines.join('\n')
      });
    });
  });
}

async function runFfprobeDurationSeconds(inputPath, { timeoutMs, logger } = {}) {
  const args = [
    '-v', 'error',
    '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1',
    inputPath
  ];
  const result = await runProcess('ffprobe', args, {
    timeoutMs: timeoutMs || 2 * 60 * 1000,
    logger,
  });
  if (result.code !== 0) {
    throw new Error(`ffprobe failed (code=${result.code})`);
  }
  const raw = String(result.stdout || '').trim();
  const num = parseFloat(raw);
  if (!Number.isFinite(num)) {
    throw new Error(`ffprobe returned invalid duration: ${raw}`);
  }
  return num;
}

async function runFfmpeg(args, { timeoutMs, logger, onLine } = {}) {
  const result = await runProcess('ffmpeg', args, {
    timeoutMs: timeoutMs || 30 * 60 * 1000,
    logger,
    onStderrLine: onLine
  });
  if (result.code !== 0) {
    const tail = result.stderr ? `\n${result.stderr}` : '';
    throw new Error(`ffmpeg failed (code=${result.code})${tail}`);
  }
  return result;
}

module.exports = {
  runProcess,
  runFfprobeDurationSeconds,
  runFfmpeg
};
