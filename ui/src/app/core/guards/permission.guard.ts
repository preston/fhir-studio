// Author: Preston Lee

import { inject } from '@angular/core';
import { type CanActivateFn, Router } from '@angular/router';
import { AuthService } from '../services/auth.service.js';
import type { EffectivePermissions } from '@fhir-studio/core';

export function permissionGuard(requiredPermission: keyof EffectivePermissions): CanActivateFn {
  return () => {
    const authService = inject(AuthService);
    const router = inject(Router);

    if (authService.hasPermission(requiredPermission)) {
      return true;
    }

    if (!authService.isAuthenticated()) {
      router.navigate(['/']);
    } else {
      router.navigate(['/sandboxes']);
    }
    return false;
  };
}
