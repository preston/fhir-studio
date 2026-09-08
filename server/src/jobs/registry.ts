// Author: Preston Lee

import type { JobHandler } from './types.js';
import { testJobHandler } from './handlers/testJob.js';
import { sandboxPurgeHandler } from './handlers/sandboxPurge.js';
import { packageImportHandler } from './handlers/packageImport.js';
import { sandboxDataSeedHandler } from './handlers/sandboxDataSeed.js';

const handlers = new Map<string, JobHandler>();
let initialized = false;

export function registerHandler(jobType: string, handler: JobHandler): void {
  handlers.set(jobType.toUpperCase(), handler);
}

export function getHandler(jobType: string): JobHandler | undefined {
  return handlers.get(jobType.toUpperCase());
}

export function initializeJobs(): void {
  if (initialized) return;
  initialized = true;

  registerHandler('TEST_JOB', testJobHandler);
  registerHandler('SANDBOX_PURGE', sandboxPurgeHandler);
  registerHandler('PACKAGE_IMPORT', packageImportHandler);
  registerHandler('SANDBOX_DATA_SEED', sandboxDataSeedHandler);
}
