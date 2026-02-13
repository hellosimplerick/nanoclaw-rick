import { ChildProcess, SpawnOptions } from 'child_process';

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
