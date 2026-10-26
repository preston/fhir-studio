// Author: Preston Lee

import type { PrismaClient } from "@prisma/client";
import { AppointmentEntityType } from "@prisma/client";

export const DEFAULT_ROLE_NAME = "User";
export const ADMINISTRATOR_ROLE_NAME = "Administrator";
export const ADMINISTRATORS_GROUP_NAME = "Administrators";
export const USERS_GROUP_NAME = "Users";

/** Appoint the default role to a user if not already appointed. */
export async function appointDefaultRoles(
  prisma: PrismaClient,
  userId: string,
): Promise<void> {
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
        manualGrant: true,
      },
      update: { manualGrant: true },
    });
  }
}

/** Keep independently recorded manual and SSO grants separate so IdP removals revoke access. */
export async function syncIdpRoleMappings(
  prisma: PrismaClient,
  userId: string,
  ssoRoles: string[],
): Promise<void> {
  const roles = new Set(ssoRoles);
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`sso-mappings:${userId}`}, 0))`;
    const [groups, appointments, history] = await Promise.all([
      tx.member.findMany({ where: { userId }, include: { group: true } }),
      tx.appointment.findMany({
        where: { entityType: AppointmentEntityType.User, entityId: userId },
        include: { role: true },
      }),
      tx.session.findMany({ where: { userId }, select: { ssoRoles: true } }),
    ]);
    const historicalRoles = new Set(ssoRoles);
    for (const session of history) {
      if (Array.isArray(session.ssoRoles)) {
        for (const role of session.ssoRoles)
          if (typeof role === "string") historicalRoles.add(role);
      }
    }
    // Legacy rows have no trustworthy origin. Fail closed for mapped or previously
    // claimed grants; retain unrelated manual grants. Administrators can explicitly
    // regrant a legacy manual membership/appointment to record its independent origin.
    for (const member of groups) {
      const manual =
        member.manualGrant ??
        !(
          member.group.ssoRoleMapping || historicalRoles.has(member.group.name)
        );
      const sso =
        roles.has(member.group.name) ||
        (!!member.group.ssoRoleMapping &&
          roles.has(member.group.ssoRoleMapping));
      if (!manual && !sso) await tx.member.delete({ where: { id: member.id } });
      else
        await tx.member.update({
          where: { id: member.id },
          data: { manualGrant: manual, ssoGrant: sso },
        });
    }
    for (const appointment of appointments) {
      const manual =
        appointment.manualGrant ??
        !(
          appointment.role.ssoRoleMapping ||
          historicalRoles.has(appointment.role.name)
        );
      const sso =
        roles.has(appointment.role.name) ||
        (!!appointment.role.ssoRoleMapping &&
          roles.has(appointment.role.ssoRoleMapping));
      if (!manual && !sso)
        await tx.appointment.delete({ where: { id: appointment.id } });
      else
        await tx.appointment.update({
          where: { id: appointment.id },
          data: { manualGrant: manual, ssoGrant: sso },
        });
    }
    const [matchingGroups, matchingRoles] = await Promise.all([
      tx.group.findMany({
        where: {
          OR: [
            { name: { in: ssoRoles } },
            { ssoRoleMapping: { in: ssoRoles } },
          ],
        },
      }),
      tx.role.findMany({
        where: {
          OR: [
            { name: { in: ssoRoles } },
            { ssoRoleMapping: { in: ssoRoles } },
          ],
        },
      }),
    ]);
    for (const group of matchingGroups) {
      await tx.member.upsert({
        where: { userId_groupId: { userId, groupId: group.id } },
        create: {
          userId,
          groupId: group.id,
          manualGrant: false,
          ssoGrant: true,
        },
        update: { ssoGrant: true },
      });
    }
    for (const role of matchingRoles) {
      await tx.appointment.upsert({
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
          manualGrant: false,
          ssoGrant: true,
        },
        update: { ssoGrant: true },
      });
    }
  });
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
        manualGrant: true,
      },
      update: { manualGrant: true },
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
        manualGrant: true,
      },
      update: { manualGrant: true },
    });
  }
}
