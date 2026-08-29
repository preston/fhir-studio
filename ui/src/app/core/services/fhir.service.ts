// Author: Preston Lee

import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { Observable } from 'rxjs';

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

  private getEndpoint(sandboxId: string, version = 'r4'): string {
    return `/api/sandboxes/${sandboxId}/fhir/${version.toLowerCase()}`;
  }

  public getCapabilityStatement<T = Record<string, unknown>>(sandboxId: string, version = 'r4'): Observable<T> {
    const url = `${this.getEndpoint(sandboxId, version)}/metadata`;
    return this.http.get<T>(url);
  }

  public search<T = Record<string, unknown>>(
    sandboxId: string,
    version = 'r4',
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
    version = 'r4',
    resourceType: string,
    id: string,
  ): Observable<T> {
    const url = `${this.getEndpoint(sandboxId, version)}/${resourceType}/${id}`;
    return this.http.get<T>(url);
  }

  public createResource<T = Record<string, unknown>>(
    sandboxId: string,
    version = 'r4',
    resourceType: string,
    body: T,
  ): Observable<T> {
    const url = `${this.getEndpoint(sandboxId, version)}/${resourceType}`;
    return this.http.post<T>(url, body);
  }

  public updateResource<T = Record<string, unknown>>(
    sandboxId: string,
    version = 'r4',
    resourceType: string,
    id: string,
    body: T,
  ): Observable<T> {
    const url = `${this.getEndpoint(sandboxId, version)}/${resourceType}/${id}`;
    return this.http.put<T>(url, body);
  }

  public deleteResource<T = Record<string, unknown>>(
    sandboxId: string,
    version = 'r4',
    resourceType: string,
    id: string,
  ): Observable<T> {
    const url = `${this.getEndpoint(sandboxId, version)}/${resourceType}/${id}`;
    return this.http.delete<T>(url);
  }

  public postTransaction<T = Record<string, unknown>, R = FhirBundle>(
    sandboxId: string,
    version = 'r4',
    bundle: T,
  ): Observable<R> {
    const url = `${this.getEndpoint(sandboxId, version)}/`;
    return this.http.post<R>(url, bundle);
  }

  public validateResource<T = Record<string, unknown>>(
    sandboxId: string,
    version = 'r4',
    resourceType: string,
    body: T,
  ): Observable<FhirOperationOutcome> {
    const url = `${this.getEndpoint(sandboxId, version)}/${resourceType}/$validate`;
    return this.http.post<FhirOperationOutcome>(url, body);
  }
}
