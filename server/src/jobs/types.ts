// Author: Preston Lee

import type { Job, PrismaClient } from '@prisma/client';
import type { HapiPartitionClient } from '../hapi/partition_client.js';

export interface JobExecutionContext {
  job: Job;
  signal: AbortSignal;
  prisma: PrismaClient;
  hapiClient: HapiPartitionClient;
  updateProgress: (progress: number, stage?: string) => Promise<void>;
  isCancelled: () => Promise<boolean>;
}

export type JobHandler = (ctx: JobExecutionContext) => Promise<Record<string, any> | void>;
