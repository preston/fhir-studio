# AGENTS.md

## Project Context
`fhir-studio` is a modern healthcare developer platform for FHIR sandboxes, simulated EHR app launching, SMART on FHIR v2 authentication, and CDS Hooks testing. Is it heavily functionally based on the original Logica Sandbox system, but reimplemented in modern TypeScript.


- **Monorepo Structure**:
  - `core/` – Shared domain models, RBAC, SMART, FHIR, and CDS Hook types (`@fhir-studio/core`)
  - `server/` – Express + Node ESM backend, Prisma ORM, FHIR Gateway proxy, SMART IdP, and Postgres-backed job worker (`@fhir-studio/server`)
  - `ui/` – Angular 22 standalone UI with Bootstrap 5 and ECharts (`@fhir-studio/ui`)
  - `docker/` – Local stack with PostgreSQL, Redis, Authentik (SSO/OIDC), and HAPI FHIR (R4/R4B/R5)

---

## Tone, Voice & Communication Style
- **Direct & Technical**: Clear, high-signal, engineering-focused tone. No conversational filler, flattery, or generic commentary.
- **Action-Oriented Explanations**: When fixing bugs or presenting solutions, use structured summaries:
  1. **Root Cause** (brief, technical diagnosis)
  2. **Fix Applied** (specific files and logic updated)
  3. **Verification** (commands run and output confirmed)
- **Precise Code References**: Point to exact file paths and concise code snippets rather than broad generalities.

---

## Coding Standards & Preferences
- **TypeScript**: Strict typing across all packages. Avoid `any`. Prefer explicit interfaces and shared types from `@fhir-studio/core`.
- **Node & Express**:
  - Use the latest stable versions of Node and Express
  - Full ESM (`type: "module"`).
  - Express routing conventions (e.g., named wildcard syntax `/:version{/*path}` via `path-to-regexp` v8).
  - Clean separation between route handlers, business services, and database layers.
  - Make sure that `server/.env.example` will always work out-of-the-box when used by a new developer, per the README.md instructions (values must match `docker/docker-compose.development.yml`).
  - Required env validation is centralized in `server/src/env.ts` (`requireEnvAll`, `SERVER_REQUIRED_ENV`, `WORKER_REQUIRED_ENV`). The API uses `loadSsoConfig()`; the worker uses `loadWorkerConfig()`. Do not add silent localhost fallbacks for required vars — missing config must exit with the shared helpful error that points at copying `.env.example`.
- **Angular**:
  - Use the latest stable version of Angular and Bootstrap
  - Prefer modern Angular 22 idioms: standalone components, functional guards (`CanActivateFn`), functional interceptors (`HttpInterceptorFn`), and `inject()` over constructor parameter injection.
  - State & Reactivity: Use Angular Signals (`signal()`, `computed()`, `effect()`, `toSignal()`) for state management and zoneless change detection (`provideZonelessChangeDetection()`).
  - Template Conventions: Invoke signals as functions (`mySignal()`), mutate via `.set()` or `.update()`, and use native `@if`, `@for`, `@switch` control flow blocks with strict template type-checking.
  - Follow existing Bootstrap / Bootstrap Icons / Bootswatch theming and component conventions
  - Follow component best practices and native Angular conventions, and strict template type-checking
- **FHIR & Healthcare Specs**:
  - Adhere to SMART on FHIR v2 and later (granular scopes, asymmetric client auth, PKCE S256).
  - Multi-version FHIR support (R4, R4B, R5 etc) utilizing HAPI FHIR multi-tenant partitioning.
  - Follow CDS Hooks 2.0 and later specifications.
- **Database & Prisma**:
  - Use Prisma migrations (`npm run prisma:migrate`) and maintain idempotent seed scripts (`src/db/seed.ts`).
  - ALWAYS use prisma to generate migrations. Never create your own migration files! Also ask if you think you might need to manually tweak a migration, as these are supposed to be generated.

---

## Key Commands & Workflow
- **Build All**: `npm run build`
- **Server Dev**: `npm run start:server` (or `npm run dev --workspace=@fhir-studio/server`)
- **Worker Dev**: `npm run start:worker` (or `npm run worker:watch --workspace=@fhir-studio/server`)
- **UI Dev**: `npm run start:ui`
- **Typecheck**: `npm run typecheck --workspace=@fhir-studio/<workspace>`
- **Docker Stack**: `npm run docker:up` / `npm run docker:down`
- **Verification**: Always run workspace typechecks or builds after editing code to ensure zero linter or compilation regressions.
