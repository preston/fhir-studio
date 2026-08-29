// Author: Preston Lee

import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';

export interface UserPersona {
  id: string;
  sandboxId: string;
  personaUserId: string;
  personaName: string;
  fhirResourceType: string;
  fhirResourceId: string;
  fhirResourceName: string;
  createdAt: string;
  updatedAt: string;
}

@Injectable({
  providedIn: 'root',
})
export class PersonasService {
  private readonly http = inject(HttpClient);

  public getPersonas(sandboxId: string): Observable<{ personas: UserPersona[] }> {
    return this.http.get<{ personas: UserPersona[] }>(`/api/sandboxes/${sandboxId}/personas`);
  }

  public createPersona(
    sandboxId: string,
    data: {
      personaUserId: string;
      personaName: string;
      fhirResourceType?: string;
      fhirResourceId: string;
      fhirResourceName?: string;
    },
  ): Observable<{ persona: UserPersona }> {
    return this.http.post<{ persona: UserPersona }>(`/api/sandboxes/${sandboxId}/personas`, data);
  }

  public updatePersona(
    sandboxId: string,
    personaId: string,
    data: Partial<UserPersona>,
  ): Observable<{ persona: UserPersona }> {
    return this.http.put<{ persona: UserPersona }>(
      `/api/sandboxes/${sandboxId}/personas/${personaId}`,
      data,
    );
  }

  public deletePersona(sandboxId: string, personaId: string): Observable<{ message: string }> {
    return this.http.delete<{ message: string }>(
      `/api/sandboxes/${sandboxId}/personas/${personaId}`,
    );
  }
}
