export type HostedChannel = 'preview' | 'published';
export type HostingAction =
  | 'suspend'
  | 'resume'
  | 'unpublish'
  | 'trash'
  | 'restore'
  | 'purge'
  | 'protect'
  | 'unprotect'
  | 'reassign';
export interface HostingUsagePoint {
  hour: string;
  channel: HostedChannel;
  requests: number;
  documents: number;
  bots: number;
  status2xx: number;
  status3xx: number;
  status4xx: number;
  status5xx: number;
  rateLimited: number;
  aborted: number;
  bytes: string;
  durationMs: number;
  launches: number;
}
export interface HostingUsageReport {
  points: HostingUsagePoint[];
  totals: Omit<HostingUsagePoint, 'hour' | 'channel'>;
  visitors: { preview: number; published: number } | null;
  averageResponseMs: number;
  p95ResponseMs: number | null;
  collectors: Array<{
    id: string;
    kind: string;
    lastFlushedAt: string;
    dropped: number;
  }>;
}
export interface HostingInventoryItem {
  id: string;
  name: string;
  repository: string;
  ownerUserId: string;
  owner: {
    email: string | null;
    displayName: string | null;
    isSuspended: boolean;
  };
  suspended: boolean;
  suspendedAt: string | null;
  deletedAt: string | null;
  deleteAfter: string | null;
  cleanupProtected: boolean;
  previewBuildId: string | null;
  publishedBuildId: string | null;
  lastDeveloperActivityAt: string;
  lastServedAt: string | null;
  lastLaunchAt: string | null;
  lastReconciledAt: string | null;
  reconciliationError: string | null;
  createdAt: string;
  storageBytes: string;
  reservedBytes: string;
  sandboxCount: number;
  latestBuild: {
    id: string;
    status: string;
    error: string | null;
    createdAt: string;
  } | null;
  issues: string[];
  abandonmentCandidate: boolean;
}
export interface HostingInventoryReport {
  applications: HostingInventoryItem[];
  total: number;
  page: number;
  limit: number;
}
export interface HostingOwnerReport {
  userId: string;
  email: string | null;
  displayName: string | null;
  isSuspended: boolean;
  applications: number;
  storageBytes: string;
  trashBytes: string;
  reservedBytes: string;
  applicationLimit: number | null;
  effectiveApplicationLimit: number;
  storageBytesLimit: string | null;
}
export interface HostingActionRequest {
  ids: string[];
  action: HostingAction;
  reason: string;
  ownerUserId?: string;
  expectedGenerations?: Record<string, number>;
}
export interface HostingActionResult {
  id: string;
  success: boolean;
  error?: string;
}
export interface HostingActionPreview {
  applications: Array<{
    id: string;
    name: string;
    generation: number;
    storageBytes: string;
    error?: string;
  }>;
  storageBytes: string;
}
export type JobScheduleFrequency = 'EVERY_MINUTE' | 'HOURLY' | 'DAILY';
export interface JobScheduleRecord {
  id: string;
  name: string;
  description: string;
  jobType: string;
  input: Record<string, unknown>;
  frequency: JobScheduleFrequency;
  minuteOfHour: number;
  hourOfDay: number;
  enabled: boolean;
  nextRunAt: string;
  lastRunAt: string | null;
}
export interface ScheduledJobType {
  jobType: string;
  description: string;
  defaults: Record<string, unknown>;
}
