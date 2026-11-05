/**
 * SMART public client for a FHIR Studio hosted application.
 * Only the short-lived PKCE transaction crosses the authorization redirect.
 * Access tokens and clinical data stay in memory; reload by launching in Studio.
 * @typedef {import('../../types.js').SmartSession} SmartSession
 * @typedef {import('../../types.js').FhirResource} FhirResource
 * @typedef {import('../../types.js').FhirBundle} FhirBundle
 */

/** @param {unknown} value @returns {Record<string, unknown>} */
function object(value) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Expected a JSON object.");
  return /** @type {Record<string, unknown>} */ (value);
}

/** @param {unknown} value @param {string} label @returns {string} */
function requiredString(value, label) {
  if (typeof value !== "string" || !value.trim())
    throw new Error(`Missing ${label}. Launch the app again from FHIR Studio.`);
  return value;
}

/** @param {string} value @returns {URL} */
function httpUrl(value) {
  const url = new URL(value);
  if (
    url.username ||
    url.password ||
    url.hash ||
    (url.protocol !== "https:" &&
      !(
        url.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
      ))
  ) {
    throw new Error(
      "SMART endpoints must use HTTPS (HTTP is allowed only on loopback for development).",
    );
  }
  return url;
}

/** Trust the instance's runtime configuration, never a URL supplied by a FHIR resource.
 * @param {string} issuer @param {string} studioOrigin @returns {string}
 */
export function validateIssuer(issuer, studioOrigin) {
  const url = httpUrl(issuer);
  const studio = httpUrl(studioOrigin);
  if (
    studio.origin !== studioOrigin ||
    url.origin !== studio.origin ||
    url.search ||
    !/^\/api\/sandboxes\/[^/]+\/fhir\/(R4|R4B|R5)\/?$/i.test(url.pathname)
  ) {
    throw new Error(
      "The launch issuer does not belong to this FHIR Studio instance.",
    );
  }
  return url.href.replace(/\/$/, "");
}

/** @param {string} verifier @returns {Promise<string>} */
export async function pkceChallenge(verifier) {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)),
  );
  return btoa(String.fromCharCode(...digest))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function random() {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)), (value) =>
    value.toString(16).padStart(2, "0"),
  ).join("");
}

/** @param {Response} response @param {string} message @returns {Promise<unknown>} */
async function jsonResponse(response, message) {
  const data = /** @type {unknown} */ (await response.json().catch(() => null));
  if (!response.ok) {
    const body = data && typeof data === "object" ? object(data) : {};
    const issue = Array.isArray(body.issue) ? body.issue[0] : null;
    const detail =
      issue && typeof issue === "object"
        ? object(issue).diagnostics
        : body.error_description;
    throw new Error(
      `${message} (${response.status})${typeof detail === "string" ? `: ${detail}` : ""}`,
    );
  }
  return data;
}

/** @returns {Promise<SmartSession | null>} */
export async function startSmart() {
  const config = object(
    await jsonResponse(
      await fetch("/_studio/config.json", {
        credentials: "omit",
        cache: "no-store",
        redirect: "error",
      }),
      "FHIR Studio runtime configuration is unavailable",
    ),
  );
  if (config.runtimeContractVersion !== 1)
    throw new Error("Unsupported FHIR Studio runtime configuration version.");
  const clientId = requiredString(config.clientId, "SMART client ID");
  const studioOrigin = requiredString(config.studioOrigin, "Studio origin");
  const scope = requiredString(config.scope, "SMART scopes");
  const callbackPath = requiredString(
    config.callbackPath,
    "SMART callback path",
  );
  if (!/^(?!\/)(?!.*(?:^|\/)\.)(?!.*[?#\\:])[\w./-]+\.html$/.test(callbackPath))
    throw new Error("Invalid SMART callback path.");
  const redirectUri = new URL(callbackPath, `${location.origin}/`).href;
  const params = new URLSearchParams(location.search);
  const prefix = `viets-ehr:smart:${clientId}:`;
  const state = params.get("state");

  if (params.has("code") || params.has("error")) {
    if (!state)
      throw new Error(
        "Missing SMART state. Launch the app again from FHIR Studio.",
      );
    const key = prefix + state;
    const stored = sessionStorage.getItem(key);
    if (!stored)
      throw new Error(
        "SMART state mismatch or authorization already completed. Launch again from FHIR Studio.",
      );
    sessionStorage.removeItem(key);
    history.replaceState(null, "", location.pathname);
    const saved = object(/** @type {unknown} */ (JSON.parse(stored)));
    if (
      saved.state !== state ||
      saved.redirectUri !== redirectUri ||
      typeof saved.createdAt !== "number" ||
      Date.now() - saved.createdAt > 10 * 60_000 ||
      saved.createdAt > Date.now()
    ) {
      throw new Error(
        "SMART authorization expired or state mismatch. Launch again from FHIR Studio.",
      );
    }
    if (params.has("error"))
      throw new Error(
        `SMART authorization failed: ${params.get("error_description") || params.get("error")}`,
      );
    const issuer = validateIssuer(
      requiredString(saved.issuer, "saved issuer"),
      studioOrigin,
    );
    const tokenEndpoint = httpUrl(
      requiredString(saved.tokenEndpoint, "token endpoint"),
    );
    if (tokenEndpoint.origin !== studioOrigin)
      throw new Error("Unapproved SMART token endpoint.");
    const token = object(
      await jsonResponse(
        await fetch(tokenEndpoint, {
          method: "POST",
          credentials: "omit",
          cache: "no-store",
          redirect: "error",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            Accept: "application/json",
          },
          body: new URLSearchParams({
            grant_type: "authorization_code",
            code: requiredString(params.get("code"), "authorization code"),
            client_id: clientId,
            redirect_uri: redirectUri,
            code_verifier: requiredString(saved.verifier, "PKCE verifier"),
          }),
        }),
        "SMART token exchange failed",
      ),
    );
    if (
      typeof token.token_type !== "string" ||
      token.token_type.toLowerCase() !== "bearer"
    )
      throw new Error("SMART did not return a bearer token.");
    const patient = requiredString(token.patient, "launch patient");
    if (!/^[A-Za-z0-9.-]{1,64}$/.test(patient))
      throw new Error("Invalid SMART patient context.");
    const duration = Number(token.expires_in);
    if (!Number.isFinite(duration) || duration <= 0)
      throw new Error("SMART token has no valid expiration.");
    return {
      issuer,
      clientId,
      studioOrigin,
      patient,
      accessToken: requiredString(token.access_token, "access token"),
      scope: typeof token.scope === "string" ? token.scope : scope,
      expiresAt: Date.now() + duration * 1000,
      ...(typeof token.encounter === "string"
        ? { encounter: token.encounter }
        : {}),
    };
  }

  if (!params.has("iss") || !params.has("launch")) {
    throw new Error(
      "Launch Viet’s EHR from FHIR Studio with a sandbox and patient selected. An ordinary page refresh starts a new session and requires a new launch.",
    );
  }
  const issuer = validateIssuer(
    requiredString(params.get("iss"), "launch issuer"),
    studioOrigin,
  );
  const discovery = object(
    await jsonResponse(
      await fetch(`${issuer}/.well-known/smart-configuration`, {
        credentials: "omit",
        cache: "no-store",
        redirect: "error",
        headers: { Accept: "application/json" },
      }),
      "SMART discovery failed",
    ),
  );
  const authorizationEndpoint = httpUrl(
    requiredString(discovery.authorization_endpoint, "authorization endpoint"),
  );
  const tokenEndpoint = httpUrl(
    requiredString(discovery.token_endpoint, "token endpoint"),
  );
  if (
    [authorizationEndpoint, tokenEndpoint].some(
      (url) => url.origin !== studioOrigin,
    )
  )
    throw new Error(
      "SMART discovery returned an endpoint outside this Studio instance.",
    );
  if (
    Array.isArray(discovery.code_challenge_methods_supported) &&
    !discovery.code_challenge_methods_supported.includes("S256")
  ) {
    throw new Error("The SMART server does not support PKCE S256.");
  }
  // Remove expired transactions without retaining sandbox identifiers indefinitely.
  for (const key of Object.keys(sessionStorage).filter((key) =>
    key.startsWith(prefix),
  )) {
    try {
      const previous = object(
        /** @type {unknown} */ (
          JSON.parse(sessionStorage.getItem(key) || "null")
        ),
      );
      if (
        typeof previous.createdAt !== "number" ||
        Date.now() - previous.createdAt > 10 * 60_000
      )
        sessionStorage.removeItem(key);
    } catch {
      sessionStorage.removeItem(key);
    }
  }
  const verifier = random(),
    nextState = random();
  sessionStorage.setItem(
    prefix + nextState,
    JSON.stringify({
      issuer,
      verifier,
      state: nextState,
      tokenEndpoint: tokenEndpoint.href,
      redirectUri,
      createdAt: Date.now(),
    }),
  );
  const authParams = {
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    scope,
    aud: issuer,
    launch: requiredString(params.get("launch"), "EHR launch context"),
    state: nextState,
    code_challenge: await pkceChallenge(verifier),
    code_challenge_method: "S256",
  };
  for (const [key, value] of Object.entries(authParams))
    authorizationEndpoint.searchParams.set(key, value);
  history.replaceState(null, "", location.pathname);
  location.replace(authorizationEndpoint.href);
  return null;
}

/** @param {string} scopes @param {string} type @param {'c'|'r'|'u'|'d'|'s'} permission */
export function scopeAllows(scopes, type, permission) {
  return scopes.split(/\s+/).some((scope) => {
    const match = /^(?:patient|user)\/([A-Za-z]+|\*)\.([a-z*]+)$/.exec(scope);
    if (!match || (match[1] !== "*" && match[1] !== type)) return false;
    const actions =
      match[2] === "read" ? "rs" : match[2] === "write" ? "cud" : match[2];
    return actions === "*" || actions.includes(permission);
  });
}

/** Refuse cross-server pagination links and token-bearing redirects.
 * @param {string} issuer @param {string} resource @returns {URL}
 */
export function fhirUrl(issuer, resource) {
  const base = new URL(`${issuer.replace(/\/$/, "")}/`);
  const url = new URL(resource, base);
  if (
    url.origin !== base.origin ||
    !url.pathname.startsWith(base.pathname) ||
    url.username ||
    url.password ||
    url.hash
  ) {
    throw new Error("Refusing a FHIR request outside the launched sandbox.");
  }
  return url;
}

/** The gateway returns public absolute references. Store same-server references
 * relatively so HAPI indexes them in the selected sandbox's patient compartment.
 * External references and canonical URLs retain their original meaning.
 * @param {unknown} value @param {string} issuer @returns {unknown}
 */
export function relativeFhirReferences(value, issuer) {
  if (Array.isArray(value))
    return value.map((item) => relativeFhirReferences(item, issuer));
  if (!value || typeof value !== "object") return value;
  const prefix = `${issuer.replace(/\/$/, "")}/`;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => {
      if (
        key === "reference" &&
        typeof item === "string" &&
        item.startsWith(prefix)
      ) {
        const relative = item.slice(prefix.length);
        if (
          /^[A-Z][A-Za-z]+\/[A-Za-z0-9.-]{1,64}(?:\/_history\/[A-Za-z0-9.-]{1,64})?$/.test(
            relative,
          )
        )
          return [key, relative];
      }
      return [key, relativeFhirReferences(item, issuer)];
    }),
  );
}

export class FhirClient {
  /** @param {SmartSession} session */
  constructor(session) {
    this.session = session;
    this.fhirVersion = /\/R5$/i.test(session.issuer)
      ? "R5"
      : /\/R4B$/i.test(session.issuer)
        ? "R4B"
        : "R4";
  }

  /** @param {string} type @param {'c'|'r'|'u'|'d'|'s'} permission */
  can(type, permission) {
    return scopeAllows(this.session.scope, type, permission);
  }

  /** @param {string} resource @param {RequestInit} [options] @returns {Promise<FhirResource>} */
  async request(resource, options = {}) {
    if (Date.now() >= this.session.expiresAt)
      throw new Error(
        "SMART session expired. Relaunch Viet’s EHR from FHIR Studio.",
      );
    const headers = new Headers(options.headers);
    headers.set("Authorization", `Bearer ${this.session.accessToken}`);
    headers.set("Accept", "application/fhir+json");
    const response = await fetch(fhirUrl(this.session.issuer, resource), {
      ...options,
      headers,
      credentials: "omit",
      cache: "no-store",
      redirect: "error",
    });
    if (response.status === 401)
      throw new Error(
        "SMART session is no longer authorized. Relaunch Viet’s EHR from FHIR Studio.",
      );
    const body = object(await jsonResponse(response, "FHIR request failed"));
    requiredString(body.resourceType, "FHIR resource type");
    return /** @type {FhirResource} */ (body);
  }

  /** @param {string} type @param {string} id @returns {Promise<FhirResource>} */
  read(type, id) {
    return this.request(
      `${encodeURIComponent(type)}/${encodeURIComponent(id)}`,
    );
  }

  /** @param {string} type @param {Record<string, string | number>} [params] @returns {Promise<FhirBundle>} */
  async search(type, params = {}) {
    const query = new URLSearchParams(
      Object.entries(params).map(([key, value]) => [key, String(value)]),
    );
    const resource = await this.request(`${encodeURIComponent(type)}?${query}`);
    if (resource.resourceType !== "Bundle")
      throw new Error("FHIR search did not return a Bundle.");
    return /** @type {FhirBundle} */ (resource);
  }

  /** @param {FhirResource} resource @returns {Promise<FhirResource>} */
  create(resource) {
    if (!this.can(resource.resourceType, "c"))
      throw new Error(
        `Create permission was not granted for ${resource.resourceType}.`,
      );
    return this.request(encodeURIComponent(resource.resourceType), {
      method: "POST",
      headers: {
        "Content-Type": "application/fhir+json",
        Prefer: "return=representation",
      },
      body: JSON.stringify(
        relativeFhirReferences(resource, this.session.issuer),
      ),
    });
  }

  /** @param {FhirResource} resource @returns {Promise<FhirResource>} */
  update(resource) {
    if (!this.can(resource.resourceType, "u"))
      throw new Error(
        `Update permission was not granted for ${resource.resourceType}.`,
      );
    if (!resource.id || !/^[A-Za-z0-9.-]{1,64}$/.test(resource.id))
      throw new Error("A valid FHIR resource ID is required for update.");
    const meta =
      resource.meta && typeof resource.meta === "object"
        ? object(resource.meta)
        : {};
    const headers = new Headers({
      "Content-Type": "application/fhir+json",
      Prefer: "return=representation",
    });
    if (
      typeof meta.versionId === "string" &&
      /^[A-Za-z0-9.-]{1,64}$/.test(meta.versionId)
    )
      headers.set("If-Match", `W/"${meta.versionId}"`);
    return this.request(
      `${encodeURIComponent(resource.resourceType)}/${encodeURIComponent(resource.id)}`,
      {
        method: "PUT",
        headers,
        body: JSON.stringify(
          relativeFhirReferences(resource, this.session.issuer),
        ),
      },
    );
  }
}
