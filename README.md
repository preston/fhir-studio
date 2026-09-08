# FHIR Studio

FHIR Studio is a modern, open healthcare developer platform for FHIR sandboxes, simulated EHR application launching, SMART on FHIR v2 development, and CDS Hooks 2.0 testing. It is functionally inspired by the original Logica Sandbox architecture, but re-architected and implemented in modern TypeScript.

The codebase is organized as an npm monorepo with strict TypeScript typing:
- **`core/`** (`@fhir-studio/core`) – Shared domain models, RBAC definitions, SMART, FHIR, and CDS Hook types.
- **`server/`** (`@fhir-studio/server`) – Express and Node.js ESM backend, Prisma OR/M, FHIR Gateway proxy, and SMART on FHIR v2 Identity Provider.
- **`ui/`** (`@fhir-studio/ui`) – Angular standalone UI with Bootstrap and ECharts.
- **`docker/`** – Local Docker Compose stack providing PostgreSQL, Redis, Authentik (SSO/OIDC), and multi-version HAPI FHIR JPA instances (R4, R4B, R5).


---

## Architecture

![deployment](doc/deployment.png)

### Comparison to Logica Sandbox and Logica Sandbox Community Edition

Like the Logica Sandbox (and Community Edition), HAPI FHIR is used for actual FHIR resource repositories. However, the integration has been redesigned to use HAPI's native data partitioning features instead of a custom multitenancy solution. This allows FHIR Studio to use 100% stock HAPI FHIR JPA server builds.

While FHIR Studio is functionally inspired by your favorite Logica Sandbox and Logica Sandbox Community Edition features, the architecture has been greatly consolidated to reduce the deployment footprint and monthly bills for operators. Notably:

- Only FHIR R4, R4B, and R5 are currently supported. R6 support will be added after final balloting.
- Launch scenarios and personas no longer require a extertnal instance of the MITRE IdP in addition to to the IdP used for normal human SSO. Launch scenario and persona data are all managed internally to FHIR Studio and its database.
- FHIR Bulk export and import and subscriptions are now supported! (This was one of the most requested featured of the Logica Sandbox.)
- SMART on FHIR 2.0+ is now supported and standard.
- CDS Hooks 2 is now supported and standard.
- For operators, a backend management UI now permits sandbox purging and account suspension. (These were major headaches in Logica Sandbox operations)

### Components

| Component | Role |
| --- | --- |
| **FHIR Studio UI** | Angular standalone frontend with Bootstrap styling and ECharts analytics. Provides sandbox administration, app registry, scenario builder, persona manager, EHR Simulator with iframe launch harness, and CDS Hooks testbed. |
| **FHIR Studio Server** | Express API with Node.js ESM and Prisma ORM. Handles user authentication via OIDC Backend-For-Frontend (BFF), RBAC enforcement, SMART on FHIR v2 IdP token minting, FHIR Gateway reverse proxying, Subscriptions dispatch, and Bulk Export orchestration. Enqueues background jobs into PostgreSQL but does not execute them. |
| **FHIR Studio Worker** | Separate Node process (same server package/image) that claims and executes background jobs from PostgreSQL using durable leases and `FOR UPDATE SKIP LOCKED`. Scale workers horizontally without changing API container count. |
| **FHIR Studio PostgreSQL** | Primary relational store for FHIR Studio application state, user accounts, roles, sandboxes, apps, launch scenarios, clinical personas, active SMART authorization sessions, and the background job queue. |
| **SSO IdP** | OpenID Connect identity provider for user logins. We ship Authentik by default, which is backed by its own PostgreSQL database and Redis worker cache. |
| **FHIR Gateway & Proxy** | Server-side proxy that intercepts FHIR REST requests, enforces fine-grained SMART on FHIR scopes, injects HAPI tenant partition headers, and rewrites URLs within returned FHIR Bundles and Resource references. |
| **HAPI FHIR JPA Servers** | Multi-version FHIR persistence servers (R4 on port 8083, R4B on port 8084, R5 on port 8085) with tenant partitioning enabled, allowing hundreds of isolated virtual sandboxes per engine instance. |
| **Subscriptions Hub** | WebSocket and webhook notification manager dispatching real-time FHIR topic-based subscription events to connected client applications. |
| **CDS Hooks Engine** | Simulator for discovering and invoking external CDS Service endpoints across standard clinical hooks (`patient-view`, `order-select`, `order-sign`, `encounter-start`, `encounter-discharge`). |

---

## Custom Application Launch Workflow

FHIR Studio provides full support for the **SMART on FHIR v2** specification, including EHR launch contexts, standalone launches, asymmetric client authentication (private key JWT), PKCE S256 code challenge verification, and dynamic client registration (RFC 7591).

![custom-app-launch-workflow](doc/custom-app-launch-workflow.png)

### Workflow Steps

1. **App Registration**:
   Developers register their client applications via the FHIR Studio UI or programmatically using the RFC 7591 Dynamic Client Registration endpoint (`POST /oauth/register`). App metadata includes client ID, launch URI, redirect URIs, requested scopes, and authentication method (`client_secret_basic`, `client_secret_post`, `private_key_jwt`, or `none` for public PKCE clients).
2. **Context & Scenario Setup**:
   Within a selected Sandbox, the developer configures or selects a target FHIR version (R4, R4B, or R5), target Patient, Practitioner/Patient Persona, and optional Encounter. These can be saved as reusable **Launch Scenarios**.
3. **SMART EHR Launch Initiation**:
   When launching from the EHR Simulator or Launch Scenario, the UI requests a short-lived launch token (`POST /api/sandboxes/:sandboxId/launch-context`). FHIR Studio generates a unique `launch` ID bound to the clinical context (15-minute TTL) and opens the app's `launch_uri` in the EHR Simulator frame with `?launch={launch_id}&iss={fhir_base_url}` query parameters.
4. **SMART Authorization (OAuth2 + PKCE)**:
   The application begins authorization by directing the browser to `GET /oauth/authorize` with its `client_id`, `redirect_uri`, `scope`, `state`, `code_challenge`, and the `launch` parameter. The SMART IdP verifies client registration, validates redirect URIs, resolves the stored launch context, and redirects back to the app with an authorization `code`.
5. **Token Exchange**:
   The app exchanges the authorization code at `POST /oauth/token` using its PKCE `code_verifier` or client credentials/assertions. The server mints a signed access token, ID token, and returns the SMART launch context payload (including `patient`, `encounter`, `need_patient_banner`, `smart_style_url`, and custom parameters).
6. **FHIR Resource Data Access**:
   The application queries clinical resources via the FHIR Gateway (`/api/sandboxes/:sandboxId/fhir/:version/{path}`). The Gateway validates the bearer token, verifies fine-grained SMART scopes (e.g. `patient/*.rs`), resolves the Sandbox's HAPI partition ID, proxies the request to the backing HAPI FHIR JPA server, and rewrites resource URLs before returning the response.

---

## Architecture Diagrams

PlantUML sources live under [`doc/`](doc/) and can be rerendered into PNGs with `plantuml` in your PATH:

```bash
# Requires `plantuml` to be in your PATH
npm run diagram
```

---

## Prerequisites

- **Node.js 26+** (monorepo root and server workspace; UI runs on Node.js 22.22.3+ / 24+ / 26+)
- **npm** (workspace support)
- **Docker & Docker Compose** (PostgreSQL, Redis, Authentik, HAPI FHIR R4/R4B/R5)
- **PlantUML** (optional, for regenerating architectural diagrams under `doc/`)

---

## Quick Start & Local Development

### 1. Start Docker Development Services

Start the local backing infrastructure services (PostgreSQL, Authentik SSO, Redis, and partitioned HAPI FHIR servers) using the development compose file:

```bash
# Using root npm script:
npm run docker:up

# Or directly via docker compose:
docker compose -f docker/docker-compose.development.yml up -d
```

### 2. Configure Environment

Copy the example environment file (values match `docker/docker-compose.development.yml`). Both the API server and the job worker load `server/.env`:

```bash
cp server/.env.example server/.env
```

Required variables have **no in-code defaults**. If any are missing, the process exits immediately and prints the missing names plus the copy command above. See [Environment Variables](#environment-variables) for the server vs worker required sets.

### 3. Install Dependencies

Install all dependencies across monorepo workspaces:

```bash
npm install
```

### 4. Database Setup & Seed

Run Prisma migrations and populate initial roles, admin groups, and sample SMART apps:

```bash
npm run prisma:migrate
npm run prisma:seed
```

### 5. Start Server, Worker, and UI from Source

Run the API, background job worker, and UI concurrently in separate terminals from source:

```bash
# Terminal 1: Start the backend API & SMART Gateway (runs in watch mode via tsx)
npm run start:server

# Terminal 2: Start the Postgres-backed background job worker (scales independently of the API)
npm run start:worker

# Terminal 3: Start the Angular UI development server (runs ng serve with proxy on port 4200)
npm run start:ui
```

You can also start them using workspace-targeted commands:

```bash
# Server only
npm run watch --workspace=@fhir-studio/server

# Worker only
npm run worker:watch --workspace=@fhir-studio/server

# UI only
npm run start --workspace=@fhir-studio/ui
```

Jobs are coordinated only through PostgreSQL (no Server↔Worker HTTP). In production Compose, `fhir-studio-worker` uses the same server image with `node build/worker.js` and can be scaled without changing API container count.

Once running, navigate to `http://localhost:4200/` and sign in.

---

## Default Accounts & Service Endpoints

### Default Credentials

| Username | Email | Password | Role / Description |
| --- | --- | --- | --- |
| `administrator` | `administrator@localhost` | `password` | System Administrator (Full platform access) |
| `user` | `user@localhost` | `password` | Standard Developer (Sandbox, app, and simulator access) |
| `akadmin` | `akadmin@localhost` | `password` | Authentik IdP Console Bootstrap Account |

### Local Service Endpoints

| Service | Endpoint | Description |
| --- | --- | --- |
| **FHIR Studio UI** | `http://localhost:4200` | Angular Developer Web Console |
| **FHIR Studio Server** | `http://localhost:3000` | REST API, SMART IdP, and FHIR Gateway |
| **FHIR Studio Worker** | *(no HTTP port)* | Background job consumer (`npm run start:worker`); coordinates only via PostgreSQL |
| **Authentik SSO** | `http://localhost:9000` | OIDC Identity Provider & Admin Console |
| **PostgreSQL** | `localhost:5433` | Primary PostgreSQL database (`fhir_studio_development`) |
| **HAPI FHIR R4** | `http://localhost:8083/fhir` | Partitioned FHIR R4 JPA server |
| **HAPI FHIR R4B** | `http://localhost:8084/fhir` | Partitioned FHIR R4B JPA server |
| **HAPI FHIR R5** | `http://localhost:8085/fhir` | Partitioned FHIR R5 JPA server |

---

## Environment Variables

Configuration uses the `FHIR_STUDIO_SERVER_*` / `FHIR_STUDIO_HAPI_*` prefixes. Validation lives in `server/src/env.ts` and is shared by the API (`loadSsoConfig` → `SERVER_REQUIRED_ENV`) and the worker (`loadWorkerConfig` → `WORKER_REQUIRED_ENV`). Required variables have **no in-code defaults**; a missing set causes an immediate exit listing every missing name and pointing at `server/.env.example`.

Local development values match `server/.env.example` and `docker/docker-compose.development.yml`. Production Compose injects the same names into `fhir-studio-server` / `fhir-studio-worker` (worker gets the database URL and HAPI enable/base URL vars; the API gets the full SSO set).

| Variable | API Server | Worker | Local Development Value (`.env.example`) | Description |
| --- | --- | --- | --- | --- |
| `FHIR_STUDIO_SERVER_DATABASE_URL` | **Required** | **Required** | `postgresql://postgres:password@localhost:5433/fhir_studio_development` | Prisma / job-queue database URL (`DATABASE_URL` accepted as alias) |
| `FHIR_STUDIO_SERVER_SSO_ISSUER_URL` | **Required** | — | `http://localhost:9000/application/o/fhir-studio/` | OIDC SSO Issuer URL (Authentik in dev) |
| `FHIR_STUDIO_SERVER_SSO_CLIENT_ID` | **Required** | — | `fhir-studio-development` | OIDC Client ID |
| `FHIR_STUDIO_SERVER_SSO_CLIENT_SECRET` | **Required** | — | `fhir-studio-development-secret` | OIDC Client Secret |
| `FHIR_STUDIO_SERVER_SSO_REDIRECT_URL` | **Required** | — | `http://localhost:3000/sso/callback` | OIDC BFF Callback URL |
| `FHIR_STUDIO_SERVER_SSO_SCOPES` | Optional | — | `openid profile email offline_access` | Scopes requested during SSO authorization |
| `FHIR_STUDIO_SERVER_SSO_POST_LOGOUT_REDIRECT_URL` | **Required** | — | `http://localhost:4200` | URL to redirect after SSO logout |
| `FHIR_STUDIO_SERVER_UI_BASE_URL` | **Required** | — | `http://localhost:4200` | Base URL of the Angular UI |
| `FHIR_STUDIO_SERVER_CORS_ORIGINS` | **Required** | — | `http://localhost:4200` | Permitted CORS origins (comma-separated) |
| `FHIR_STUDIO_SERVER_SESSION_SECRET` | **Required** | — | `fhir-studio-development-session-secret-32b` | Secret key for signing BFF session cookies |
| `FHIR_STUDIO_SERVER_API_TOKEN_PEPPER` | **Required** | — | `fhir-studio-development-api-token-pepper-32b` | Pepper for hashing API tokens |
| `FHIR_STUDIO_SERVER_BOOTSTRAP_ADMIN_EMAILS` | Optional | — | `administrator@localhost,admin@example.com` | Emails granted administrator role on first SSO login |
| `FHIR_STUDIO_HAPI_R4_ENABLED` | Optional‡ | Optional‡ | `true` | Enable FHIR R4 sandboxes / gateway (`false` disables; unset defaults to `true`) |
| `FHIR_STUDIO_HAPI_R4_BASE_URL` | Cond.§ | Cond.§ | `http://localhost:8083/fhir` | Upstream HAPI FHIR R4 JPA server URL |
| `FHIR_STUDIO_HAPI_R4B_ENABLED` | Optional‡ | Optional‡ | `true` | Enable FHIR R4B sandboxes / gateway |
| `FHIR_STUDIO_HAPI_R4B_BASE_URL` | Cond.§ | Cond.§ | `http://localhost:8084/fhir` | Upstream HAPI FHIR R4B JPA server URL |
| `FHIR_STUDIO_HAPI_R5_ENABLED` | Optional‡ | Optional‡ | `true` | Enable FHIR R5 sandboxes / gateway |
| `FHIR_STUDIO_HAPI_R5_BASE_URL` | Cond.§ | Cond.§ | `http://localhost:8085/fhir` | Upstream HAPI FHIR R5 JPA server URL |
| `PORT` | Optional | — | `3000` | Express HTTP listen port (API only) |
| `NODE_ENV` | Optional | Optional | `development` | Node environment (`development` / `production`) |

‡ Unset defaults to `true`. At least one release must be enabled or the process exits.

§ Required when the matching `*_ENABLED` flag is `true` (no in-code URL fallback). Ignored when disabled. Availability is also exposed at unauthenticated `GET /api/fhir-releases`.

---

## Attribution & License

Provided under the Apache 2.0 license. Copyright © 2026 Preston Lee. All rights reserved.

FHIR® is the registered trademark of HL7 and is used with the permission of HL7. Use of the FHIR trademark does not constitute endorsement of the application by HL7
