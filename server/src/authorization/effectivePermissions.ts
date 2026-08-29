// Author: Preston Lee

import type { PrismaClient } from '@prisma/client';
import { AppointmentEntityType } from '@prisma/client';
import type { EffectivePermissions } from '@fhir-studio/core';
import { mergeBooleanPermissions } from './permissions.js';

/**
 * Load and OR-merge permissions from direct user appointments and
 * appointments on groups the user belongs to.
 */
export async function loadEffectivePermissions(
  prisma: PrismaClient,
  userId: string,
): Promise<EffectivePermissions> {
  const [userAppointments, memberships] = await Promise.all([
    prisma.appointment.findMany({
      where: { entityType: AppointmentEntityType.User, entityId: userId },
      include: { role: true },
    }),
    prisma.member.findMany({
      where: { userId },
      select: { groupId: true },
    }),
  ]);

  const groupIds = memberships.map((m) => m.groupId);
  const groupAppointments =
    groupIds.length === 0
      ? []
      : await prisma.appointment.findMany({
          where: {
            entityType: AppointmentEntityType.Group,
            entityId: { in: groupIds },
          },
          include: { role: true },
        });

  const allRoles = [
    ...userAppointments.map((a) => a.role),
    ...groupAppointments.map((a) => a.role),
  ];

  const merged = mergeBooleanPermissions(
    allRoles.map((r) => ({
      sandboxes_create: r.permission_sandboxes_create,
      sandboxes_shared: r.permission_sandboxes_shared,
      ehr_simulator: r.permission_ehr_simulator,
      data_manager: r.permission_data_manager,
      applications_register: r.permission_applications_register,
      package_import: r.permission_package_import,
      global_manage: r.permission_global_manage,
    })),
  );

  return {
    ...merged,
    extra: {},
  };
}
