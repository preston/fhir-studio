// Author: Preston Lee

import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import type { SmartApplication } from './applications.service.js';
import type { UserPersona } from './personas.service.js';

export interface LaunchScenario {
  id: string;
  sandboxId: string;
  title: string;
  description: string | null;
  applicationId: string | null;
  userPersonaId: string | null;
  patientFhirId: string | null;
  patientName: string | null;
  encounterFhirId: string | null;
  locationFhirId: string | null;
  intent: string | null;
  smartStyleUrl: string | null;
  needPatientBanner: boolean;
  contextParams: Record<string, string>;
  lastLaunchAt: string | null;
  application?: SmartApplication | null;
  userPersona?: UserPersona | null;
  createdAt: string;
  updatedAt: string;
}

@Injectable({
  providedIn: 'root',
})
export class ScenariosService {
  private readonly http = inject(HttpClient);

  public getScenarios(sandboxId: string): Observable<{ scenarios: LaunchScenario[] }> {
    return this.http.get<{ scenarios: LaunchScenario[] }>(`/api/sandboxes/${sandboxId}/scenarios`);
  }

  public createScenario(
    sandboxId: string,
    data: Partial<LaunchScenario>,
  ): Observable<{ scenario: LaunchScenario }> {
    return this.http.post<{ scenario: LaunchScenario }>(`/api/sandboxes/${sandboxId}/scenarios`, data);
  }

  public updateScenario(
    sandboxId: string,
    scenarioId: string,
    data: Partial<LaunchScenario>,
  ): Observable<{ scenario: LaunchScenario }> {
    return this.http.put<{ scenario: LaunchScenario }>(
      `/api/sandboxes/${sandboxId}/scenarios/${scenarioId}`,
      data,
    );
  }

  public deleteScenario(sandboxId: string, scenarioId: string): Observable<{ message: string }> {
    return this.http.delete<{ message: string }>(
      `/api/sandboxes/${sandboxId}/scenarios/${scenarioId}`,
    );
  }

  public createLaunchContext(
    sandboxId: string,
    data: {
      patientFhirId?: string | null;
      patientName?: string | null;
      encounterFhirId?: string | null;
      locationFhirId?: string | null;
      userPersonaId?: string | null;
      applicationId?: string | null;
      clientId?: string;
      scope?: string;
      fhirContext?: unknown;
    },
  ): Observable<{ launch: string; sandboxId: string; expiresIn: number }> {
    return this.http.post<{ launch: string; sandboxId: string; expiresIn: number }>(
      `/api/sandboxes/${sandboxId}/launch-context`,
      data,
    );
  }
}
