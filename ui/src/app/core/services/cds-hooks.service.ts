// Author: Preston Lee

import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import type { CdsHookFeedbackPayload, CdsHookCard, CdsHookSystemAction, CdsServiceDefinition } from '@fhir-studio/core';

export interface CdsEndpoint {
  id: string;
  sandboxId: string;
  name: string;
  url: string;
  servicesJson: CdsServiceDefinition[];
  createdAt: string;
  updatedAt: string;
}

@Injectable({
  providedIn: 'root',
})
export class CdsHooksService {
  private readonly http = inject(HttpClient);

  public getEndpoints(sandboxId: string): Observable<{ endpoints: CdsEndpoint[] }> {
    return this.http.get<{ endpoints: CdsEndpoint[] }>(
      `/api/sandboxes/${sandboxId}/cds-services`,
    );
  }

  public registerEndpoint(
    sandboxId: string,
    data: { name: string; url: string },
  ): Observable<{ endpoint: CdsEndpoint }> {
    return this.http.post<{ endpoint: CdsEndpoint }>(
      `/api/sandboxes/${sandboxId}/cds-services`,
      data,
    );
  }

  public deleteEndpoint(sandboxId: string, id: string): Observable<{ message: string }> {
    return this.http.delete<{ message: string }>(
      `/api/sandboxes/${sandboxId}/cds-services/${id}`,
    );
  }

  public invokeHookProxy(
    sandboxId: string,
    payload: {
      serviceUrl: string;
      hook: string;
      hookInstance: string;
      context: Record<string, unknown>;
      prefetch?: Record<string, unknown>;
      prefetchTemplates?: Record<string, string>;
    },
  ): Observable<{ cards: CdsHookCard[]; systemActions?: CdsHookSystemAction[] }> {
    return this.http.post<{ cards: CdsHookCard[]; systemActions?: CdsHookSystemAction[] }>(
      `/api/sandboxes/${sandboxId}/cds-services/proxy`,
      payload,
    );
  }

  public submitFeedback(
    sandboxId: string,
    feedbackUrl: string,
    feedback: CdsHookFeedbackPayload,
  ): Observable<{ status: string }> {
    return this.http.post<{ status: string }>(
      `/api/sandboxes/${sandboxId}/cds-services/feedback`,
      { feedbackUrl, feedback },
    );
  }
}
