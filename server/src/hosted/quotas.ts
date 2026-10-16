import type { Prisma } from '@prisma/client';
import { HostingError } from './access.js';
import type { HostingConfig } from './config.js';

// All allocation/lifecycle operations acquire storage, owners (sorted), then app locks.
export async function lockHostingAllocation(
  tx: Prisma.TransactionClient,
  ownerIds: string[] = [],
): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('hosted-storage', 0))`;
  for (const id of [...new Set(ownerIds)].sort())
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`owner:${id}`}, 0))`;
}
export async function assertOwnerQuota(
  tx: Prisma.TransactionClient,
  config: HostingConfig,
  userId: string,
  additionalApps = 0,
  additionalBytes = 0n,
): Promise<void> {
  const quota = await tx.hostedOwnerQuota.findUnique({ where: { userId } });
  const count = await tx.hostedApplication.count({
    where: { ownerUserId: userId, deletedAt: null },
  });
  if (
    additionalApps > 0 &&
    count + additionalApps > (quota?.applicationLimit ?? config.maxApps)
  )
    throw new HostingError(
      409,
      'Application ownership quota exceeded. Ask an administrator to review the owner quota.',
    );
  if (quota?.storageBytesLimit != null && additionalBytes > 0n) {
    const used = await tx.hostedBuild.aggregate({
      where: { application: { ownerUserId: userId } },
      _sum: { byteSize: true },
    });
    if ((used._sum.byteSize ?? 0n) + additionalBytes > quota.storageBytesLimit)
      throw new HostingError(
        409,
        'Owner storage quota exceeded (including trash and import reservations).',
      );
  }
}
