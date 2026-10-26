// Author: Preston Lee

type Resource = { id: string };
type ValidationErrors = Record<string, string[]>;

export type ArtifactResolver =
  "public-https" | "github-release" | "github-actions";
export type ArtifactLocator =
  | { url: string }
  | { owner: string; repository: string; asset_id: string }
  | { owner: string; repository: string; artifact_id: string };

/** Locators contain durable public metadata, never credentials or signed download URLs. */
export interface BuildArtifact extends Resource {
  build_id: string;
  name: string;
  format_version: 1;
  resolver: ArtifactResolver;
  locator: ArtifactLocator;
  immutable_id: string;
  sha256: string;
  archive_root: string;
}

export interface PublicConfigurationField {
  name: string;
  label: string;
  type: "string" | "number" | "boolean" | "url";
  required: boolean;
  default?: string | number | boolean;
  description?: string;
}

export interface StaticSmartRuntimeContract {
  kind: "static-smart";
  version: 1;
  authentication: "studio-smart";
  pkce: "S256";
  launch_path: string;
  callback_paths: string[];
  scopes: string[];
  fhir_versions: Array<"R4" | "R4B" | "R5">;
  launch_requirements: Array<"standalone" | "ehr" | "patient" | "encounter">;
  public_configuration: PublicConfigurationField[];
  dependencies: Array<{
    name: string;
    kind: "backend" | "data" | "external";
    required: boolean;
    url?: string;
  }>;
}

export interface SourceProject {
  provider: "github";
  owner: string;
  repository: string;
  commit: string;
  project_directory: string;
  build_command: string;
  output_directory: string;
  runtime: string;
}

export interface DeploymentProfile extends Resource {
  build_version?: string;
  build_id?: string;
  configuration_id: string;
  artifact_id: string;
  name: string;
  revision: number;
  status: "draft" | "approved";
  recommended: boolean;
  runtime_contract: StaticSmartRuntimeContract;
  source_project: SourceProject | null;
  approved_at: string | null;
  artifact?: BuildArtifact;
}

export function defaultStaticSmartContract(): StaticSmartRuntimeContract {
  return {
    kind: "static-smart",
    version: 1,
    authentication: "studio-smart",
    pkce: "S256",
    launch_path: "index.html",
    callback_paths: ["callback.html"],
    scopes: ["launch", "openid", "fhirUser"],
    fhir_versions: ["R4"],
    launch_requirements: ["ehr"],
    public_configuration: [],
    dependencies: [],
  };
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function isArchivePath(
  value: unknown,
  allowEmpty = false,
): value is string {
  return (
    typeof value === "string" &&
    ((allowEmpty && value === "") ||
      (value.length > 0 &&
        !value.startsWith("/") &&
        !value.includes("\\") &&
        !/[?#\u0000-\u001f]/.test(value) &&
        value
          .split("/")
          .every((part) => part !== "." && part !== ".." && part.length > 0)))
  );
}

/** Static SMART launch and callback files must be valid public HTML assets. */
export function isStaticSmartEntrypoint(value: unknown): value is string {
  if (!isArchivePath(value) || !/\.html$/i.test(value) || value.includes(":"))
    return false;
  const parts = value.split("/");
  return parts[0] !== "_studio" && parts.every((part) => !part.startsWith("."));
}

export function isSupportedStaticSmartScope(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    !/[\s\u0000-\u0020\u007f]/.test(value) &&
    !value.startsWith("system/") &&
    !value.includes("?") &&
    !value.includes("offline_access")
  );
}

export function artifactErrors(value: unknown): ValidationErrors {
  const errors: ValidationErrors = {};
  const body = record(value) ?? {};
  const locator = record(body["locator"]);
  if (!String(body["name"] ?? "").trim()) errors["name"] = ["is required"];
  if (body["format_version"] !== 1) errors["format_version"] = ["must be 1"];
  if (!/^[a-f0-9]{64}$/i.test(String(body["sha256"] ?? "")))
    errors["sha256"] = ["must be a SHA-256 digest"];
  if (!String(body["immutable_id"] ?? "").trim())
    errors["immutable_id"] = ["must identify immutable release content"];
  if (!isArchivePath(body["archive_root"], true))
    errors["archive_root"] = ["must be a relative archive directory"];
  if (body["resolver"] === "public-https") {
    if (
      !/^https:\/\/[A-Za-z0-9.-]+(?::[0-9]{1,5})?(?:\/[^?#\s]*)?$/.test(
        String(locator?.["url"] ?? ""),
      )
    )
      errors["locator"] = [
        "must contain a public HTTPS URL without credentials, query parameters, or fragments",
      ];
    if (locator && Object.keys(locator).some((key) => key !== "url"))
      errors["locator"] = ["contains unsupported fields"];
  } else if (
    body["resolver"] === "github-release" ||
    body["resolver"] === "github-actions"
  ) {
    const idKey =
      body["resolver"] === "github-release" ? "asset_id" : "artifact_id";
    if (
      !locator ||
      !/^[A-Za-z0-9_.-]+$/.test(String(locator["owner"] ?? "")) ||
      !/^[A-Za-z0-9_.-]+$/.test(String(locator["repository"] ?? "")) ||
      !/^[1-9][0-9]*$/.test(String(locator[idKey] ?? "")) ||
      Object.keys(locator).some(
        (key) => !["owner", "repository", idKey].includes(key),
      )
    )
      errors["locator"] = [
        "must contain owner, repository, and a durable numeric artifact/asset ID",
      ];
  } else errors["resolver"] = ["is unsupported"];
  return errors;
}

export function deploymentProfileErrors(value: unknown): ValidationErrors {
  const errors: ValidationErrors = {};
  const body = record(value) ?? {};
  const contract = record(body["runtime_contract"]);
  if (!String(body["name"] ?? "").trim()) errors["name"] = ["is required"];
  if (!String(body["artifact_id"] ?? "").trim())
    errors["artifact_id"] = ["is required"];
  if (
    !contract ||
    contract["kind"] !== "static-smart" ||
    contract["version"] !== 1 ||
    contract["authentication"] !== "studio-smart" ||
    contract["pkce"] !== "S256"
  )
    errors["runtime_contract"] = [
      "requires the static SMART v1 contract with Studio authentication and PKCE S256",
    ];
  if (!contract) return errors;
  if (
    Object.keys(contract).some(
      (key) =>
        ![
          "kind",
          "version",
          "authentication",
          "pkce",
          "launch_path",
          "callback_paths",
          "scopes",
          "fhir_versions",
          "launch_requirements",
          "public_configuration",
          "dependencies",
        ].includes(key),
    )
  )
    errors["runtime_contract"] = ["contains unsupported fields"];
  if (!isStaticSmartEntrypoint(contract["launch_path"]))
    errors["launch_path"] = [
      "must be a public relative HTML file outside reserved or hidden paths",
    ];
  if (
    !Array.isArray(contract["callback_paths"]) ||
    !contract["callback_paths"].length ||
    !contract["callback_paths"].every((path) => isStaticSmartEntrypoint(path))
  )
    errors["callback_paths"] = [
      "must list public relative HTML files outside reserved or hidden paths",
    ];
  for (const field of ["scopes", "fhir_versions", "launch_requirements"]) {
    const values = contract[field];
    if (
      !Array.isArray(values) ||
      values.length === 0 ||
      !values.every(
        (item) =>
          typeof item === "string" && item.length > 0 && !/\s/.test(item),
      )
    )
      errors[field] = ["must be a nonempty list"];
  }
  if (
    Array.isArray(contract["scopes"]) &&
    !contract["scopes"].every(isSupportedStaticSmartScope)
  )
    errors["scopes"] = [
      "contains unsupported SMART public-client scopes (system, filtered, offline, or whitespace scopes)",
    ];
  if (
    Array.isArray(contract["fhir_versions"]) &&
    contract["fhir_versions"].some(
      (v) => !["R4", "R4B", "R5"].includes(String(v)),
    )
  )
    errors["fhir_versions"] = ["contains an unsupported release"];
  if (
    Array.isArray(contract["launch_requirements"]) &&
    contract["launch_requirements"].some(
      (v) => !["standalone", "ehr", "patient", "encounter"].includes(String(v)),
    )
  )
    errors["launch_requirements"] = [
      "contains an unsupported launch requirement",
    ];
  const dependencies = contract["dependencies"];
  if (
    !Array.isArray(dependencies) ||
    dependencies.some((dependency) => {
      const item = record(dependency);
      return (
        !item ||
        typeof item["name"] !== "string" ||
        !["backend", "data", "external"].includes(String(item["kind"])) ||
        typeof item["required"] !== "boolean" ||
        Object.keys(item).some(
          (key) => !["name", "kind", "required", "url"].includes(key),
        )
      );
    })
  )
    errors["dependencies"] = [
      "must explicitly describe application dependencies",
    ];
  else if (
    dependencies.some((dependency) => record(dependency)?.["required"] === true)
  )
    errors["dependencies"] = [
      "required backend, data, and external dependencies are unsupported by static hosting",
    ];
  const fields = contract["public_configuration"];
  const names = new Set<string>();
  if (!Array.isArray(fields))
    errors["public_configuration"] = ["must be a list"];
  else
    for (const entry of fields) {
      const field = record(entry);
      const name = String(field?.["name"] ?? "");
      if (
        !field ||
        !/^[A-Za-z][A-Za-z0-9_]*$/.test(name) ||
        ["__proto__", "constructor", "prototype"].includes(name) ||
        names.has(name) ||
        !String(field["label"] ?? "").trim() ||
        !["string", "number", "boolean", "url"].includes(
          String(field["type"]),
        ) ||
        typeof field["required"] !== "boolean" ||
        Object.keys(field).some(
          (key) =>
            ![
              "name",
              "label",
              "type",
              "required",
              "default",
              "description",
            ].includes(key),
        )
      ) {
        errors["public_configuration"] = [
          "must contain uniquely named, typed public fields",
        ];
        continue;
      }
      names.add(name);
      if (
        field["default"] !== undefined &&
        !publicValueMatches(field["type"], field["default"])
      )
        errors["public_configuration"] = [
          "contains a default with the wrong type",
        ];
    }
  const source = body["source_project"];
  if (source !== undefined && source !== null) {
    const project = record(source);
    if (
      !project ||
      project["provider"] !== "github" ||
      !/^[A-Za-z0-9_.-]+$/.test(String(project["owner"] ?? "")) ||
      !/^[A-Za-z0-9_.-]+$/.test(String(project["repository"] ?? "")) ||
      !/^[a-f0-9]{40}$/i.test(String(project["commit"] ?? "")) ||
      !isArchivePath(project["project_directory"], true) ||
      !isArchivePath(project["output_directory"]) ||
      !String(project["build_command"] ?? "").trim() ||
      !/^\d{1,2}(?:\.\d{1,2})?$/.test(String(project["runtime"] ?? "")) ||
      Object.keys(project).some(
        (key) =>
          ![
            "provider",
            "owner",
            "repository",
            "commit",
            "project_directory",
            "build_command",
            "output_directory",
            "runtime",
          ].includes(key),
      )
    )
      errors["source_project"] = [
        "requires pinned GitHub source, relative directories, build command, and a numeric Node.js version",
      ];
  }
  return errors;
}

function publicValueMatches(type: unknown, value: unknown): boolean {
  if (type === "number")
    return typeof value === "number" && Number.isFinite(value);
  if (type === "boolean") return typeof value === "boolean";
  if (typeof value !== "string") return false;
  if (type !== "url") return true;
  return /^https?:\/\/[A-Za-z0-9.-]+(?::[0-9]{1,5})?(?:[/?#][^\s]*)?$/.test(
    value,
  );
}

export function publicConfigurationErrors(
  contract: StaticSmartRuntimeContract,
  values: Record<string, unknown>,
): ValidationErrors {
  const errors: ValidationErrors = {};
  const fields = new Map(
    contract.public_configuration.map((field) => [field.name, field]),
  );
  for (const name of Object.keys(values))
    if (!fields.has(name)) errors[name] = ["is not a declared public setting"];
  for (const field of fields.values()) {
    const value = values[field.name] ?? field.default;
    if (value === undefined || value === "") {
      if (field.required) errors[field.name] = ["is required"];
    } else if (!publicValueMatches(field.type, value))
      errors[field.name] = ["has the wrong type"];
  }
  return errors;
}
