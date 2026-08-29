// Author: Preston Lee

import type { BooleanPermissions, EffectivePermissions } from '@fhir-studio/core';

export type PermissionKey =
  | 'sandboxes_create'
  | 'sandboxes_shared'
  | 'ehr_simulator'
  | 'data_manager'
  | 'applications_register'
  | 'package_import'
  | 'global_manage';

export function mergeBooleanPermissions(sources: Array<Partial<BooleanPermissions>>): BooleanPermissions {
  const result: BooleanPermissions = {
    sandboxes_create: false,
    sandboxes_shared: false,
    ehr_simulator: false,
    data_manager: false,
    applications_register: false,
    package_import: false,
    global_manage: false,
  };

  for (const src of sources) {
    if (src.sandboxes_create) result.sandboxes_create = true;
    if (src.sandboxes_shared) result.sandboxes_shared = true;
    if (src.ehr_simulator) result.ehr_simulator = true;
    if (src.data_manager) result.data_manager = true;
    if (src.applications_register) result.applications_register = true;
    if (src.package_import) result.package_import = true;
    if (src.global_manage) result.global_manage = true;
  }

  return result;
}

export function hasPermission(
  perms: EffectivePermissions | undefined,
  requiredKey: PermissionKey,
): boolean {
  if (!perms) return false;
  if (perms.global_manage) return true; // global_manage grants all actions
  return Boolean(perms[requiredKey]);
}
