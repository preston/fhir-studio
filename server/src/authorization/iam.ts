// Author: Preston Lee

import type { PrismaClient } from '@prisma/client';
import { AppointmentEntityType } from '@prisma/client';

export const DEFAULT_ROLE_NAME = 'User';
export const ADMINISTRATOR_ROLE_NAME = 'Administrator';
export const ADMINISTRATORS_GROUP_NAME = 'Administrators';
export const USERS_GROUP_NAME = 'Users';

/** Appoint the default role to a user if not already appointed. */
export async function appointDefaultRoles(prisma: PrismaClient, userId: string): Promise<void> {
  const defaultRoles = await prisma.role.findMany({
    where: { default: true },
  });
  for (const role of defaultRoles) {
    await prisma.appointment.upsert({
      where: {
        entityType_entityId_roleId: {
          entityType: AppointmentEntityType.User,
          entityId: userId,
          roleId: role.id,
        },
      },
      create: {
        entityType: AppointmentEntityType.User,
        entityId: userId,
        roleId: role.id,
      },
      update: {},
    });
  }
}

/** Synchronize IdP roles claim with local Groups and Roles mapping. */
export async function syncIdpRoleMappings(
  prisma: PrismaClient,
  userId: string,
  ssoRoles: string[],
): Promise<void> {
  if (!ssoRoles || ssoRoles.length === 0) {
    return;
  }

  // Find groups matching the SSO role names
  const matchingGroups = await prisma.group.findMany({
    where: {
      OR: [
        { name: { in: ssoRoles } },
        { ssoRoleMapping: { in: ssoRoles } },
      ],
    },
  });

  for (const group of matchingGroups) {
    await prisma.member.upsert({
      where: {
        userId_groupId: {
          userId,
          groupId: group.id,
        },
      },
      create: {
        userId,
        groupId: group.id,
      },
      update: {},
    });
  }

  // Find roles matching the SSO role names
  const matchingRoles = await prisma.role.findMany({
    where: {
      OR: [
        { name: { in: ssoRoles } },
        { ssoRoleMapping: { in: ssoRoles } },
      ],
    },
  });

  for (const role of matchingRoles) {
    await prisma.appointment.upsert({
      where: {
        entityType_entityId_roleId: {
          entityType: AppointmentEntityType.User,
          entityId: userId,
          roleId: role.id,
        },
      },
      create: {
        entityType: AppointmentEntityType.User,
        entityId: userId,
        roleId: role.id,
      },
      update: {},
    });
  }
}

/** If user's email is in bootstrap admin emails, add to Administrators group. */
export async function applyBootstrapAdminMembership(
  prisma: PrismaClient,
  userId: string,
  email: string | null | undefined,
  bootstrapEmails: string[],
): Promise<void> {
  if (!email || bootstrapEmails.length === 0) return;
  const normalized = email.trim().toLowerCase();
  const isBootstrapAdmin = bootstrapEmails.some(
    (e) => e.trim().toLowerCase() === normalized,
  );
  if (!isBootstrapAdmin) return;

  const adminGroup = await prisma.group.findUnique({
    where: { name: ADMINISTRATORS_GROUP_NAME },
  });
  if (adminGroup) {
    await prisma.member.upsert({
      where: {
        userId_groupId: {
          userId,
          groupId: adminGroup.id,
        },
      },
      create: {
        userId,
        groupId: adminGroup.id,
      },
      update: {},
    });
  }

  const adminRole = await prisma.role.findUnique({
    where: { name: ADMINISTRATOR_ROLE_NAME },
  });
  if (adminRole) {
    await prisma.appointment.upsert({
      where: {
        entityType_entityId_roleId: {
          entityType: AppointmentEntityType.User,
          entityId: userId,
          roleId: adminRole.id,
        },
      },
      create: {
        entityType: AppointmentEntityType.User,
        entityId: userId,
        roleId: adminRole.id,
      },
      update: {},
    });
  }
}
