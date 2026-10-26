// Author: Preston Lee

import assert from "node:assert/strict";
import crypto from "node:crypto";
import dns from "node:dns/promises";
import https from "node:https";
import { EventEmitter } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import { Readable } from "node:stream";
import type { IncomingMessage } from "node:http";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { before, after, beforeEach, afterEach, test, mock } from "node:test";
import { getPrisma, disconnectPrisma } from "../src/db/prisma.js";
import { loadHostingConfig } from "../src/hosted/config.js";
import { encrypt } from "../src/hosted/github.js";
import { HostingError } from "../src/hosted/access.js";
import {
  resolveArtifact,
  downloadResolvedArchive,
} from "../src/integrations/artifacts.js";
import type { BuildArtifact } from "../src/integrations/catalog-contract.js";

const databaseUrl =
  process.env.FHIR_STUDIO_INTEGRATION_TEST_DATABASE_URL ||
  "postgresql://fhir_studio_test:fhir-studio-test-only@127.0.0.1:55487/fhir_studio_integration";
const originalEnv = { ...process.env };
const realFetch = globalThis.fetch;
const ids = {
  users: [crypto.randomUUID(), crypto.randomUUID()],
  role: crypto.randomUUID(),
};
const bytes = Buffer.from("bounded-static-release-bytes");
const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
let root: string;
let remote: GitHubSource;
let fileSequence = 0;

class GitHubSource {
  status = 302;
  location =
    "https://objects.githubusercontent.com/archive.zip?temporary=download";
  expired = false;
  digest = `sha256:${sha256}`;
  deniedToken = "";
  body: Uint8Array[] = [bytes];
  readonly calls: Array<{
    path: string;
    accept: string | null;
    token: string | null;
    redirect?: RequestRedirect;
  }> = [];
  async fetch(
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> {
    const url = new URL(
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url,
    );
    assert.equal(
      url.hostname,
      "api.github.com",
      "Provider tests never contact remote services.",
    );
    const headers = new Headers(init?.headers);
    const call = {
      path: url.pathname,
      accept: headers.get("accept"),
      token: headers.get("authorization"),
      redirect: init?.redirect,
    };
    this.calls.push(call);
    if (call.token === this.deniedToken)
      return Response.json(
        { message: "Repository unavailable for this user" },
        { status: 404 },
      );
    if (url.pathname === "/repos/publisher/release")
      return Response.json({ id: 1, private: true });
    if (url.pathname === "/repos/publisher/release/actions/artifacts/456")
      return Response.json({
        id: 456,
        expired: this.expired,
        digest: this.digest,
      });
    if (
      url.pathname === "/repos/publisher/release/releases/assets/123" &&
      call.accept !== "application/octet-stream"
    )
      return Response.json({ id: 123, name: "release.zip" });
    assert.ok(
      url.pathname === "/repos/publisher/release/releases/assets/123" ||
        url.pathname === "/repos/publisher/release/actions/artifacts/456/zip",
      `Unexpected provider operation: ${url.pathname}`,
    );
    assert.equal(call.accept, "application/octet-stream");
    assert.equal(call.redirect, "manual");
    if (this.status === 200) {
      const chunks = [...this.body];
      return new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            const next = chunks.shift();
            if (next) controller.enqueue(next);
            else controller.close();
          },
        }),
        { headers: { "Content-Type": "application/octet-stream" } },
      );
    }
    return new Response(null, {
      status: this.status,
      headers: { location: this.location },
    });
  }
}
function release(): BuildArtifact {
  return {
    id: crypto.randomUUID(),
    build_id: crypto.randomUUID(),
    name: "Private release",
    format_version: 1,
    resolver: "github-release",
    locator: { owner: "publisher", repository: "release", asset_id: "123" },
    immutable_id: "pinned-release",
    sha256,
    archive_root: "",
  };
}
function actions(): BuildArtifact {
  return {
    ...release(),
    resolver: "github-actions",
    locator: { owner: "publisher", repository: "release", artifact_id: "456" },
  };
}
const destination = () => path.join(root, `archive-${++fileSequence}.zip`);

before(async () => {
  assert.ok(
    new URL(databaseUrl).pathname.includes("integration"),
    "Use the disposable integration database.",
  );
  root = await mkdtemp(path.join(os.tmpdir(), "studio-provider-integration-"));
  Object.assign(process.env, {
    NODE_ENV: "test",
    FHIR_STUDIO_SERVER_DATABASE_URL: databaseUrl,
    DATABASE_URL: databaseUrl,
    FHIR_STUDIO_HOSTING_ENABLED: "true",
    FHIR_STUDIO_HOSTING_ROOT: root,
    FHIR_STUDIO_HOSTING_DOMAIN: "apps.studio.example",
    FHIR_STUDIO_HOSTING_STUDIO_ORIGIN: "https://studio.example",
    FHIR_STUDIO_SERVER_UI_BASE_URL: "https://studio.example",
    FHIR_STUDIO_HOSTING_ANALYTICS_KEY: crypto
      .randomBytes(32)
      .toString("base64"),
    FHIR_STUDIO_HOSTING_ENCRYPTION_KEY: crypto
      .randomBytes(32)
      .toString("base64"),
    FHIR_STUDIO_HOSTING_GITHUB_APP_ID: "1",
    FHIR_STUDIO_HOSTING_GITHUB_CLIENT_ID: "test-client",
    FHIR_STUDIO_HOSTING_GITHUB_CLIENT_SECRET: "test-secret",
    FHIR_STUDIO_HOSTING_GITHUB_SLUG: "studio-test",
    FHIR_STUDIO_HOSTING_GITHUB_WEBHOOK_SECRET: "test-hook",
    FHIR_STUDIO_HOSTING_GITHUB_PRIVATE_KEY: crypto.generateKeyPairSync("rsa", {
      modulusLength: 2048,
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" },
    }).privateKey,
  });
  const db = getPrisma();
  await db.role.create({
    data: {
      id: ids.role,
      name: `Provider test ${ids.role}`,
      permission_applications_deployment: true,
    },
  });
  for (const [index, userId] of ids.users.entries()) {
    await db.user.create({
      data: {
        id: userId,
        ssoIssuer: `provider-${ids.role}`,
        ssoSubject: userId,
      },
    });
    await db.appointment.create({
      data: { entityType: "User", entityId: userId, roleId: ids.role },
    });
    await db.gitHubConnection.create({
      data: {
        userId,
        githubUserId: userId,
        login: `actor-${index}`,
        encryptedTokens: encrypt(
          {
            access_token: `provider-actor-${index}`,
            refresh_token: "test-refresh",
            expires_in: 3600,
            refresh_token_expires_in: 86400,
          },
          loadHostingConfig(),
        ),
        expiresAt: new Date(Date.now() + 3600_000),
        refreshExpiresAt: new Date(Date.now() + 86400_000),
      },
    });
  }
});
beforeEach(() => {
  remote = new GitHubSource();
  globalThis.fetch = remote.fetch.bind(remote);
});
afterEach(() => {
  globalThis.fetch = realFetch;
  mock.restoreAll();
  syncBuiltinESMExports();
});
after(async () => {
  const db = getPrisma();
  await db.appointment.deleteMany({ where: { roleId: ids.role } });
  await db.role.deleteMany({ where: { id: ids.role } });
  await db.user.deleteMany({ where: { id: { in: ids.users } } });
  await disconnectPrisma();
  if (root) await rm(root, { recursive: true, force: true });
  for (const key of Object.keys(process.env))
    if (!(key in originalEnv)) delete process.env[key];
  Object.assign(process.env, originalEnv);
});

test("GitHub release access and downloads use the acting user token with an explicit metadata check", async () => {
  assert.equal(
    await resolveArtifact(release(), ids.users[0]!),
    remote.location,
  );
  assert.deepEqual(
    remote.calls.map((call) => call.path),
    [
      "/repos/publisher/release",
      "/repos/publisher/release/releases/assets/123",
      "/repos/publisher/release/releases/assets/123",
    ],
  );
  assert.ok(
    remote.calls.every((call) => call.token === "Bearer provider-actor-0"),
  );
  remote.calls.length = 0;
  assert.equal(
    await resolveArtifact(release(), ids.users[1]!),
    remote.location,
  );
  assert.ok(
    remote.calls.every((call) => call.token === "Bearer provider-actor-1"),
  );
  remote.calls.length = 0;
  remote.deniedToken = "Bearer provider-actor-1";
  await assert.rejects(
    resolveArtifact(release(), ids.users[1]!),
    (error) => error instanceof HostingError,
  );
  assert.equal(remote.calls.length, 1);
  assert.equal(remote.calls[0]!.accept, "application/vnd.github+json");
});

test("Actions sources reject expired artifacts and mismatched digests before requesting archive bytes", async () => {
  remote.expired = true;
  await assert.rejects(
    resolveArtifact(actions(), ids.users[0]!),
    (error) => error instanceof HostingError && error.status === 410,
  );
  assert.ok(
    remote.calls.every((call) => call.accept !== "application/octet-stream"),
  );
  remote.calls.length = 0;
  remote.expired = false;
  remote.digest = `sha256:${"b".repeat(64)}`;
  await assert.rejects(
    resolveArtifact(actions(), ids.users[0]!),
    (error) => error instanceof HostingError && error.status === 400,
  );
  assert.ok(
    remote.calls.every((call) => call.accept !== "application/octet-stream"),
  );
  remote.calls.length = 0;
  remote.digest = `sha256:${sha256}`;
  assert.equal(
    await resolveArtifact(actions(), ids.users[1]!),
    remote.location,
  );
  assert.ok(
    remote.calls.every((call) => call.token === "Bearer provider-actor-1"),
  );
  assert.equal(
    remote.calls.at(-1)!.path,
    "/repos/publisher/release/actions/artifacts/456/zip",
  );
});

test("release assets support direct HTTP 200 streams and hash the bounded bytes without a redirect", async () => {
  remote.status = 200;
  const file = destination();
  const source = await resolveArtifact(release(), ids.users[0]!);
  assert.ok(source instanceof Response);
  assert.equal(
    await downloadResolvedArchive(
      source,
      file,
      100,
      new AbortController().signal,
    ),
    sha256,
  );
  assert.deepEqual(await readFile(file), bytes);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
});

test("direct release streams enforce byte limits even without a Content-Length header", async () => {
  remote.status = 200;
  remote.body = [Buffer.alloc(6, 1), Buffer.alloc(6, 2)];
  const source = await resolveArtifact(release(), ids.users[0]!);
  await assert.rejects(
    downloadResolvedArchive(
      source,
      destination(),
      10,
      new AbortController().signal,
    ),
    /limit|large|exceed/i,
  );
});

test("GitHub redirect destinations reject lookalike hosts, credentials, and non-HTTPS origins before network access", async () => {
  const network = mock.method(https, "get", () => {
    throw new Error("Unsafe redirect reached a network call.");
  });
  for (const location of [
    "https://objects.githubusercontent.com.evil.example/archive.zip",
    "http://objects.githubusercontent.com/archive.zip",
    "https://secret@objects.githubusercontent.com/archive.zip",
    "https://objects.githubusercontent.com:8443/archive.zip",
  ]) {
    remote.location = location;
    await assert.rejects(async () => {
      const source = await resolveArtifact(release(), ids.users[0]!);
      await downloadResolvedArchive(
        source,
        destination(),
        100,
        new AbortController().signal,
      );
    });
  }
  assert.equal(network.mock.callCount(), 0);
});

function mockPublicTransport(
  hops: Array<{
    url: string;
    status: number;
    location?: string;
    body?: Buffer;
  }>,
) {
  const requests: Array<{ target: string; options: https.RequestOptions }> = [];
  mock.method(dns, "lookup", async () => [
    { address: "93.184.216.34", family: 4 },
  ]);
  syncBuiltinESMExports();
  mock.method(
    https,
    "get",
    (
      target: URL,
      options: https.RequestOptions,
      callback: (response: IncomingMessage) => void,
    ) => {
      const hop = hops.shift();
      assert.ok(hop, "Unexpected public network hop");
      assert.equal(target.href, hop.url);
      requests.push({ target: target.href, options });
      const response = Object.assign(
        Readable.from(hop.body ? [hop.body] : []),
        {
          statusCode: hop.status,
          headers: hop.location ? { location: hop.location } : {},
        },
      ) as IncomingMessage;
      queueMicrotask(() => callback(response));
      return new EventEmitter();
    },
  );
  return requests;
}

test("signed download redirects never forward actor credentials across origins and pin each DNS lookup", async () => {
  remote.location =
    "https://objects.githubusercontent.com/archive.zip?signed=one";
  const target = "https://release-downloads.example.org/archive.zip?signed=two";
  const requests = mockPublicTransport([
    { url: remote.location, status: 302, location: target },
    { url: target, status: 200, body: bytes },
  ]);
  const file = destination();
  const source = await resolveArtifact(release(), ids.users[0]!);
  assert.equal(
    await downloadResolvedArchive(
      source,
      file,
      100,
      new AbortController().signal,
    ),
    sha256,
  );
  assert.deepEqual(await readFile(file), bytes);
  assert.equal(requests.length, 2);
  for (const request of requests) {
    assert.equal(
      new Headers(request.options.headers as HeadersInit).get("authorization"),
      null,
    );
    assert.equal(request.options.family, 4);
    assert.equal(typeof request.options.lookup, "function");
    const lookup = request.options.lookup as (
      hostname: string,
      options: unknown,
      callback: (error: Error | null, address: string, family: number) => void,
    ) => void;
    await new Promise<void>((resolve, reject) =>
      lookup(
        "this-must-not-trigger-a-new-lookup.example",
        {},
        (error, address, family) => {
          if (error) {
            reject(error);
            return;
          }
          assert.equal(address, "93.184.216.34");
          assert.equal(family, 4);
          resolve();
        },
      ),
    );
  }
  assert.ok(
    remote.calls.every((call) => call.token === "Bearer provider-actor-0"),
  );
});

test("a redirect resolving to a private address stops before the second HTTPS request", async () => {
  const destinationUrl = "https://objects.githubusercontent.com/archive.zip";
  const requests = mockPublicTransport([
    {
      url: destinationUrl,
      status: 302,
      location: "https://storage.example.org/archive.zip",
    },
  ]);
  let lookups = 0;
  mock.method(dns, "lookup", async () => [
    { address: ++lookups === 1 ? "93.184.216.34" : "127.0.0.1", family: 4 },
  ]);
  syncBuiltinESMExports();
  await assert.rejects(
    downloadResolvedArchive(
      destinationUrl,
      destination(),
      100,
      new AbortController().signal,
    ),
    /private|reserved/,
  );
  assert.equal(requests.length, 1);
});
