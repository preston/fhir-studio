// Author: Preston Lee

import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { Observable } from 'rxjs';
import type {
  ImplementationGuideSummary,
  ImplementationGuideFilter,
} from '@fhir-studio/core';

export interface RegistryCatalogSearchResult {
  name: string;
  description?: string;
  title?: string;
  version?: string;
  'dist-tags'?: { latest?: string };
}

@Injectable({
  providedIn: 'root',
})
export class ImplementationGuideService {
  private readonly http = inject(HttpClient);

  public getImplementationGuides(filters: ImplementationGuideFilter = {}): Observable<{
    implementationGuides: ImplementationGuideSummary[];
  }> {
    let params = new HttpParams();
    if (filters.search) params = params.set('search', filters.search);
    if (filters.category && filters.category !== 'all') params = params.set('category', filters.category);
    if (filters.fhirVersion && filters.fhirVersion !== 'all') params = params.set('fhirVersion', filters.fhirVersion);
    if (filters.recommendedForCreation !== undefined) {
      params = params.set('recommendedForCreation', filters.recommendedForCreation.toString());
    }
    if (filters.isSuggested !== undefined) {
      params = params.set('isSuggested', filters.isSuggested.toString());
    }

    return this.http.get<{ implementationGuides: ImplementationGuideSummary[] }>(
      '/api/implementation-guides',
      { params },
    );
  }

  public getImplementationGuide(id: string): Observable<{ implementationGuide: ImplementationGuideSummary }> {
    return this.http.get<{ implementationGuide: ImplementationGuideSummary }>(`/api/implementation-guides/${id}`);
  }

  public searchRegistry(query: string): Observable<{ results: RegistryCatalogSearchResult[] }> {
    return this.http.get<{ results: RegistryCatalogSearchResult[] }>('/api/implementation-guides/registry/search', {
      params: { q: query },
    });
  }

  public getRegistryPackage(packageId: string, version?: string): Observable<{ package: Record<string, unknown> }> {
    const url = version
      ? `/api/implementation-guides/registry/package/${encodeURIComponent(packageId)}/${encodeURIComponent(version)}`
      : `/api/implementation-guides/registry/package/${encodeURIComponent(packageId)}`;
    return this.http.get<{ package: Record<string, unknown> }>(url);
  }

  public downloadPackage(
    packageId: string,
    version?: string,
    tarballUrl?: string | null,
  ): Observable<ArrayBuffer> {
    let params = new HttpParams();
    if (tarballUrl) {
      params = params.set('tarballUrl', tarballUrl);
    }
    const cleanVer = version && version !== 'latest' && version !== 'current' ? version : '';
    const url = cleanVer
      ? `/api/implementation-guides/registry/download/${encodeURIComponent(packageId)}/${encodeURIComponent(cleanVer)}`
      : `/api/implementation-guides/registry/download/${encodeURIComponent(packageId)}`;
    return this.http.get(url, { params, responseType: 'arraybuffer' });
  }
}
