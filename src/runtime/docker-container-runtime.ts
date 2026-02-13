import { ChildProcess, exec, execSync, SpawnOptions, spawn } from 'child_process';

import type { ContainerRuntime } from './container-runtime.js';

export class DockerContainerRuntime implements ContainerRuntime {
  systemStatus(): void {
    execSync('docker info', { stdio: 'pipe' });
  }

  systemStart(_timeoutMs: number): void {
    // Docker daemon startup is managed by the host/service manager.
    // Keep this as a no-op to match the interface.
  }

  listContainersJson(): string {
    const output = execSync(
      'docker ps --filter name=^nanoclaw- --format "{{json .}}"',
      {
        stdio: ['pipe', 'pipe', 'pipe'],
        encoding: 'utf-8',
      },
    );

    const containers = output
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { Names?: string; Status?: string })
      .map((container) => ({
        status:
          container.Status && container.Status.startsWith('Up')
            ? 'running'
            : 'stopped',
        configuration: { id: container.Names || '' },
      }));

    return JSON.stringify(containers);
  }

  stopContainerSync(containerName: string): void {
    execSync(`docker stop ${containerName}`, { stdio: 'pipe' });
  }

  stopContainerAsync(
    containerName: string,
    timeoutMs: number,
    callback: (err: Error | null) => void,
  ): void {
    exec(`docker stop ${containerName}`, { timeout: timeoutMs }, (err) => {
      callback(err ?? null);
    });
  }

  spawnRun(args: string[], options: SpawnOptions): ChildProcess {
    return spawn('docker', args, options);
  }
}
