# Viet's EHR

A community-maintained clinical SMART on FHIR example for FHIR Studio. It runs
entirely as static browser assets against the sandbox and patient selected at
launch. It has no application server, credentials, seeded patient IDs, or required
data installation. Examples in `/apps` are contributed source, excluded from FHIR
Studio container images.

## Deploy from this repository

In **Deployment → GitHub Repositories**, connect your GitHub account and
grant the instance's GitHub App access to this repository (or your fork). Choose
the repository, select its branch, and use:

| Setting           | Value                                                        |
| ----------------- | ------------------------------------------------------------ |
| Name              | `Viet's EHR`                                                 |
| Static assets directory | `apps/viets-ehr/public`                                  |
| Launch path       | `index.html`                                                 |
| Callback path     | `index.html`                                                 |
| SMART scopes      | `launch launch/patient patient/*.crus user/Questionnaire.rs` |

The static assets directory is relative to the repository root. Launch and callback
paths are relative to that directory. Review those paths and SMART scopes when
creating the application. `fhir-studio.json` also records the runtime contract for contributors
and packaging tools; GitHub hosting currently uses the wizard's explicit SMART
settings rather than importing the manifest.

Create the application and select **Deploy** to publish it. Enable it in a sandbox
you manage, then use the **Launch** tab to test with a patient from that sandbox. Future launches use that sandbox's FHIR endpoint
and context. No code changes or environment variables are required when moving
between instances, sandboxes, or R4/R4B/R5 servers.

Hosting must be enabled by the instance operator, with working wildcard app DNS
and HTTPS. Deployment requires application deployment permission and GitHub access;
launching a published app uses the normal sandbox and SMART permissions. See the
[hosting guide](../../doc/application-hosting.md) for operator setup.

## Clinical workflows

The interface retains the clinical areas of the original contribution: dashboard,
patient summary, schedule, inbox, worklist, vitals, conditions, notes, orders,
medications, results, clinical review, imaging, immunizations, coverage/billing,
referrals, and questionnaires. Lists load real FHIR resources, support pagination,
and distinguish empty data from unavailable resources or insufficient permissions.
Create and edit actions save resources through the launched SMART session.

The app stays within the launch patient context. Work queues and population views
describe the selected patient; they do not imply access to every patient in a
sandbox. Select another patient by launching again from Studio. Unsupported
resource types and operations remain subject to the selected FHIR server's
CapabilityStatement, validation rules, profiles, and granted permissions.

Clinical forms include PHQ-9, GAD-7, and vital signs examples and support a limited
set of simple Questionnaires from the FHIR server's catalog. Responses are saved as patient-linked FHIR
`QuestionnaireResponse` resources. This is a small native renderer rather than an
embedded LHC Forms deployment; advanced SDC behavior is not implemented. Clinical
review shows chart information without claiming to run CDS Hooks services or
provide clinical recommendations. The separate CDS service, hardcoded synthetic
records, mock login, and instance administration console have been removed.
Use FHIR Studio for managing users, roles, sandboxes, applications, and platform
audit records.

## SMART and session behavior

The app reads the hosted origin's `/_studio/config.json` for the public client ID,
callback, scopes, and trusted Studio origin. It accepts standard EHR launch `iss`
and `launch` parameters, discovers SMART authorization/token endpoints, and uses
Authorization Code with PKCE S256, an unpredictable state, and the FHIR audience.
It never uses a password grant or an application secret.

The short-lived authorization transaction is stored in tab session storage and
removed when consumed. Access tokens and FHIR data stay in memory. FHIR requests
send bearer tokens without Studio cookies; redirects and pagination cannot send
tokens outside the launched sandbox. Updates use the resource version when
available to detect concurrent edits. Refreshing, ending the session, or token
expiry requires a fresh launch from Studio. No refresh token or offline access is
requested.

The requested scopes permit patient resource creation, reading, updating, and
searching, plus reading the FHIR server's shared Questionnaire definitions. The app does not
request deletion. Actions are enabled from the actual granted scope, and server
authorization remains authoritative. It needs no CDN, remote fonts, service
worker, or inline JavaScript, so it works under Studio's hosted CSP.

## Develop and verify

With Node 26 or later, from this directory:

```sh
npm ci
npm run build
node --test test/*.test.mjs
```

The app uses browser JavaScript modules checked with strict TypeScript/JSDoc and
needs no transpilation. `public/` is the complete deployable static output.
Commit edits under `public/` and deploy again to update the hosted application. A plain local static
server can display the launch guidance, but an authenticated session requires
Studio's runtime configuration and SMART launch; there is no offline fake-data
mode.

To create a transportable static ZIP from the repository checkout:

```sh
npm run package
```

This writes `dist/viets-ehr.zip` containing the static files and a root
`fhir-studio.json`. The helper is shared at `scripts/package-example-app.mjs`.
GitHub deployment publishes `public/` directly and does not need this ZIP. Studio
currently deploys committed GitHub static directories and connected catalog artifacts, not
local ZIP uploads. See the [contribution and packaging guide](../README.md) for
framework examples and the recommended common contract.
