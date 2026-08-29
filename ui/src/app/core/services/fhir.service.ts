// Author: Preston Lee

import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { Observable, of, tap } from 'rxjs';
import type { FhirCapabilityStatement, FhirRelease } from '@fhir-studio/core';

export interface FhirBundleEntry<T = Record<string, unknown>> {
  resource: T;
  fullUrl?: string;
  request?: {
    method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
    url: string;
  };
  response?: {
    status: string;
    location?: string;
  };
}

export interface FhirBundle<T = Record<string, unknown>> {
  resourceType: 'Bundle';
  type?: string;
  total?: number;
  entry?: Array<FhirBundleEntry<T>>;
  link?: Array<{ relation: string; url: string }>;
}

export interface FhirOperationOutcomeIssue {
  severity: 'fatal' | 'error' | 'warning' | 'information';
  code: string;
  details?: { text?: string };
  diagnostics?: string;
  location?: string[];
  expression?: string[];
}

export interface FhirOperationOutcome {
  resourceType: 'OperationOutcome';
  id?: string;
  issue: FhirOperationOutcomeIssue[];
}

@Injectable({
  providedIn: 'root',
})
export class FhirService {
  private readonly http = inject(HttpClient);

  private getEndpoint(sandboxId: string, version: FhirRelease | string): string {
    return `/api/sandboxes/${sandboxId}/fhir/${version.toLowerCase()}`;
  }

  private readonly capabilityCache = new Map<string, FhirCapabilityStatement>();

  public getCapabilityStatement(
    sandboxId: string,
    version: FhirRelease | string,
    forceRefresh = false,
  ): Observable<FhirCapabilityStatement> {
    const cacheKey = `${sandboxId}:${version.toLowerCase()}`;
    if (!forceRefresh && this.capabilityCache.has(cacheKey)) {
      return of(this.capabilityCache.get(cacheKey)!);
    }
    const url = `${this.getEndpoint(sandboxId, version)}/metadata`;
    return this.http.get<FhirCapabilityStatement>(url).pipe(
      tap((cs) => {
        this.capabilityCache.set(cacheKey, cs);
      }),
    );
  }

  public clearCapabilityCache(): void {
    this.capabilityCache.clear();
  }

  public search<T = Record<string, unknown>>(
    sandboxId: string,
    version: FhirRelease | string,
    resourceType: string,
    params?: Record<string, string | number>,
  ): Observable<FhirBundle<T>> {
    const url = `${this.getEndpoint(sandboxId, version)}/${resourceType}`;
    let httpParams = new HttpParams();
    if (params) {
      for (const [key, value] of Object.entries(params)) {
        httpParams = httpParams.set(key, String(value));
      }
    }
    return this.http.get<FhirBundle<T>>(url, { params: httpParams });
  }

  public getResource<T = Record<string, unknown>>(
    sandboxId: string,
    version: FhirRelease | string,
    resourceType: string,
    id: string,
  ): Observable<T> {
    const url = `${this.getEndpoint(sandboxId, version)}/${resourceType}/${id}`;
    return this.http.get<T>(url);
  }

  public createResource<T = Record<string, unknown>>(
    sandboxId: string,
    version: FhirRelease | string,
    resourceType: string,
    body: T,
  ): Observable<T> {
    const url = `${this.getEndpoint(sandboxId, version)}/${resourceType}`;
    return this.http.post<T>(url, body);
  }

  public updateResource<T = Record<string, unknown>>(
    sandboxId: string,
    version: FhirRelease | string,
    resourceType: string,
    id: string,
    body: T,
  ): Observable<T> {
    const url = `${this.getEndpoint(sandboxId, version)}/${resourceType}/${id}`;
    return this.http.put<T>(url, body);
  }

  public deleteResource<T = Record<string, unknown>>(
    sandboxId: string,
    version: FhirRelease | string,
    resourceType: string,
    id: string,
  ): Observable<T> {
    const url = `${this.getEndpoint(sandboxId, version)}/${resourceType}/${id}`;
    return this.http.delete<T>(url);
  }

  public postTransaction<T = Record<string, unknown>, R = FhirBundle>(
    sandboxId: string,
    version: FhirRelease | string,
    bundle: T,
  ): Observable<R> {
    const url = `${this.getEndpoint(sandboxId, version)}/`;
    return this.http.post<R>(url, bundle);
  }

  public validateResource<T = Record<string, unknown>>(
    sandboxId: string,
    version: FhirRelease | string,
    resourceType: string,
    body: T,
  ): Observable<FhirOperationOutcome> {
    const url = `${this.getEndpoint(sandboxId, version)}/${resourceType}/$validate`;
    return this.http.post<FhirOperationOutcome>(url, body);
  }
}
