// Author: Preston Lee

let workerShuttingDown = false;

export function markWorkerShuttingDown(): void {
  workerShuttingDown = true;
}

export function isWorkerShuttingDown(): boolean {
  return workerShuttingDown;
}
