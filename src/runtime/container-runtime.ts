import { ChildProcess, SpawnOptions } from 'child_process';
import { AppleContainerRuntime } from './apple-container-runtime.js';
import { DockerContainerRuntime } from './docker-container-runtime.js';

export interface ContainerRuntime {
  systemStatus(): void;
  systemStart(timeoutMs: number): void;
  listContainersJson(): string;
  stopContainerSync(containerName: string): void;
  stopContainerAsync(
    containerName: string,
    timeoutMs: number,
    callback: (err: Error | null) => void,
  ): void;
  spawnRun(args: string[], options: SpawnOptions): ChildProcess;
}

export type ContainerEngine = 'apple' | 'docker';

export function resolveContainerEngine(
  platform: NodeJS.Platform = process.platform,
  envValue: string | undefined = process.env.CONTAINER_ENGINE,
): ContainerEngine {
  const normalized = envValue?.trim().toLowerCase();
  if (normalized === 'docker') return 'docker';
  if (normalized === 'apple') return 'apple';
  return platform === 'linux' ? 'docker' : 'apple';
}

export function createContainerRuntime(
  platform: NodeJS.Platform = process.platform,
  envValue: string | undefined = process.env.CONTAINER_ENGINE,
): ContainerRuntime {
  const engine = resolveContainerEngine(platform, envValue);
  return engine === 'docker'
    ? new DockerContainerRuntime()
    : new AppleContainerRuntime();
}
