# External knowledge publish (personal access tokens)

External tools can publish CRMI-style FHIR Bundles (Libraries + terminology) into this product’s **global knowledge** store (HAPI `DEFAULT` partition). [CQL Studio](https://github.com/cqframework/cql-studio) is one example consumer of this API.

## Permission

- Role flag: `knowledge_publish` (default **false**).
- Admins: Administration → Roles → enable `permission_knowledge_publish`.
- `global_manage` implies all permissions including knowledge publish.

## Personal access tokens

Mint tokens under the user menu → **Personal access tokens**. Each token has a required unique (per user) **name**, an optional **expiry** (default: never), and a one-time-displayed `fs_…` secret.

| Method | Path | Auth |
|--------|------|------|
| GET | `/api/personal-access-tokens` | Session |
| POST | `/api/personal-access-tokens` | Session (body: `{ name, expiresAt? }`) |
| PATCH | `/api/personal-access-tokens/:id` | Session (rename only) |
| DELETE | `/api/personal-access-tokens/:id` | Session |

## Knowledge APIs

| Method | Path | Auth |
|--------|------|------|
| GET | `/api/knowledge/capabilities` | Session or `Authorization: Bearer fs_…` |
| POST | `/api/knowledge/publish?fhirVersion=R4` | Requires `knowledge_publish` |
| POST | `/api/knowledge/ensure-dependencies` | Requires `knowledge_publish` |

Publish body: FHIR `Bundle` of type `transaction` only (not `batch`) with allowed types only (`Library`, `ValueSet`, `CodeSystem`, `ConceptMap`, `NamingSystem`, `ImplementationGuide`). Conditional create via `POST` + `ifNoneExist` (`url` and `version` when present). Gateway writes of these types through a sandbox FHIR base also require `knowledge_publish`.

Configure the public API base URL for clients via `FHIR_STUDIO_SERVER_PUBLIC_API_BASE_URL` (rendered into `configuration.js` at UI container start).

## Example SMART app

Seeded client `cql-with-fhir-example` at `/cql-with-fhir-example` discovers Libraries and runs `Library/$evaluate` for the launch Patient, passing sandbox `dataEndpoint` / `contentEndpoint` / `terminologyEndpoint` parameters so clinical data resolves in the sandbox while Libraries live in `DEFAULT`.
