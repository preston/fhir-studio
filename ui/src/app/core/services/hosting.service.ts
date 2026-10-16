import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import type {
  HostedApplication,
  GitHubConnectionStatus,
  RepositorySnapshot,
} from '@fhir-studio/core';

export interface GitHubRepository {
  id: number;
  full_name: string;
  default_branch: string;
  private: boolean;
}
export interface AppTemplate {
  id: string;
  name: string;
  description?: string;
  templateCommit?: string;
  projectDirectory?: string;
  buildCommand?: string;
  outputDirectory?: string;
  nodeVersion?: string;
  launchPath?: string;
  callbackPath?: string;
  scope?: string;
}
@Injectable({ providedIn: 'root' })
export class HostingService {
  private readonly http = inject(HttpClient);
  get<T>(path: string): Promise<T> {
    return firstValueFrom(this.http.get<T>(path));
  }
  post<T = unknown>(path: string, body: unknown = {}): Promise<T> {
    return firstValueFrom(this.http.post<T>(path, body));
  }
  patch(path: string, body: unknown): Promise<unknown> {
    return firstValueFrom(this.http.patch(path, body));
  }
  put(path: string, body: unknown): Promise<unknown> {
    return firstValueFrom(this.http.put(path, body));
  }
  delete(path: string): Promise<unknown> {
    return firstValueFrom(this.http.delete(path));
  }
  connection(): Promise<GitHubConnectionStatus> {
    return this.get('/api/github/connection');
  }
  list(): Promise<{ applications: HostedApplication[] }> {
    return this.get('/api/hosted-applications');
  }
  application(id: string): Promise<HostedApplication> {
    return this.get(`/api/hosted-applications/${id}`);
  }
  snapshot(id: string, branch: string): Promise<RepositorySnapshot> {
    return this.get(
      `/api/hosted-applications/${id}/source?branch=${encodeURIComponent(branch)}`,
    );
  }
}
