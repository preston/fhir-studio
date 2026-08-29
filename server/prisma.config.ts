// Author: Preston Lee

import 'dotenv/config';
import { defineConfig } from 'prisma/config';

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    seed: 'tsx src/db/seed.ts',
  },
  datasource: {
    url: process.env['FHIR_STUDIO_SERVER_DATABASE_URL'] || process.env['DATABASE_URL'] || 'postgresql://postgres:password@localhost:5433/fhir_studio_development',
  },
});
