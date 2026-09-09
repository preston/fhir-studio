// Author: Preston Lee

import { Injectable, inject, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable, tap } from 'rxjs';

export interface SandboxCollaborator {
  id: string;
  userId: string;
  role: string;
  user: {
    id: string;
    email: string | null;
    displayName: string | null;
  };
}

export interface Sandbox {
  id: string;
  sandboxId: string;
  name: string;
  description: string | null;
  fhirVersion: 'R4' | 'R4B' | 'R5';
  partitionId: number;
  allowOpenAccess: boolean;
  visibility: 'PUBLIC' | 'PRIVATE';
  isShared: boolean;
  createdByUserId: string;
  createdByUser?: {
    id: string;
    email: string | null;
    displayName: string | null;
  };
  collaborators?: SandboxCollaborator[];
  applications?: unknown[];
  launchScenarios?: unknown[];
  personas?: unknown[];
  cdsEndpoints?: unknown[];
  _count?: {
    applications?: number;
    launchScenarios: number;
    personas: number;
  };
  lastAccessedAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

@Injectable({
  providedIn: 'root',
})
export class SandboxService {
  private readonly http = inject(HttpClient);

  private readonly sandboxesState = signal<Sandbox[]>([]);
  private readonly activeSandboxState = signal<Sandbox | null>(null);
  private readonly loadingState = signal<boolean>(false);

  public readonly sandboxes = this.sandboxesState.asReadonly();
  public readonly activeSandbox = this.activeSandboxState.asReadonly();
  public readonly loading = this.loadingState.asReadonly();

  public getSandboxes(): Observable<{ sandboxes: Sandbox[] }> {
    this.loadingState.set(true);
    return this.http.get<{ sandboxes: Sandbox[] }>('/api/sandboxes').pipe(
      tap({
        next: (res) => {
          this.sandboxesState.set(res?.sandboxes || []);
          this.syncActiveSandbox(res?.sandboxes || []);
          this.loadingState.set(false);
        },
        error: () => {
          this.loadingState.set(false);
        },
      }),
    );
  }

  public getSandbox(sandboxId: string): Observable<{ sandbox: Sandbox }> {
    return this.http.get<{ sandbox: Sandbox }>(`/api/sandboxes/${sandboxId}`);
  }

  public checkSlugAvailability(slug: string): Observable<{ available: boolean; slug: string; reason?: string }> {
    return this.http.get<{ available: boolean; slug: string; reason?: string }>('/api/sandboxes/check-availability', {
      params: { slug },
    });
  }

  public createSandbox(data: {
    sandboxId: string;
    name: string;
    description?: string;
    fhirVersion?: 'R4' | 'R4B' | 'R5';
    allowOpenAccess?: boolean;
    visibility?: 'PUBLIC' | 'PRIVATE';
    isShared?: boolean;
    seedData?: boolean;
  }): Observable<{ sandbox: Sandbox }> {
    return this.http.post<{ sandbox: Sandbox }>('/api/sandboxes', data);
  }

  public updateSandbox(
    sandboxId: string,
    data: {
      name?: string;
      description?: string;
      allowOpenAccess?: boolean;
      visibility?: 'PUBLIC' | 'PRIVATE';
      isShared?: boolean;
    },
  ): Observable<{ sandbox: Sandbox }> {
    return this.http.put<{ sandbox: Sandbox }>(`/api/sandboxes/${sandboxId}`, data);
  }

  public resetSandbox(sandboxId: string): Observable<{ message: string }> {
    return this.http.post<{ message: string }>(`/api/sandboxes/${sandboxId}/reset`, {});
  }

  public deleteSandbox(sandboxId: string): Observable<{ message: string; job?: { id: string } }> {
    return this.http.delete<{ message: string; job?: { id: string } }>(`/api/sandboxes/${sandboxId}`);
  }

  public addCollaborator(
    sandboxId: string,
    email: string,
    role = 'READ_WRITE',
  ): Observable<{ collaborator: SandboxCollaborator }> {
    return this.http.post<{ collaborator: SandboxCollaborator }>(`/api/sandboxes/${sandboxId}/collaborators`, {
      email,
      role,
    });
  }

  public removeCollaborator(sandboxId: string, userId: string): Observable<{ message: string }> {
    return this.http.delete<{ message: string }>(
      `/api/sandboxes/${sandboxId}/collaborators/${userId}`,
    );
  }

  public recordAccess(sandboxId: string): Observable<{ message: string }> {
    return this.http.post<{ message: string }>(`/api/sandboxes/${sandboxId}/access`, {});
  }

  public selectSandbox(sandbox: Sandbox | string | null): void {
    if (!sandbox) {
      this.activeSandboxState.set(null);
      localStorage.removeItem('activeSandboxId');
      return;
    }

    let targetId = '';
    if (typeof sandbox === 'string') {
      targetId = sandbox;
      const match = this.sandboxesState().find((s) => s.sandboxId === sandbox);
      if (match) {
        this.activeSandboxState.set(match);
        localStorage.setItem('activeSandboxId', match.sandboxId);
      }
    } else {
      targetId = sandbox.sandboxId;
      this.activeSandboxState.set(sandbox);
      localStorage.setItem('activeSandboxId', sandbox.sandboxId);
    }

    if (targetId) {
      this.recordAccess(targetId).subscribe({ error: () => {} });
    }
  }

  private syncActiveSandbox(sandboxes: Sandbox[]): void {
    if (sandboxes.length === 0) {
      this.activeSandboxState.set(null);
      return;
    }

    const current = this.activeSandboxState();
    const savedId = localStorage.getItem('activeSandboxId');

    if (current) {
      const stillExists = sandboxes.find((s) => s.sandboxId === current.sandboxId);
      if (stillExists) {
        this.activeSandboxState.set(stillExists);
        return;
      }
    }

    if (savedId) {
      const found = sandboxes.find((s) => s.sandboxId === savedId);
      if (found) {
        this.activeSandboxState.set(found);
        return;
      }
    }

    this.activeSandboxState.set(sandboxes[0]);
    localStorage.setItem('activeSandboxId', sandboxes[0].sandboxId);
  }
}
