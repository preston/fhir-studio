export type ApplicationCollaboratorRole = 'MANAGE' | 'READ_WRITE' | 'READ_ONLY';
export interface ApplicationCapabilities {
  read: boolean;
  develop: boolean;
  publish: boolean;
  manageCollaborators: boolean;
  own: boolean;
}
export interface HostedApplication {
  id: string;
  name: string;
  description: string;
  ownerUserId: string;
  transferToUserId?: string | null;
  repositoryId: string;
  repository: string;
  installationId: string;
  branch: string;
  projectDirectory: string;
  buildCommand: string;
  outputDirectory: string;
  nodeVersion: string;
  launchPath: string;
  callbackPath: string;
  scope: string;
  autoPublish: boolean;
  publishingPaused: boolean;
  suspended: boolean;
  isTemplate: boolean;
  templateVisibility: 'PRIVATE' | 'PUBLIC';
  templateCommit: string | null;
  previewBuildId: string | null;
  publishedBuildId: string | null;
  desiredBuildId: string | null;
  previewUrl: string;
  publishedUrl: string;
  capabilities: ApplicationCapabilities;
  collaborators: Array<{
    userId: string;
    role: ApplicationCollaboratorRole;
    user: { email: string | null; displayName: string | null };
  }>;
  builds: HostedBuild[];
}
export interface HostedBuild {
  id: string;
  branch: string;
  commit: string;
  runId: string | null;
  runAttempt: number;
  status: string;
  error: string | null;
  githubUrl: string | null;
  createdAt: string;
  requestedByUserId: string | null;
  githubActor: string | null;
  launchPath: string;
  callbackPath: string;
  scope: string;
}
export interface GitHubConnectionStatus {
  login?: string;
  status?: string;
  expiresAt?: string;
  installations?: Array<{
    id: number;
    account: { login: string };
    suspended_at: string | null;
  }>;
  installUrl?: string;
}
export interface RepositoryFile {
  path: string;
  content: string;
}
export interface RepositorySnapshot {
  commit: string;
  branch: string;
  files: Array<{ path: string; size: number }>;
}
