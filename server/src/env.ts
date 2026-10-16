// Author: Preston Lee

export interface EnvSpec {
  name: string;
  aliases?: string[];
  requiredWhen?: () => boolean;
}

/** Existing configured installations stay enabled; local setup explicitly opts out. */
export function isHostingEnabled(): boolean {
  const value = readEnv('FHIR_STUDIO_HOSTING_ENABLED') ?? 'true';
  if (!['true', 'false'].includes(value))
    throw new Error('FHIR_STUDIO_HOSTING_ENABLED must be true or false.');
  return value === 'true';
}

/** Shared database URL — required by both the API server and the job worker. */
export const DATABASE_URL_ENV: EnvSpec = {
  name: 'FHIR_STUDIO_SERVER_DATABASE_URL',
  aliases: ['DATABASE_URL'],
};

/** Required when hosting is enabled; access is additionally controlled by roles. */
export const HOSTING_STATIC_REQUIRED_ENV: EnvSpec[] = [
  { name: 'FHIR_STUDIO_HOSTING_DOMAIN' },
  { name: 'FHIR_STUDIO_HOSTING_ROOT' },
  { name: 'FHIR_STUDIO_HOSTING_STUDIO_ORIGIN' },
  { name: 'FHIR_STUDIO_HOSTING_ANALYTICS_KEY' },
];
export const HOSTING_REQUIRED_ENV: EnvSpec[] = [
  ...HOSTING_STATIC_REQUIRED_ENV,
  { name: 'FHIR_STUDIO_HOSTING_ENCRYPTION_KEY' },
  { name: 'FHIR_STUDIO_HOSTING_GITHUB_APP_ID' },
  { name: 'FHIR_STUDIO_HOSTING_GITHUB_CLIENT_ID' },
  { name: 'FHIR_STUDIO_HOSTING_GITHUB_CLIENT_SECRET' },
  { name: 'FHIR_STUDIO_HOSTING_GITHUB_PRIVATE_KEY' },
  { name: 'FHIR_STUDIO_HOSTING_GITHUB_WEBHOOK_SECRET' },
  { name: 'FHIR_STUDIO_HOSTING_GITHUB_SLUG' },
];

/** Required by the HTTP API / SMART BFF process. No in-code defaults. */
export const SERVER_REQUIRED_ENV: EnvSpec[] = [
  DATABASE_URL_ENV,
  ...HOSTING_REQUIRED_ENV.map(spec => ({ ...spec, requiredWhen: isHostingEnabled })),
  { name: 'FHIR_STUDIO_SERVER_SSO_ISSUER_URL', aliases: ['SSO_ISSUER_URL'] },
  { name: 'FHIR_STUDIO_SERVER_SSO_CLIENT_ID', aliases: ['SSO_CLIENT_ID'] },
  { name: 'FHIR_STUDIO_SERVER_SSO_CLIENT_SECRET', aliases: ['SSO_CLIENT_SECRET'] },
  { name: 'FHIR_STUDIO_SERVER_SSO_REDIRECT_URL', aliases: ['SSO_REDIRECT_URL'] },
  { name: 'FHIR_STUDIO_SERVER_SSO_POST_LOGOUT_REDIRECT_URL', aliases: ['SSO_POST_LOGOUT_REDIRECT_URL'] },
  { name: 'FHIR_STUDIO_SERVER_UI_BASE_URL', aliases: ['UI_BASE_URL'] },
  { name: 'FHIR_STUDIO_SERVER_CORS_ORIGINS' },
  { name: 'FHIR_STUDIO_SERVER_SESSION_SECRET', aliases: ['SESSION_SECRET'] },
  { name: 'FHIR_STUDIO_SERVER_API_TOKEN_PEPPER', aliases: ['API_TOKEN_PEPPER'] },
];

/** Required by the background job worker process. */
export const WORKER_REQUIRED_ENV: EnvSpec[] = [
  DATABASE_URL_ENV,
  ...HOSTING_REQUIRED_ENV.map(spec => ({ ...spec, requiredWhen: isHostingEnabled })),
];

export interface WorkerConfig {
  databaseUrl: string;
}

/** Read a trimmed env value, trying the primary name then optional aliases. */
export function readEnv(name: string, ...aliases: string[]): string | undefined {
  for (const key of [name, ...aliases]) {
    const value = process.env[key]?.trim();
    if (value) {
      return value;
    }
  }
  return undefined;
}

/**
 * Exit with a developer-oriented message when required configuration is missing.
 * Points at `.env.example`, which matches `docker-compose.development.yml`.
 */
export function exitMissingEnv(missing: string[]): never {
  const list = missing.map((name) => `  - ${name}`).join('\n');
  console.error(
    `Missing required environment variable(s):\n${list}\n\n` +
      `For local development with docker-compose.development.yml:\n` +
      `  cp server/.env.example server/.env\n` +
      (missing.some(name => name.startsWith('FHIR_STUDIO_HOSTING_'))
        ? `For hosting, complete the instance-specific settings in doc/application-hosting.md.\n`
        : ''),
  );
  process.exit(1);
}

/** Require every env spec; exits once with the full missing list. */
export function requireEnvAll(specs: EnvSpec[]): Map<string, string> {
  const missing: string[] = [];
  const values = new Map<string, string>();
  for (const { name, aliases = [], requiredWhen } of specs) {
    if (requiredWhen && !requiredWhen()) continue;
    const value = readEnv(name, ...aliases);
    if (!value) {
      missing.push(name);
    } else {
      values.set(name, value);
    }
  }
  if (missing.length > 0) {
    exitMissingEnv(missing);
  }
  return values;
}

/** Require a single env var (with optional aliases). Exits if unset. */
export function requireEnv(name: string, ...aliases: string[]): string {
  return requireEnvAll([{ name, aliases }]).get(name)!;
}

/**
 * Resolve the Prisma/Postgres connection URL.
 * Prefers FHIR_STUDIO_SERVER_DATABASE_URL; accepts DATABASE_URL as an alias.
 */
export function requireDatabaseUrl(): string {
  return requireEnvAll([DATABASE_URL_ENV]).get(DATABASE_URL_ENV.name)!;
}

/** Fail-fast worker configuration (same validation path as the API server). */
export function loadWorkerConfig(): WorkerConfig {
  const values = requireEnvAll(WORKER_REQUIRED_ENV);
  return {
    databaseUrl: values.get(DATABASE_URL_ENV.name)!,
  };
}
