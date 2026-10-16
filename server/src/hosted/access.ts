import type { Request } from 'express';
import type { ApplicationCapabilities } from '@fhir-studio/core';
import { getPrisma } from '../db/prisma.js';
import type { Prisma } from '@prisma/client';
import { loadEffectivePermissions } from '../authorization/effectivePermissions.js';
import { hasPermission } from '../authorization/permissions.js';

export async function deploymentAllowed(
  db: Prisma.TransactionClient,
  userId: string,
): Promise<boolean> {
  const user = await db.user.findUnique({
    where: { id: userId },
    select: { isSuspended: true },
  });
  return (
    !!user &&
    !user.isSuspended &&
    hasPermission(
      await loadEffectivePermissions(db, userId),
      'applications_deployment',
    )
  );
}

export async function assertDeploymentPermission(
  db: Prisma.TransactionClient,
  userId: string,
): Promise<void> {
  if (!(await deploymentAllowed(db, userId)))
    throw new HostingError(
      403,
      "Application hosting and GitHub linking require the 'applications_deployment' permission.",
    );
}

export class HostingError extends Error {
  constructor(
    public status: number,
    message: string,
    public recovery?: string,
  ) {
    super(message);
  }
}
export function capabilities(
  ownerId: string,
  userId: string,
  role?: string,
  admin = false,
): ApplicationCapabilities {
  const own = ownerId === userId;
  const manage = own || role === 'MANAGE';
  return {
    read: own || !!role || admin,
    develop: manage || role === 'READ_WRITE',
    publish: manage,
    manageCollaborators: manage,
    own,
  };
}
export async function applicationAccess(
  req: Request,
  id: string,
  permission: keyof ApplicationCapabilities = 'read',
) {
  if (!req.sessionAuth)
    throw new HostingError(401, 'Sign in to manage applications.');
  await assertDeploymentPermission(getPrisma(), req.sessionAuth.userId);
  const app = await getPrisma().hostedApplication.findFirst({
    where: { id, deletedAt: null },
    include: {
      collaborators: {
        include: { user: { select: { email: true, displayName: true } } },
      },
      builds: { orderBy: { createdAt: 'desc' }, take: 5 },
    },
  });
  if (!app) throw new HostingError(404, 'Application not found.');
  const rights = capabilities(
    app.ownerUserId,
    req.sessionAuth.userId,
    app.collaborators.find((c) => c.userId === req.sessionAuth!.userId)?.role,
    req.effectivePermissions?.global_manage,
  );
  if (app.transferToUserId === req.sessionAuth.userId) rights.read = true;
  if (!rights.read) throw new HostingError(404, 'Application not found.');
  if (!rights[permission])
    throw new HostingError(
      403,
      'Your application role does not permit this operation.',
    );
  const activeIds = [
    app.previewBuildId,
    app.publishedBuildId,
    app.desiredBuildId,
  ].filter(
    (id): id is string => !!id && !app.builds.some((build) => build.id === id),
  );
  if (activeIds.length)
    app.builds.push(
      ...(await getPrisma().hostedBuild.findMany({
        where: { applicationId: app.id, id: { in: activeIds } },
      })),
    );
  return { app, rights, userId: req.sessionAuth.userId };
}
export async function sandboxAccess(
  userId: string | undefined,
  slug: string,
  write = false,
  admin = false,
) {
  const sandbox = await getPrisma().sandbox.findUnique({
    where: { sandboxId: slug },
    include: { collaborators: true },
  });
  if (!sandbox) throw new HostingError(404, 'Sandbox not found.');
  const role = sandbox.collaborators.find((c) => c.userId === userId)?.role;
  const owner = sandbox.createdByUserId === userId;
  if (
    write
      ? !(owner || admin || role === 'MANAGE' || role === 'OWNER')
      : !(owner || admin || role || sandbox.allowOpenAccess)
  )
    throw new HostingError(403, 'Sandbox access denied.');
  return sandbox;
}
export function repositoryPath(value: string, allowEmpty = false): string {
  if (
    (!value && !allowEmpty) ||
    value.includes('\\') ||
    /[\x00-\x1f:]/.test(value) ||
    value.startsWith('/') ||
    value
      .split('/')
      .some((p) => p === '..' || p === '.' || p.startsWith('.git'))
  )
    throw new HostingError(
      400,
      'Use a relative repository path without traversal or hidden configuration.',
    );
  return value;
}
export async function audit(
  applicationId: string | null,
  userId: string | null,
  action: string,
) {
  await getPrisma().$transaction(async tx => {
    if (applicationId && userId) await tx.hostedApplication.updateMany({ where: { id: applicationId }, data: { lastDeveloperActivityAt: new Date() } });
    await tx.hostedAudit.create({ data: { applicationId, userId, action } });
  });
}
export async function assertCurrentCapability(
  tx: Prisma.TransactionClient,
  id: string,
  userId: string,
  permission: keyof ApplicationCapabilities,
  admin = false,
): Promise<void> {
  await assertDeploymentPermission(tx, userId);
  const app = await tx.hostedApplication.findUniqueOrThrow({ where: { id } });
  const user = await tx.user.findUnique({ where: { id: userId } });
  const member = await tx.hostedCollaborator.findUnique({
    where: { applicationId_userId: { applicationId: id, userId } },
  });
  if (
    !user ||
    user.isSuspended ||
    app.deletedAt ||
    !capabilities(app.ownerUserId, userId, member?.role, admin)[permission]
  )
    throw new HostingError(
      403,
      'Application authorization changed. Refresh the workspace.',
    );
}
