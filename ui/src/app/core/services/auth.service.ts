// Author: Preston Lee

import { Injectable, signal, computed, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable, tap, catchError, of } from 'rxjs';
import type { EffectivePermissions } from '@fhir-studio/core';

export interface UserProfile {
  id: string;
  email: string | null;
  displayName: string | null;
  ssoSubject: string;
  ssoRoles: string[];
}

export interface SessionResponse {
  authenticated: boolean;
  user: UserProfile | null;
  permissions: EffectivePermissions | null;
}

@Injectable({
  providedIn: 'root',
})
export class AuthService {
  private readonly http = inject(HttpClient);

  private readonly userState = signal<UserProfile | null>(null);
  private readonly permissionsState = signal<EffectivePermissions | null>(null);
  private readonly isAuthenticatedState = signal<boolean>(false);
  private readonly isInitializedState = signal<boolean>(false);

  public readonly currentUser = this.userState.asReadonly();
  public readonly effectivePermissions = this.permissionsState.asReadonly();
  public readonly isAuthenticated = this.isAuthenticatedState.asReadonly();
  public readonly isInitialized = this.isInitializedState.asReadonly();

  public readonly isGlobalAdmin = computed(() => {
    return Boolean(this.permissionsState()?.global_manage);
  });

  public loadSession(): Observable<SessionResponse> {
    return this.http.get<SessionResponse>('/api/session').pipe(
      tap((res) => {
        this.isAuthenticatedState.set(res.authenticated);
        this.userState.set(res.user);
        this.permissionsState.set(res.permissions);
        this.isInitializedState.set(true);
      }),
      catchError(() => {
        this.isAuthenticatedState.set(false);
        this.userState.set(null);
        this.permissionsState.set(null);
        this.isInitializedState.set(true);
        return of({ authenticated: false, user: null, permissions: null });
      }),
    );
  }

  public hasPermission(permissionKey: keyof EffectivePermissions): boolean {
    const perms = this.permissionsState();
    if (!perms) return false;
    if (perms.global_manage) return true;
    return Boolean(perms[permissionKey]);
  }

  public login(): void {
    window.location.href = '/sso/login';
  }

  public logout(): void {
    window.location.href = '/sso/logout';
  }
}
