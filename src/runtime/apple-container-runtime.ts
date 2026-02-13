import { ChildProcess, exec, execSync, SpawnOptions, spawn } from 'child_process';

import type { ContainerRuntime } from './container-runtime.js';

export class AppleContainerRuntime implements ContainerRuntime {
  systemStatus(): void {
    execSync('container system status', { stdio: 'pipe' });
  }

  systemStart(timeoutMs: number): void {
    execSync('container system start', { stdio: 'pipe', timeout: timeoutMs });
  }

  listContainersJson(): string {
    return execSync('container ls --format json', {
      stdio: ['pipe', 'pipe', 'pipe'],
      encoding: 'utf-8',
    });
  }

  stopContainerSync(containerName: string): void {
    execSync(`container stop ${containerName}`, { stdio: 'pipe' });
  }

  stopContainerAsync(
    containerName: string,
    timeoutMs: number,
    callback: (err: Error | null) => void,
  ): void {
    exec(`container stop ${containerName}`, { timeout: timeoutMs }, (err) => {
      callback(err ?? null);
    });
  }

  spawnRun(args: string[], options: SpawnOptions): ChildProcess {
    return spawn('container', args, options);
  }
}
