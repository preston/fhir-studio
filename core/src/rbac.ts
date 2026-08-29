// Author: Preston Lee

export type AppointmentEntityType = 'User' | 'Group';

export type SandboxCollaboratorRole = 'OWNER' | 'MANAGE' | 'READ_WRITE' | 'READ_ONLY';

export interface BooleanPermissions {
  sandboxes_create: boolean;
  sandboxes_shared: boolean;
  ehr_simulator: boolean;
  data_manager: boolean;
  applications_register: boolean;
  package_import: boolean;
  global_manage: boolean;
}

export const DEFAULT_BOOLEAN_PERMISSIONS: Readonly<BooleanPermissions> = {
  sandboxes_create: true,
  sandboxes_shared: false,
  ehr_simulator: true,
  data_manager: true,
  applications_register: true,
  package_import: true,
  global_manage: false,
};

export interface EffectivePermissions extends BooleanPermissions {
  extra: Record<string, boolean>;
}

export function createDefaultEffectivePermissions(): EffectivePermissions {
  return {
    ...DEFAULT_BOOLEAN_PERMISSIONS,
    extra: {},
  };
}
