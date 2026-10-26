// Author: Preston Lee

import { importCatalogArtifact, createEditableProject } from '../integrations/artifacts.js';
import { maintenanceHandler, adminActionHandler } from '../hosted/maintenance.js';
import { jobDefinitions } from './definitions.js';
import type { JobHandler } from './types.js';
import { testJobHandler } from './handlers/testJob.js';
import { sandboxPurgeHandler } from './handlers/sandboxPurge.js';
import { packageImportHandler } from './handlers/packageImport.js';
import { sandboxDataSeedHandler } from './handlers/sandboxDataSeed.js';
import { importBuild, reconcileJob } from '../hosted/builds.js';

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
  for (const definition of jobDefinitions) if (definition.jobType.startsWith('HOSTED_')) registerHandler(definition.jobType, maintenanceHandler);
  registerHandler('HOSTED_ADMIN_ACTION', adminActionHandler);
  registerHandler('HOSTED_IMPORT', importBuild);
  registerHandler('INTEGRATION_ARTIFACT_IMPORT', importCatalogArtifact);
  registerHandler('INTEGRATION_EDITABLE', createEditableProject);
  registerHandler('HOSTED_RECONCILE', reconcileJob);
  registerHandler('SANDBOX_PURGE', sandboxPurgeHandler);
  registerHandler('PACKAGE_IMPORT', packageImportHandler);
  registerHandler('SANDBOX_DATA_SEED', sandboxDataSeedHandler);
}
