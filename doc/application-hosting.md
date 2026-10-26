# GitHub-backed application hosting

Hosting is enabled with `FHIR_STUDIO_HOSTING_ENABLED=true`. Access requires `Role.permission_applications_deployment`,
which defaults to false. The existing `global_manage` bypass applies. Studio never runs
repository builds locally. GitHub Actions produces artifacts; existing workers import
them onto a bind-mounted filesystem; one static service serves all application hosts.
There is no S3 dependency or per-application container.

## Operator configuration

Register a GitHub App for this Studio instance. Enable expiring user tokens; request
Contents read/write, Actions read/write, Workflows write, Repository creation write,
and implicit Metadata read. Repository Administration is not needed just to create repos.
Organization policy may require owner approval. Configure:

- Callback: `https://studio.example.org/api/github/callback`
- Setup URL: `https://studio.example.org/api/github/setup`
- Webhook: `https://studio.example.org/api/github/webhook`
- Events: workflow_run, installation, installation_repositories, repository. GitHub also
  sends github_app_authorization revocations.

Set `FHIR_STUDIO_HOSTING_ENABLED=true` and complete the required hosting variables from `server/.env.example` in the operator's API
and worker environment. Generate an independent encryption key with
`openssl rand -base64 32`. Never put keys, tokens, or application secrets in the content
directory. Back up the encryption key: changing it requires users to reconnect.
Set `FHIR_STUDIO_SERVER_SMART_SIGNING_KEY` to a separate persistent RSA private key
(at least 2048 bits, PKCS8 PEM; literal `\n` escapes are supported). Production hosting
requires this so API replicas and restarts share the same SMART signing identity.
For example, generate a 3072-bit key using `openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:3072`.
Keep OAuth-on-install disabled when using the separate setup URL; Studio starts its
own OAuth flow with state and PKCE. Enable redirect-on-update to resume setup after
repository-access changes.

Create a host directory owned by container UID/GID 1000, for example
`/srv/fhir-studio/hosted-apps`. Set `FHIR_STUDIO_HOSTING_DIRECTORY` in Compose's environment
to that host directory. Containers use `/var/lib/fhir-studio/hosted-apps`. The worker
mounts it read/write; the API and app host mount it read-only. Set DOMAIN to
`user.studio.example.org`, STUDIO_ORIGIN to the HTTPS origin `https://studio.example.org`,
then start the app host with the prebuilt stack:

```bash
docker compose -f docker-compose.full.yml --profile hosting up -d
```
When hosting is enabled, the API and worker refuse startup when hosting/GitHub configuration is missing or invalid.
All three processes validate the existing storage directory and their required access.
DNS resolution and TLS certificate coverage must also be verified at the operator's proxy.

Route wildcard DNS and a wildcard TLS certificate for `*.user.studio.example.org` to
the app-host service (loopback port 8086 in Compose), preserving Host. Never route app
hosts to the Studio management API, and never expose the content root directly as a web
document root. The app host receives no GitHub keys and exposes no management routes.
The prebuilt stack pins the development Authentik client and localhost callback URLs.
A public deployment sets its own SSO, session, and UI URLs in that environment.
Production hosting validates that the UI and SSO callback use the configured Studio
origin and that management CORS allows only exact HTTPS origins outside the user sub-zone.
Configure edge request/bandwidth limits. If a trusted proxy supplies forwarding headers,
set `FHIR_STUDIO_HOSTING_TRUST_PROXY_HOPS` to the exact hop count (default 0); overwrite
client-supplied forwarding headers at that proxy. The host also limits requests per IP.

The initial topology is one Docker host; every importing/serving replica must see the
same directory. Runtime data is excluded from source control and Docker contexts.
The copied `.env.example` explicitly disables hosting, so base API/worker development
requires no GitHub App or hosting proxy. To develop hosting, set
`FHIR_STUDIO_HOSTING_ENABLED=true`, use a development GitHub App and a local sub-zone
and proxy, create the absolute storage directory, and generate development encryption keys.
Configured deployments that omit the flag retain enabled behavior. Disabled instances
hide hosting navigation, reject hosting management requests, and skip hosting schedules;
existing deployed files remain on disk.
Local development of the host uses `npm run host --workspace=@fhir-studio/server`, with
the same operator-controlled HTTPS proxy arrangement.

## Developer workflow

A role must grant `permission_applications_deployment` before a user can access
Application Studio, templates, hosting management APIs, or Profile connections/GitHub
linking. New and existing roles default to false; enable it in **Administration → Roles**
for approved users/groups. Global administrators retain their existing permission bypass.
Seeding does not overwrite an operator's deployment permission grants.

This feature permission is additional to application ownership/collaborator roles and
the acting user's GitHub repository permissions. `applications_register` is still required
to create applications/repositories. A Developer can edit/build but cannot publish; an
Owner without deployment permission cannot manage hosting. Application roles never grant
the deployment permission. Users without it can still launch enabled published applications
through normal sandbox/SMART authorization and access public static files.

Removing deployment permission immediately blocks subsequent hosting/linking operations,
personal token use/refresh, and activation of that user's queued build requests. Imports
recheck authorization before activating files; automatic publication rechecks both actors.
Repository automation initiated by an unlinked identity/bot uses the owner's current
deployment authority for previews only. Existing preview/published files remain available,
and other authorized collaborators retain their application access. Personal credentials
remain encrypted for later reconnection/use if access is restored; users can revoke the
GitHub App directly in GitHub Settings while Studio connections are inaccessible.

Use **Profile connections** to authorize GitHub, reconnect, disconnect, and manage
repository installations. Personal authorization and repository installation are
independent. Token renewal is automatic, protected by a cross-process database lock.
Disconnect removes personal credentials, not shared installations or deployed files.
Installation removal pauses imports/publication. Existing content survives GitHub outages.

Use **SMART Applications → Application Studio** to connect an existing repository or
populate a new, empty repository from a curated/community template. Repositories belong
to the developer or their organization. For selected-repository installations, add a
newly created repository to the installation before connecting it. Public builds normally
use free standard GitHub runners; private builds consume the repository owner's allowance.

Confirm build runtime, project subdirectory, command, and output directory. Studio adds
a dedicated workflow without overwriting existing CI. If protected, install on a writable
branch and merge on GitHub. The workflow must reach the default branch before manual
workflow dispatch is available. Use Install / repair workflow after build-setting changes.
Detect build settings inspects the selected project directory; review the result before
creating the app. Custom templates carry their build and SMART defaults into the wizard.

The editor saves multiple files as one commit without force-pushing. Drafts stay in the
current tab through failed saves/reconnects. Download the recovery patch before closing
the tab or discarding edits. Use a local editor for binary/large source files. Template
copying preserves ordinary source assets from a recorded commit while excluding secret
configuration and source workflow files; new apps receive fresh managed workflows and IDs.
Public template listing requires a public repository. Studio sharing never grants GitHub
repository access.

Preview and published files, including source maps from private repositories, are public.
Never include credentials or real patient data. Use **Test preview in sandbox** with
patient search, encounter selection, and persona selection. Runtime configuration at `/_studio/config.json` supplies
the public client ID and callbacks; the portable starters use PKCE S256 with credentialless
FHIR requests. Hosted apps start from a Studio launch context. Application collaborators
gain no sandbox data access. Enable a published app only in sandboxes you manage.
Each validated build records its callbacks and SMART scopes. Future settings changes
do not change the launch configuration of an existing preview or publication.
Review the current preview before publishing. Studio pins that review to a build ID;
if a collaborator replaces the preview, review the replacement before publishing.

Only Owners/Administrators publish. Auto-promotion defaults off, targets the configured
branch, and checks both the original GitHub actor and rerun initiator against current
Studio roles and GitHub access. Bots and Developers remain preview-only. Unpublish pauses
auto-promotion; queued attempts cannot reactivate a disabled/deleted/relinked app.

## Filesystem lifecycle

Imports extract into private `.staging` attempt directories, validate, and rename into
generated app/build directories on the same filesystem. Database activation occurs only
after files exist. Orphaned directories from crashes are cleaned without affecting
active preview/published builds or live job leases. A ten-minute completed-file cleanup
grace period and one-hour abandoned-staging threshold provide safe transitions, not
historical retention or rollback. Very old tabs may need reloading after lazy assets
have been removed.

Defaults: 20 MB compressed, 50 MB expanded, 1,000 ZIP entries, 10 applications per owner,
and 10 GB content budget. Limits are configurable. A free-space reserve protects imports.
No old file versions are kept once unreferenced and past cleanup grace. PostgreSQL keeps
small build/audit metadata; full build logs/history remain on GitHub.

Back up PostgreSQL and content consistently by pausing workers or coordinating snapshots.
Restore both together. Monitor disk space/permissions, import errors, and GitHub health.
Retry import when the artifact still exists; rebuild after expiration. Do not manually
edit or serve staging directories. Archive links, special files, traversal, duplicate
paths, unsupported files, integrity errors, and oversized output are rejected.
Allowed output types are HTML, CSS, JS/MJS, JSON, source maps, TXT, PNG/JPEG/GIF/WebP/ICO/SVG,
WOFF/WOFF2, and TTF. All hidden paths and the reserved `_studio` path are prohibited.
SPAs must provide real launch/callback HTML files; arbitrary fallback routing, SSR,
service workers, remote scripts, and server processes are not supported in this release.
SMART filtered scopes, include/revinclude searches, batch/transaction requests, and hosted FHIR `$operations` are
rejected rather than interpreted with broader authority. Patient-scoped requests stay
within the launch patient compartment; conditional patient writes are prohibited.

Hosting uses platform-controlled CSP, no remote scripts/workers, restricted connections,
and disabled camera/microphone/location/payment/USB. Arbitrary browser code can still
misuse data granted to it; hosting is not approval to process real patient data.
The Studio UI forbids framing by hosted origins. Subscription WebSockets accept only
trusted Studio origins with an active session and fixed sandbox authorization; hosted
applications cannot use that management channel to evade SMART scopes. Preserve these
headers and WebSocket origin checks in operator proxy configurations.

## Verification

`npm run test:hosting --workspace=@fhir-studio/server` runs security/filesystem unit tests.
`npm run test:hosting:integration --workspace=@fhir-studio/server` creates and removes a
uniquely named disposable PostgreSQL database. Set `FHIR_STUDIO_TEST_ADMIN_DATABASE_URL`
to a local database-creation connection if it differs from the documented development
stack. Run the monorepo build after changes.

Real OAuth, organization policy, GitHub Actions, and wildcard HTTPS require an operator
acceptance test with a real GitHub App. They are not simulated by a successful local build.

Before enabling public access, exercise authorization, installation approval, private
repository creation, protected-branch workflow setup, a successful Actions build/import,
both preview and published launches in two sandboxes, and revocation/reconnection against
the operator's real GitHub App. Verify wildcard DNS and certificate coverage with generated
preview/published hostnames, and verify hostile-origin requests in a signed-in browser.
Apply the generated migration with `npm run prisma:deploy --workspace=@fhir-studio/server`.
Local automated tests migrate only their own disposable database; the developer database
is not migrated as a side effect of the implementation or tests.

## Hosting administration and usage

**Administration → Application Hosting** provides inventory, channel-separated traffic,
health, storage inspection, owner quotas, audit history, and trash. Search and sort the
inventory, inspect an application, select one or several applications, enter an
administrative reason, and preview the exact versions and allocated storage before
confirming an action. Actions execute as worker jobs and show individual failures;
applications changed since preview require another review. CSV exports support up to
10,000 matching rows per request; use filters/pagination for larger extracts.

Administrators can suspend/resume, unpublish, protect/unprotect from stale policies,
reassign Studio ownership, move to trash, restore, and permanently purge trash.
Reassignment preserves explicit collaborators, clears pending transfers/build activation,
and pauses automatic publication. It does not move the GitHub repository or grant its
new Studio owner repository access. Recipients must be active Studio users with deployment
permission. Ordinary accepted ownership transfers enforce the same allocation limits.

A nullable owner application limit inherits `MAX_APPS_PER_USER`. A nullable storage limit
adds no restriction beyond the instance budget. Limits of zero block additional
allocations. Reserved imports and retained trash count toward storage; active application
counts exclude trash and are checked again on restoration. Lowering a quota does not stop
existing serving. Import reservations, transfers, reassignment, creation, and restoration
share allocation locks to prevent concurrent quota bypass.

Trash immediately blocks serving and SMART launches, revokes sessions, pauses publication,
and prevents queued imports from activating. Assigned preview/published files remain
protected from orphan cleanup for 30 days. Restore validates the retained launch/callback
files and active application quota, then restores the previous channel assignments and
suspension state. Existing sandbox associations survive; revoked sessions stay revoked and
automatic publication stays paused. Expired trash is permanently removed by a worker job;
an administrator may explicitly purge it earlier. Files are removed before application
metadata, so interrupted purges can be retried. Historical traffic and audit records survive
application purge. Old soft-deleted records created before this lifecycle have no guaranteed
retained files and are not automatically assigned a new recovery window.

### Usage collection

Application Studio's **Usage** tab is available to owners and existing read collaborators.
It reports requests, successful HTML GET document responses, response bytes, status classes,
rate limits, aborted responses, known bot requests, server response duration, and consumed
SMART launches. Preview and published traffic are separate. HTML responses include callback
pages and are not SPA page views; browser-cache hits, client-side navigation, and browser
execution time are not observed. Response bytes describe completed response bodies at the
origin host (HEAD/304/aborted responses count zero body bytes), not edge compression or
network protocol overhead. Latency histograms provide approximate p95 for an individual
application; an unavailable/overflow p95 is displayed as unavailable.

Set an independent `FHIR_STUDIO_HOSTING_ANALYTICS_KEY` with `openssl rand -base64 32` in
the API/worker environment and the application-host environment. Do not reuse the GitHub
credential encryption key or session secret. All static-host replicas need the same key.
The host issues a signed, 90-day, Secure/HttpOnly/SameSite=Lax, host-only cookie named
`__Host-studio-visitor`. A browser is counted only after returning a valid cookie on a
successful GET. Single-document visits without another successful request can therefore
be undercounted. Blocked/cleared cookies, cookie expiration, and recognized bot filtering
also affect coverage. There is no fingerprint fallback or cross-host visitor linkage.

Only 1,024-register visitor sketches and fixed hourly counters are persisted, not visitor
records or raw cookies. Merging sketches estimates unique browsers within one hostname
and date range, with approximately 3.3% standard error. Do not sum unique counts across
hours, channels, or applications. No IP, user agent, request path/query, referrer, token,
FHIR context, or browsing history is stored by this feature. Existing reverse proxy access
logs are outside this collector.

Each producer buffers at most 4,096 pending and 4,096 retry-batch hour buckets and flushes
every 30 seconds. Sequence cursors and transactional merges prevent retry double-counting.
Collection failures do not fail successful serving; overflow is dropped and reported.
A crash can lose unflushed metrics, so these are operational estimates rather than billing
records. Reports expose collector freshness and dropped samples. Invalid/unknown hostnames
do not allocate analytics buckets. Rate limiting still avoids database work after its
threshold, with traffic attributed only to recently recognized application IDs.

Hourly records are retained indefinitely by default. Queries support windows up to 366
days, including historical windows. Use explicit history-purge jobs to remove older usage,
inactive build metadata, or audit history. Usage purge cutoffs round down to UTC hour
boundaries and persist a watermark so delayed batches cannot recreate deleted hours.

### Scheduled maintenance

**Administration → Jobs & Workers → Schedules** manages registered maintenance job types,
JSON configuration, enable/disable, run now, and execution history. Timing matches Pulse:
every minute, hourly at a UTC minute, or daily at a UTC hour/minute. Last/next run timestamps
are UTC instants in PostgreSQL and render in the browser's local timezone. Run now does not
move the recurring cadence. Concurrent workers enqueue each scheduled occurrence once,
skip overlapping runs, and coalesce downtime to one overdue execution.

Seeded schedules reconcile a fair batch of applications every minute, clean unreferenced
storage hourly, inspect storage daily at 02:00 UTC, and purge expired trash daily at 03:00 UTC.
Stale-app and history-purge schedules are created disabled and default to dry runs. Re-running
seeds preserves edited schedules. Cancel/retry and progress use the existing worker queue.

Stale policies default to 180 days without developer activity, a successful non-bot HTML
response, or a consumed SMART launch. Published applications/templates are excluded unless
explicitly included. Protected applications, pending transfers, active builds, and unknown
collection status are always excluded. Automatic trash requires at least seven days of
suspension and rechecks eligibility under the application lock. Source/settings changes,
manual builds and publication update developer activity; reconciliation has its own timestamp.
History purges require explicit `datasets` (`usage`, `builds`, `audit`) and a past ISO UTC
`before` timestamp. Active and trash-retained builds cannot be removed by history cleanup.

### Upgrade and acceptance

1. Generate and configure the independent analytics key in the operator environment.
2. Back up PostgreSQL and hosted content together.
3. Run `npm run prisma:deploy --workspace=@fhir-studio/server` to apply the generated migrations.
4. Run `npm run prisma:seed --workspace=@fhir-studio/server` to install default schedules.
5. Deploy/restart API, worker, and static-host processes together, then verify collection
   freshness and complete a storage inspection before configuring cleanup policies.

`npm run test:hosting --workspace=@fhir-studio/server` includes analytics/scheduler unit tests.
`npm run test:hosting:integration --workspace=@fhir-studio/server` includes administration,
concurrent allocation/scheduling, traffic merges, recovery, purge, and authorization tests;
each suite creates/removes its own uniquely named PostgreSQL database. Neither migrates the
developer database. Run `npm run build` after changes.

For operator acceptance, use the real wildcard HTTPS setup: verify the cookie is isolated
between applications and preview/published hosts, HttpOnly and Secure flags, normal and
iframe SMART launches, collector flushing, an administrator bulk-action preview, restored
publication with fresh SMART authorization, and schedule history/UTC-to-local display.

Standalone SMART launches with patient scopes present a patient selection page on Studio before issuing an authorization code. Selection is restricted to the authorized sandbox and the token includes the selected patient context. FHIR POST searches remain within that patient compartment.

Asymmetric SMART authentication supports RS384, ES384, and RS256. Clients may register inline JWKS or a public HTTPS `jwks_uri`; URL retrieval is bounded, rejects private-network destinations and redirects, and honors cache freshness for up to five minutes. A JWT `jku`, if present, must match the registered URL.


## Experimental catalog integration

Deploy the generated Prisma migrations, API, worker, UI, and static host together before enabling `FHIR_STUDIO_INTEGRATION_ENABLED=true`. Set `FHIR_STUDIO_INTEGRATION_ISSUER` to the canonical HTTPS API origin followed by `/integration`. Keep the flag false for the independent Skycapp settings release. Public HTTPS artifact hosting needs the generic hosting configuration; GitHub credentials are required only for GitHub sources and editable projects.

Register each Skycapp instance under Administration → Integration clients. Copy its client ID and one-time secret to the approved-instance settings in Skycapp and register the exact Skycapp UI callback URL. Authorization uses independent opaque integration tokens, PKCE S256, rotating refresh tokens, and issuer-bound callbacks. These tokens cannot call SMART/FHIR or general control-plane endpoints. Scope grants cover only applications created by that integration client and currently accessible to the linked user. Users can revoke grants under Profile → Connected applications even when the integration flag is disabled. Client secret rotation revokes existing grants and requires reconnecting.

The public capability endpoint is `/api/integration/v1/capabilities`; OAuth metadata is `/.well-known/oauth-authorization-server/integration`. The delegated API provides account, sandbox metadata, preflight, deployments, applications, and durable operations. Submit deployments with a stable `Idempotency-Key`; a repeated key with changed input is rejected. Only Studio handles clinical launch context. Mark the immutable preview reviewed in Studio before publishing; publication and its selected sandbox binding commit together.

Catalog artifacts declare a digest and static SMART contract. Public HTTPS ZIPs and GitHub release/Actions artifacts share archive validation, hosting isolation, quotas, and worker activation. GitHub downloads use the linked actor's authorization. Signed URLs and source credentials are never saved in catalog metadata. Private-source content becomes publicly accessible after import; the deployment flow requires acknowledgement. Configuration revisions keep immutable runtime values and reference existing validated content; they do not retain additional historical content for rollback. Reinstalling an older catalog release requires its source still to exist and remain accessible.

Editable projects copy a pinned snapshot into a new user-owned repository without source secrets or workflows, then install Studio's own build workflow. A deterministic operation marker permits recovery if repository creation completed before the server response. Failed setup retains the repository and application for retry. Initial delegated activation is revoked with its grant; later explicit Studio builds use the developer's current Studio authority. Repository ownership, installation approval, and GitHub permissions remain independent of Skycapp account linking.

Back up the database and `FHIR_STUDIO_HOSTING_ENCRYPTION_KEY` together in the operator's secret store. Integration client secrets and bearer tokens are stored only as hashes; recover by rotating/reconnecting, not exporting secrets. For hosting-key rotation, configure the previous key in `FHIR_STUDIO_HOSTING_ENCRYPTION_KEY_PREVIOUS`, deploy the new primary key across API and workers, and reconnect/re-encrypt remaining GitHub authorizations before removing the previous key. Do not rotate analytics/session keys using the hosting key. Never include encryption keys, bearer tokens, or signed download URLs in logs or backups of public configuration.

Before pilot enablement, run `test:hosting`, `test:hosting:integration`, `test:catalog`, and `test:catalog:integration` against disposable databases, then validate a real public product and a private GitHub product end to end. Monitor worker failures, queue delays, source authorization failures, reconciliation errors, and application/storage quotas. Turning the flag off prevents new delegated operations while already accepted jobs and hosted applications retain their normal lifecycle.
