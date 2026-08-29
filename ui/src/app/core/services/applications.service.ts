// Author: Preston Lee

import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';

export interface SmartApplication {
  id: string;
  sandboxId: string | null;
  clientId: string;
  clientSecret: string | null;
  clientName: string;
  launchUri: string;
  redirectUris: string[];
  scope: string;
  isCustom: boolean;
  isSample: boolean;
  briefDescription?: string | null;
  author?: string | null;
  clientUri?: string | null;
  logoUri?: string | null;
  samplePatients?: string | null;
  manifestUrl?: string | null;
  createdAt: string;
  updatedAt: string;
}

@Injectable({
  providedIn: 'root',
})
export class ApplicationsService {
  private readonly http = inject(HttpClient);

  public getGlobalApplications(): Observable<{ applications: SmartApplication[] }> {
    return this.http.get<{ applications: SmartApplication[] }>('/api/applications');
  }

  public getSandboxApplications(sandboxId: string): Observable<{ applications: SmartApplication[] }> {
    return this.http.get<{ applications: SmartApplication[] }>(`/api/sandboxes/${sandboxId}/applications`);
  }

  public registerApplication(
    sandboxId: string,
    data: {
      clientName: string;
      launchUri: string;
      redirectUris: string[];
      scope?: string;
      briefDescription?: string;
      author?: string;
      clientUri?: string;
      logoUri?: string;
      isCustom?: boolean;
    },
  ): Observable<{ application: SmartApplication }> {
    return this.http.post<{ application: SmartApplication }>(`/api/sandboxes/${sandboxId}/applications`, data);
  }

  public updateApplication(
    sandboxId: string,
    applicationId: string,
    data: Partial<SmartApplication>,
  ): Observable<{ application: SmartApplication }> {
    return this.http.put<{ application: SmartApplication }>(`/api/sandboxes/${sandboxId}/applications/${applicationId}`, data);
  }

  public deleteApplication(sandboxId: string, applicationId: string): Observable<{ message: string }> {
    return this.http.delete<{ message: string }>(`/api/sandboxes/${sandboxId}/applications/${applicationId}`);
  }
}
