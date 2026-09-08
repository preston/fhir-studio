// Author: Preston Lee

import { Injectable, computed, inject, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable, tap, shareReplay } from 'rxjs';

export type FhirReleaseId = 'R4' | 'R4B' | 'R5';

export interface FhirReleaseAvailability {
  release: FhirReleaseId;
  enabled: boolean;
}

export interface FhirReleasesResponse {
  releases: FhirReleaseAvailability[];
}

@Injectable({
  providedIn: 'root',
})
export class FhirReleasesService {
  private readonly http = inject(HttpClient);

  private readonly releasesState = signal<FhirReleaseAvailability[]>([]);
  private readonly loadedState = signal(false);
  private load$?: Observable<FhirReleasesResponse>;

  public readonly releases = this.releasesState.asReadonly();
  public readonly loaded = this.loadedState.asReadonly();
  public readonly enabledReleases = computed(() =>
    this.releasesState()
      .filter((r) => r.enabled)
      .map((r) => r.release),
  );
  public readonly allReleases = computed(() => this.releasesState().map((r) => r.release));

  /** Load once and cache; safe to call from multiple components. */
  public ensureLoaded(): Observable<FhirReleasesResponse> {
    if (!this.load$) {
      this.load$ = this.http.get<FhirReleasesResponse>('/api/fhir-releases').pipe(
        tap({
          next: (res) => {
            this.releasesState.set(res?.releases || []);
            this.loadedState.set(true);
          },
          error: () => {
            this.loadedState.set(true);
          },
        }),
        shareReplay(1),
      );
    }
    return this.load$;
  }

  public isEnabled(release: string): boolean {
    return this.enabledReleases().includes(release as FhirReleaseId);
  }
}
