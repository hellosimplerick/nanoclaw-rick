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

async function main() {
  // Minimal TUI stub (no extra deps): just a prompt loop.
  // Future: replace with a real TUI library once behavior is stable.
  process.stdout.write('\n');
  process.stdout.write('╔══════════════════════════════════╗\n');
  process.stdout.write('║              CHUCK               ║\n');
  process.stdout.write('╚══════════════════════════════════╝\n\n');

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
      return;
    }

    // Start the existing compiled entrypoint.
    rl.close();

    const env = { ...process.env };
    if (!env.ASSISTANT_NAME) env.ASSISTANT_NAME = 'Chuck';

    const child = spawn('node', ['dist/index.js'], {
      stdio: 'inherit',
      env,
    });

    child.on('exit', (code, signal) => {
      if (signal) {
        process.exit(1);
      }
      process.exit(code ?? 0);
    });
  });
}

main().catch((err) => {
  // Keep it blunt; no stack spam unless LOG_LEVEL is debug.
  console.error('[chuck] Failed to start:', err?.message ?? err);
  process.exit(1);
});
