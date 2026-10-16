// Author: Preston Lee

import { inject } from '@angular/core';
import { type CanActivateFn, Router } from '@angular/router';
import { AuthService } from '../services/auth.service.js';
import type { EffectivePermissions } from '@fhir-studio/core';
import { map } from 'rxjs';

export function permissionGuard(
  requiredPermission: keyof EffectivePermissions,
): CanActivateFn {
  return () => {
    const authService = inject(AuthService);
    const router = inject(Router);

    const check = () =>
      authService.hasPermission(requiredPermission)
        ? true
        : router.createUrlTree([
            authService.isAuthenticated() ? '/sandboxes' : '/',
          ]);
    return authService.isInitialized()
      ? check()
      : authService.loadSession().pipe(map(check));
  };
}
