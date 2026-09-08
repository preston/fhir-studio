// Author: Preston Lee

import 'dotenv/config';
import { defineConfig } from 'prisma/config';

// Prisma CLI (generate/migrate) may run before a developer copies `.env`.
// Runtime server/worker do not use this fallback — they require env via `requireDatabaseUrl()`.
const databaseUrl =
  process.env['FHIR_STUDIO_SERVER_DATABASE_URL']?.trim() ||
  process.env['DATABASE_URL']?.trim() ||
  'postgresql://postgres:password@localhost:5433/fhir_studio_development';

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    seed: 'tsx src/db/seed.ts',
  },
  datasource: {
    url: databaseUrl,
  },
});
