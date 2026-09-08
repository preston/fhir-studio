// Author: Preston Lee

export type JobStatus = 'queued' | 'in_progress' | 'completed' | 'failed' | 'cancelled';

export type JobType =
  | 'TEST_JOB'
  | 'SANDBOX_PURGE'
  | 'PACKAGE_IMPORT'
  | 'BULK_EXPORT'
  | 'SYNTHETIC_DATA'
  | 'SANDBOX_DATA_SEED'
  | (string & {});

export interface BackgroundJob {
  id: string;
  name: string;
  jobType: string;
  status: JobStatus;
  progress: number;
  stage: string | null;
  input: Record<string, any>;
  output: Record<string, any>;
  error: string | null;
  startedAt: string | null;
  completedAt: string | null;
  cancelledAt: string | null;
  sandboxId: string | null;
  createdByUserId: string | null;
  createdAt: string;
  updatedAt: string;
  // Optional relations populated in enriched views
  sandbox?: {
    id: string;
    sandboxId: string;
    name: string;
    fhirVersion: string;
  } | null;
  createdByUser?: {
    id: string;
    email: string | null;
    displayName: string | null;
  } | null;
}

export interface JobSummary {
  total: number;
  queued: number;
  inProgress: number;
  completed: number;
  failed: number;
  cancelled: number;
}

export interface JobFilter {
  /** @deprecated Prefer `statuses` for multi-select filtering. */
  status?: JobStatus;
  statuses?: JobStatus[];
  jobType?: string;
  sandboxId?: string;
  createdByUserId?: string;
  search?: string;
  sortBy?: 'name' | 'jobType' | 'status' | 'progress' | 'createdAt' | 'startedAt' | 'completedAt';
  sortOrder?: 'asc' | 'desc';
  page?: number;
  limit?: number;
}

export interface CreateJobPayload {
  name: string;
  jobType: string;
  input?: Record<string, any>;
  sandboxId?: string;
}
