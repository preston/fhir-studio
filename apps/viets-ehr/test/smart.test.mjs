import assert from "node:assert/strict";
import { test } from "node:test";
import {
  FhirClient,
  fhirUrl,
  pkceChallenge,
  relativeFhirReferences,
  scopeAllows,
  startSmart,
  validateIssuer,
} from "../public/js/smart.js";

const studioOrigin = "https://studio.example.org";
const issuer = `${studioOrigin}/api/sandboxes/sandbox-one/fhir/R4`;
const session = {
  issuer,
  studioOrigin,
  clientId: "hosted-test-preview",
  patient: "patient-one",
  accessToken: "test-access-token",
  expiresAt: Date.now() + 3_600_000,
  scope: "launch patient/*.crus user/Questionnaire.rs",
};

test("PKCE uses the RFC 7636 S256 test vector", async () => {
  assert.equal(
    await pkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
    "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
  );
});

test("issuer and pagination URLs cannot switch sandbox or origin", () => {
  for (const version of ["R4", "R4B", "R5"])
    assert.equal(
      validateIssuer(issuer.replace(/R4$/, version), studioOrigin),
      issuer.replace(/R4$/, version),
    );
  for (const unsafe of [
    "https://other.example.org/api/sandboxes/s/fhir/R4",
    `${issuer}?url=other`,
    `${issuer}#other`,
    `${studioOrigin}/oauth/token`,
    issuer.replace("https:", "http:"),
  ]) {
    assert.throws(() => validateIssuer(unsafe, studioOrigin));
  }
  assert.equal(
    fhirUrl(issuer, "Observation?patient=patient-one").href,
    `${issuer}/Observation?patient=patient-one`,
  );
  for (const unsafe of [
    "https://other.example.org/Observation",
    "/oauth/token",
    "../R5/Patient",
    `${issuer}-other/Patient`,
    `${issuer}/Patient#fragment`,
    "//other.example.org/Patient",
  ])
    assert.throws(() => fhirUrl(issuer, unsafe));
});

test("UI capability checks honor granular and legacy grants and never broaden filtered scopes", () => {
  assert.equal(scopeAllows("patient/Observation.rs", "Observation", "r"), true);
  assert.equal(scopeAllows("patient/*.crus", "ServiceRequest", "u"), true);
  assert.equal(scopeAllows("patient/*.rs", "Observation", "c"), false);
  assert.equal(
    scopeAllows(
      "patient/Observation.rs?category=laboratory",
      "Observation",
      "r",
    ),
    false,
  );
  assert.equal(
    scopeAllows("patient/Observation.read", "Observation", "s"),
    true,
  );
  assert.equal(
    scopeAllows("user/Questionnaire.rs", "Questionnaire", "s"),
    true,
  );
  assert.equal(scopeAllows("system/*.cruds", "Patient", "r"), false);
});

test("saving rewritten resources preserves sandbox indexing without rewriting external or canonical references", () => {
  const resource = {
    resourceType: "Observation",
    subject: { reference: `${issuer}/Patient/patient-one` },
    performer: [
      { reference: `${issuer}/Practitioner/practitioner-one` },
      { reference: "https://external.example.org/Practitioner/other" },
    ],
    derivedFrom: [{ reference: `${issuer}/Observation/source/_history/2` }],
    meta: { profile: [`${issuer}/StructureDefinition/custom`] },
  };
  assert.deepEqual(relativeFhirReferences(resource, issuer), {
    ...resource,
    subject: { reference: "Patient/patient-one" },
    performer: [
      { reference: "Practitioner/practitioner-one" },
      { reference: "https://external.example.org/Practitioner/other" },
    ],
    derivedFrom: [{ reference: "Observation/source/_history/2" }],
  });
  assert.equal(resource.subject.reference, `${issuer}/Patient/patient-one`);
});

/** Mock only the browser environment; requests still go through the real SMART client. */
async function browser(run) {
  const names = ["location", "history", "sessionStorage", "fetch"];
  const original = new Map(
    names.map((name) => [
      name,
      Object.getOwnPropertyDescriptor(globalThis, name),
    ]),
  );
  const storage = {};
  const transactions = [];
  const navigation = [];
  const runtime = {
    runtimeContractVersion: 1,
    clientId: session.clientId,
    studioOrigin,
    callbackPath: "index.html",
    scope: session.scope,
  };
  Object.defineProperties(storage, {
    getItem: { value: (key) => storage[key] ?? null },
    setItem: {
      value: (key, value) => {
        storage[key] = value;
      },
    },
    removeItem: {
      value: (key) => {
        delete storage[key];
      },
    },
  });
  const location = {
    origin: "https://preview-example.user.studio.example.org",
    pathname: "/index.html",
    search: `?iss=${encodeURIComponent(issuer)}&launch=opaque-launch`,
    replace: (value) => navigation.push(value),
  };
  const routes = new Map([
    ["/_studio/config.json", runtime],
    [
      `${issuer}/.well-known/smart-configuration`,
      {
        authorization_endpoint: `${studioOrigin}/oauth/authorize`,
        token_endpoint: `${studioOrigin}/oauth/token`,
        code_challenge_methods_supported: ["S256"],
      },
    ],
    [
      `${studioOrigin}/oauth/token`,
      {
        token_type: "Bearer",
        access_token: session.accessToken,
        patient: session.patient,
        expires_in: 3600,
        scope: session.scope,
      },
    ],
  ]);
  Object.defineProperties(globalThis, {
    location: { configurable: true, value: location },
    history: { configurable: true, value: { replaceState: () => {} } },
    sessionStorage: { configurable: true, value: storage },
    fetch: {
      configurable: true,
      value: async (url, options = {}) => {
        transactions.push({ url: String(url), options });
        assert.ok(routes.has(String(url)), `Unexpected URL ${url}`);
        return Response.json(routes.get(String(url)));
      },
    },
  });
  try {
    await run({ location, storage, navigation, transactions, routes });
  } finally {
    for (const name of names) {
      const descriptor = original.get(name);
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  }
}

test("EHR launch discovers endpoints, binds audience/context, exchanges code once, and stores no token", async () => {
  await browser(async ({ location, storage, navigation, transactions }) => {
    assert.equal(await startSmart(), null);
    const auth = new URL(navigation[0]);
    assert.equal(auth.origin, studioOrigin);
    for (const [key, expected] of Object.entries({
      aud: issuer,
      launch: "opaque-launch",
      client_id: session.clientId,
      response_type: "code",
      code_challenge_method: "S256",
    }))
      assert.equal(auth.searchParams.get(key), expected);
    const saved = JSON.parse(storage[Object.keys(storage)[0]]);
    assert.equal(
      auth.searchParams.get("code_challenge"),
      await pkceChallenge(saved.verifier),
    );
    location.search = `?code=one-use-code&state=${auth.searchParams.get("state")}`;
    const authorized = await startSmart();
    assert.equal(authorized.issuer, issuer);
    assert.equal(authorized.patient, session.patient);
    assert.equal(authorized.accessToken, session.accessToken);
    assert.deepEqual(Object.keys(storage), []);
    const tokenRequest = transactions.find((item) =>
      item.url.endsWith("/oauth/token"),
    );
    assert.equal(
      tokenRequest.options.body.get("code_verifier"),
      saved.verifier,
    );
    assert.equal(
      tokenRequest.options.body.get("redirect_uri"),
      `${location.origin}/index.html`,
    );
    assert.ok(
      transactions.every(
        (item) =>
          item.options.credentials === "omit" &&
          item.options.redirect === "error",
      ),
    );
    await assert.rejects(startSmart(), /state mismatch|already completed/);
  });
});

test("wrong state, expired transaction and foreign discovery fail before token exchange", async () => {
  await browser(async ({ location, navigation, transactions }) => {
    await startSmart();
    location.search = "?code=stolen&state=wrong-state";
    await assert.rejects(startSmart(), /state mismatch/);
    assert.equal(
      transactions.some((item) => item.url.endsWith("/oauth/token")),
      false,
    );
    assert.equal(navigation.length, 1);
  });
  await browser(async ({ location, storage, navigation, transactions }) => {
    await startSmart();
    const state = new URL(navigation[0]).searchParams.get("state");
    const key = Object.keys(storage)[0];
    storage[key] = JSON.stringify({
      ...JSON.parse(storage[key]),
      createdAt: Date.now() - 11 * 60_000,
    });
    location.search = `?code=expired&state=${state}`;
    await assert.rejects(startSmart(), /expired/);
    assert.deepEqual(Object.keys(storage), []);
    assert.equal(
      transactions.some((item) => item.url.endsWith("/oauth/token")),
      false,
    );
  });
  await browser(async ({ routes }) => {
    routes.set(`${issuer}/.well-known/smart-configuration`, {
      authorization_endpoint: "https://foreign.example.org/auth",
      token_endpoint: `${studioOrigin}/oauth/token`,
    });
    await assert.rejects(startSmart(), /outside this Studio instance/);
  });
});

test("FHIR requests use bearer auth without cookies, preserve update versions, and block expiry or foreign links", async () => {
  await browser(async ({ transactions, routes }) => {
    const resource = {
      resourceType: "Observation",
      id: "observation-one",
      status: "final",
      meta: { versionId: "7" },
    };
    routes.set(`${issuer}/Observation/observation-one`, resource);
    const client = new FhirClient(session);
    assert.deepEqual(await client.update(resource), resource);
    const request = transactions.at(-1);
    assert.equal(
      request.options.headers.get("Authorization"),
      `Bearer ${session.accessToken}`,
    );
    assert.equal(request.options.headers.get("If-Match"), 'W/"7"');
    assert.equal(request.options.credentials, "omit");
    assert.equal(request.options.redirect, "error");
    await assert.rejects(
      client.request("https://foreign.example.org/Observation"),
      /outside/,
    );
    await assert.rejects(
      new FhirClient({ ...session, expiresAt: 0 }).read(
        "Patient",
        session.patient,
      ),
      /expired/,
    );
    assert.throws(
      () =>
        new FhirClient({ ...session, scope: "patient/*.rs" }).create(resource),
      /not granted/,
    );
  });
});
