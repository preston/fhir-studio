// Author: Preston Lee

import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';
import { requireDatabaseUrl } from '../env.js';

let prisma: PrismaClient | null = null;
let pool: pg.Pool | null = null;

export function getPrisma(databaseUrl?: string): PrismaClient {
  const url = databaseUrl || requireDatabaseUrl();
  if (!prisma) {
    pool = new pg.Pool({
      connectionString: url,
      connectionTimeoutMillis: 5_000,
      idleTimeoutMillis: 10_000,
    });
    const adapter = new PrismaPg(pool);
    prisma = new PrismaClient({ adapter });
  }
  return prisma;
}

export async function disconnectPrisma(): Promise<void> {
  if (prisma) {
    await prisma.$disconnect();
    prisma = null;
  }
  if (pool) {
    await pool.end();
    pool = null;
  }
}
