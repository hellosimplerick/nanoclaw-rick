import readline from 'readline';
import { spawn } from 'child_process';

function safeEnvSnapshot() {
  // Show useful runtime knobs without leaking secrets.
  const keys = [
    'ASSISTANT_NAME',
    'CHANNEL',
    'CONTAINER_ENGINE',
    'LLM_PROVIDER',
    'LLM_MODEL',
    'OPENROUTER_BASE_URL',
    'OPENAI_BASE_URL',
    'LOG_LEVEL',
  ] as const;

  const rows = keys.map((k) => {
    const v = process.env[k] ?? '';
    return `${k}=${v}`;
  });

  // Explicitly do NOT print known secret vars even if present.
  const secretKeys = ['OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'BRAVE_SEARCH_API_KEY'];
  for (const sk of secretKeys) {
    if (process.env[sk]) rows.push(`${sk}=(set)`);
  }

  return rows;
}

function isDebugMode(): boolean {
  return process.argv.includes('--debug') || process.env.CHUCK_DEBUG === '1';
}

function shouldShowLine(line: string): boolean {
  // Normal mode filtering rules:
  // - Drop DEBUG
  // - Keep INFO/WARN/ERROR and key lifecycle lines
  if (line.includes('DEBUG')) return false;

  return (
    line.includes('INFO') ||
    line.includes('WARN') ||
    line.includes('ERROR') ||
    line.includes('NanoClaw running') ||
    line.includes('Shutdown signal received') ||
    line.includes('Send success') ||
    line.includes('Send failed')
  );
}

async function main() {
  const debug = isDebugMode();

  process.stdout.write('\n');
  process.stdout.write('╔══════════════════════════════════╗\n');
  process.stdout.write('║              CHUCK               ║\n');
  process.stdout.write('╚══════════════════════════════════╝\n\n');

  process.stdout.write(`Mode: ${debug ? 'debug' : 'normal'}\n\n`);

  process.stdout.write('Config (non-secret):\n');
  for (const line of safeEnvSnapshot()) process.stdout.write(`  - ${line}\n`);

  process.stdout.write('\n');
  process.stdout.write('[Enter] Start Chuck   |   (q) Quit\n');

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  rl.on('line', (line) => {
    const trimmed = line.trim().toLowerCase();
    if (trimmed === 'q' || trimmed === 'quit' || trimmed === 'exit') {
      rl.close();
      process.exit(0);
    }

    // Start the existing compiled entrypoint.
    rl.close();

    const env = { ...process.env };
    if (!env.ASSISTANT_NAME) env.ASSISTANT_NAME = 'Chuck';

    // Spawn NanoClaw host:
    // - debug: inherit everything (full firehose)
    // - normal: keep stdin interactive, but filter stdout/stderr
    let child: ReturnType<typeof spawn>;

    if (debug) {
      child = spawn('node', ['dist/index.js'], {
        stdio: 'inherit',
        env,
      });
    } else {
      // Node typings dislike readonly tuples here; use a mutable array.
      const stdio: any = ['inherit', 'pipe', 'pipe'];

      child = spawn('node', ['dist/index.js'], {
        stdio,
        env,
      });

      const filterWrite = (data: Buffer) => {
        const text = data.toString();
        const lines = text.split('\n');

        for (const ln of lines) {
          if (!ln.trim()) continue;
          if (shouldShowLine(ln)) process.stdout.write(ln + '\n');
        }
      };

      if (child.stdout) child.stdout.on('data', filterWrite);
      if (child.stderr) child.stderr.on('data', filterWrite);
    }

    child.on('exit', (code: number | null, signal: NodeJS.Signals | null) => {
      if (signal) process.exit(1);
      process.exit(code ?? 0);
    });
  });
}

main().catch((err) => {
  console.error('[chuck] Failed to start:', err?.message ?? err);
  process.exit(1);
});
