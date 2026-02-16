import readline from 'readline';
import { spawn } from 'child_process';

function safeEnvSnapshot() {
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

  const secretKeys = ['OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'BRAVE_SEARCH_API_KEY'];
  for (const sk of secretKeys) {
    if (process.env[sk]) rows.push(`${sk}=(set)`);
  }

  return rows;
}

function isDebugMode(): boolean {
  return process.argv.includes('--debug') || process.env.CHUCK_DEBUG === '1';
}

function isQuitCommand(raw: string): boolean {
  const t = raw.trim().toLowerCase();
  return t === 'q' || t === 'quit' || t === 'exit' || t === '/q' || t === '/quit' || t === '/exit';
}

function stripDevOutboundPrefix(line: string): string | null {
  const prefix = '[DEV OUTBOUND dev@local] ';
  if (line.startsWith(prefix)) return line.slice(prefix.length);
  return null;
}

function looksFatal(line: string): boolean {
  const t = line.toLowerCase();
  return t.includes('failed to start') || t.includes('uncaught') || t.includes('fatal');
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

  const env = { ...process.env };
  if (!env.ASSISTANT_NAME) env.ASSISTANT_NAME = 'Chuck';

  if (debug) {
    process.stdout.write('[Enter] Start Chuck   |   (q) Quit\n');

    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.on('line', (line) => {
      if (isQuitCommand(line)) {
        rl.close();
        process.exit(0);
      }

      rl.close();

      const child = spawn('node', ['dist/index.js'], {
        stdio: 'inherit',
        env,
      });

      child.on('exit', (code: number | null, signal: NodeJS.Signals | null) => {
        if (signal) process.exit(1);
        process.exit(code ?? 0);
      });
    });

    return;
  }

  const child = spawn('node', ['dist/index.js'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env,
  });

  if (!child.stdin || !child.stdout || !child.stderr) {
    process.stderr.write('[chuck] Failed to start host: missing stdio pipes\n');
    process.exit(1);
  }

  let awaitingResponse = false;

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.setPrompt('You> ');

  process.stdout.write('Chat ready. Type your request. Use /quit to exit.\n\n');
  rl.prompt();

  const handleLine = (line: string) => {
    if (isQuitCommand(line)) {
      rl.close();
      try { child.kill('SIGINT'); } catch { }
      return;
    }

    const msg = line.trim();
    if (!msg || awaitingResponse) return;

    awaitingResponse = true;
    child.stdin!.write(msg + '\n');
  };

  rl.on('line', handleLine);

  const consume = (chunk: Buffer) => {
    const text = chunk.toString();
    const lines = text.split('\n');

    for (const ln of lines) {
      const line = ln.trimEnd();
      if (!line.trim()) continue;

      const outbound = stripDevOutboundPrefix(line);
      if (outbound !== null) {
        process.stdout.write(`Chuck> ${outbound}\n`);
        awaitingResponse = false;
        rl.prompt();
        continue;
      }

      if (looksFatal(line)) {
        process.stderr.write(`[chuck] ${line}\n`);
      }
    }
  };

  child.stdout.on('data', consume);
  child.stderr.on('data', consume);

  child.on('exit', (code: number | null, signal: NodeJS.Signals | null) => {
    if (signal) {
      process.stderr.write(`[chuck] Host exited via signal: ${signal}\n`);
      process.exit(1);
    }
    process.stderr.write(`[chuck] Host exited with code: ${code ?? 0}\n`);
    process.exit(code ?? 0);
  });

  rl.on('close', () => {
    try { child.kill('SIGINT'); } catch { }
  });
}

main().catch((err) => {
  console.error('[chuck] Failed to start:', err?.message ?? err);
  process.exit(1);
});
