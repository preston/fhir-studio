// Author: Preston Lee

import assert from "node:assert/strict";
import crypto from "node:crypto";
import { before, after, test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Prisma } from "@prisma/client";
import { getPrisma, disconnectPrisma } from "../src/db/prisma.js";
import { loadHostingConfig } from "../src/hosted/config.js";
import { encrypt } from "../src/hosted/github.js";
import { HostingError } from "../src/hosted/access.js";
import { workflowPath } from "../src/hosted/source.js";
import { createEditableProject } from "../src/integrations/artifacts.js";
import { defaultStaticSmartContract } from "../src/integrations/catalog-contract.js";
import { digest, integrationScopes } from "../src/integrations/oauth.js";
import type { JobExecutionContext } from "../src/jobs/types.js";

const databaseUrl =
  process.env.FHIR_STUDIO_INTEGRATION_TEST_DATABASE_URL ||
  "postgresql://fhir_studio_test:fhir-studio-test-only@127.0.0.1:55487/fhir_studio_integration";
const originalEnv = { ...process.env };
const realFetch = globalThis.fetch;
const ids = {
  user: crypto.randomUUID(),
  role: crypto.randomUUID(),
  client: crypto.randomUUID(),
};
const sourceCommit = "a".repeat(40);
const sourceFiles = [
  { path: "index.html", content: "<html>SMART application</html>" },
  { path: "callback.html", content: "<html>SMART callback</html>" },
  { path: "package.json", content: '{"scripts":{"build":"vite build"}}' },
  { path: ".env.production", content: "MUST_NOT_COPY=secret" },
  { path: ".npmrc", content: "//npm.example/:_authToken=secret" },
  { path: "credentials.pem", content: "MUST_NOT_COPY_PRIVATE_KEY" },
  { path: ".github/workflows/source.yml", content: "MUST_NOT_COPY_WORKFLOW" },
];
const jobIds: string[] = [];
let root: string;
let sequence = 0;

class FakeGitHub {
  readonly repositoryId = 10000 + ++sequence;
  readonly name = `editable-test-${sequence}`;
  readonly fullName = `actor/${this.name}`;
  exists = false;
  installed = true;
  failure: "workflow" | null = null;
  beforeSourceMetadata: (() => Promise<void>) | null = null;
  readonly writes: Array<{
    path: string;
    method: string;
    body: Record<string, unknown>;
  }> = [];
  readonly sourceTrees: string[] = [];
  readonly sourceBlobReads: string[] = [];
  private head = "0".repeat(40);
  private readonly commits = new Map<string, string>([
    [this.head, "Initial commit"],
  ]);
  private nextCommit = 1;
  get repo() {
    return {
      id: this.repositoryId,
      full_name: this.fullName,
      default_branch: "main",
      private: true,
      archived: false,
      permissions: { push: true, pull: true },
    };
  }
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
      "No real network calls are permitted in this worker test.",
    );
    assert.equal(
      new Headers(init?.headers).get("authorization"),
      "Bearer actor-test-token",
    );
    const method = init?.method || "GET";
    const endpoint = url.pathname;
    const body = init?.body
      ? (JSON.parse(String(init.body)) as Record<string, unknown>)
      : {};
    if (method !== "GET") this.writes.push({ path: endpoint, method, body });
    if (endpoint === "/user") return Response.json({ id: 123, login: "actor" });
    if (endpoint === "/user/installations")
      return Response.json({
        installations: [
          { id: 7, account: { login: "actor" }, suspended_at: null },
        ],
      });
    if (endpoint === `/repos/${this.fullName}`)
      return this.exists
        ? Response.json({ ...this.repo, description: this.description })
        : Response.json({}, { status: 404 });
    if (endpoint === "/user/repos" && method === "POST") {
      assert.equal(body.name, this.name);
      this.description = String(body.description);
      this.exists = true;
      return Response.json(this.repo, { status: 201 });
    }
    if (endpoint === `/repositories/${this.repositoryId}`)
      return Response.json(this.repo);
    if (endpoint === "/repos/publisher/source") {
      if (this.beforeSourceMetadata) {
        const action = this.beforeSourceMetadata;
        this.beforeSourceMetadata = null;
        await action();
      }
      return Response.json({
        id: 42,
        full_name: "publisher/source",
        default_branch: "main",
        private: true,
        archived: false,
        permissions: { push: false, pull: true },
      });
    }
    if (endpoint === "/repositories/42")
      return Response.json({
        id: 42,
        full_name: "publisher/source",
        default_branch: "main",
        private: true,
        archived: false,
        permissions: { pull: true },
      });
    if (endpoint.startsWith("/repos/publisher/source/git/trees/")) {
      const commit = endpoint.split("/").at(-1)!;
      this.sourceTrees.push(commit);
      return Response.json({
        truncated: false,
        tree: sourceFiles.map((file, index) => ({
          path: file.path,
          type: "blob",
          mode: "100644",
          sha: `source-${index}`,
          size: Buffer.byteLength(file.content),
        })),
      });
    }
    if (endpoint.startsWith("/repos/publisher/source/git/blobs/source-")) {
      const index = Number(endpoint.split("-").at(-1));
      const file = sourceFiles[index]!;
      this.sourceBlobReads.push(file.path);
      return Response.json({
        encoding: "base64",
        content: Buffer.from(file.content).toString("base64"),
      });
    }
    const base = `/repos/${this.fullName}`;
    if (endpoint === `${base}/commits/main`)
      return Response.json({ sha: this.head });
    if (endpoint === `${base}/commits/${this.head}`)
      return Response.json({
        commit: { message: this.commits.get(this.head) },
      });
    if (endpoint === `${base}/git/trees/${this.head}`)
      return Response.json({
        truncated: false,
        tree: [
          { path: "README.md", type: "blob", mode: "100644", sha: "readme" },
        ],
      });
    if (endpoint === `${base}/git/ref/heads/main`)
      return Response.json({ object: { sha: this.head } });
    if (endpoint.startsWith(`${base}/git/commits/`) && method === "GET")
      return Response.json({ tree: { sha: "base-tree" } });
    if (endpoint === `${base}/git/blobs` && method === "POST")
      return Response.json({ sha: `copied-${this.writes.length}` });
    if (endpoint === `${base}/git/trees` && method === "POST") {
      const entries = body.tree as Array<{ path: string }>;
      if (
        this.failure === "workflow" &&
        entries.some((entry) => entry.path.startsWith(".github/workflows/"))
      ) {
        this.failure = null;
        return Response.json(
          { error: "Temporary GitHub outage" },
          { status: 503 },
        );
      }
      return Response.json({ sha: `tree-${this.writes.length}` });
    }
    if (endpoint === `${base}/git/commits` && method === "POST") {
      const sha = (++this.nextCommit).toString(16).padStart(40, "0");
      this.commits.set(sha, String(body.message));
      return Response.json({ sha });
    }
    if (endpoint === `${base}/git/refs/heads/main` && method === "PATCH") {
      assert.equal(body.force, false);
      this.head = String(body.sha);
      return Response.json({});
    }
    if (endpoint === "/user/installations/7/repositories")
      return Response.json({ repositories: this.installed ? [this.repo] : [] });
    if (
      endpoint.startsWith(`${base}/actions/workflows/`) &&
      endpoint.endsWith("/dispatches") &&
      method === "POST"
    )
      return new Response(null, { status: 204 });
    throw new Error(`Unexpected fake GitHub operation: ${method} ${endpoint}`);
  }
  description = "";
}

before(async () => {
  assert.ok(
    new URL(databaseUrl).pathname.includes("integration"),
    "Use the disposable integration database.",
  );
  root = await mkdtemp(path.join(os.tmpdir(), "studio-editable-worker-"));
  Object.assign(process.env, {
    NODE_ENV: "test",
    FHIR_STUDIO_SERVER_DATABASE_URL: databaseUrl,
    DATABASE_URL: databaseUrl,
    FHIR_STUDIO_INTEGRATION_ENABLED: "true",
    FHIR_STUDIO_INTEGRATION_ISSUER: "https://studio.example/integration",
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
      name: `Editable worker ${ids.role}`,
      permission_applications_deployment: true,
      permission_applications_register: true,
    },
  });
  await db.user.create({
    data: {
      id: ids.user,
      ssoIssuer: `editable-${ids.user}`,
      ssoSubject: ids.user,
    },
  });
  await db.appointment.create({
    data: { entityType: "User", entityId: ids.user, roleId: ids.role },
  });
  await db.gitHubConnection.create({
    data: {
      userId: ids.user,
      githubUserId: ids.user,
      login: "actor",
      encryptedTokens: encrypt(
        {
          access_token: "actor-test-token",
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
  await db.integrationClient.create({
    data: {
      id: ids.client,
      name: "Editable worker catalog",
      secretHash: digest("test-client-secret"),
      redirectUris: ["https://skycapp.example/callback"],
      scopes: [...integrationScopes],
    },
  });
});
after(async () => {
  globalThis.fetch = realFetch;
  const db = getPrisma();
  const appIds = (
    await db.hostedApplication.findMany({
      where: { integrationClientId: ids.client },
      select: { id: true },
    })
  ).map((app) => app.id);
  await db.integrationReview.deleteMany({
    where: { applicationId: { in: appIds } },
  });
  await db.hostedAudit.deleteMany({ where: { applicationId: { in: appIds } } });
  await db.hostedApplication.deleteMany({ where: { id: { in: appIds } } });
  await db.integrationOperation.deleteMany({ where: { clientId: ids.client } });
  await db.job.deleteMany({ where: { id: { in: jobIds } } });
  await db.integrationClient.deleteMany({ where: { id: ids.client } });
  await db.hostedOwnerQuota.deleteMany({ where: { userId: ids.user } });
  await db.appointment.deleteMany({ where: { roleId: ids.role } });
  await db.role.deleteMany({ where: { id: ids.role } });
  await db.user.deleteMany({ where: { id: ids.user } });
  await disconnectPrisma();
  if (root) await rm(root, { recursive: true, force: true });
  for (const key of Object.keys(process.env))
    if (!(key in originalEnv)) delete process.env[key];
  Object.assign(process.env, originalEnv);
});

async function fixture(
  options: { existing?: boolean; installation?: string } = {},
) {
  const db = getPrisma();
  const remote = new FakeGitHub();
  globalThis.fetch = remote.fetch.bind(remote);
  const grant = await db.integrationGrant.create({
    data: {
      clientId: ids.client,
      userId: ids.user,
      scope: integrationScopes.join(" "),
      accessTokenHash: digest(crypto.randomUUID()),
      refreshTokenHash: digest(crypto.randomUUID()),
      accessExpiresAt: new Date(Date.now() + 3600_000),
      refreshExpiresAt: new Date(Date.now() + 86400_000),
    },
  });
  const contract = defaultStaticSmartContract();
  contract.public_configuration = [
    { name: "greeting", label: "Greeting", type: "string", required: false },
  ];
  const request = {
    name: remote.name,
    mode: "editable",
    source_project: {
      provider: "github",
      owner: "publisher",
      repository: "source",
      commit: sourceCommit,
      project_directory: "",
      build_command: "npm ci && npm run build",
      output_directory: "dist",
      runtime: "26",
    },
    runtime_contract: contract,
    configuration: { greeting: "Hello" },
    repository: {
      owner: "actor",
      name: remote.name,
      private: true,
      installation_id: options.installation ?? "7",
    },
    origin: {
      installation_id: crypto.randomUUID(),
      deployment_id: crypto.randomUUID(),
    },
  };
  const existing = options.existing
    ? await db.hostedApplication.create({
        data: {
          name: remote.name,
          ownerUserId: ids.user,
          createdByUserId: ids.user,
          repositoryId: String(remote.repositoryId),
          repository: remote.fullName,
          installationId: "7",
          sourceKind: "repository",
          integrationClientId: ids.client,
          integrationOrigin: request.origin,
          runtimeContract:
            request.runtime_contract as unknown as Prisma.InputJsonValue,
        },
      })
    : null;
  if (existing) remote.exists = true;
  const operation = await db.integrationOperation.create({
    data: {
      clientId: ids.client,
      userId: ids.user,
      requestId: crypto.randomUUID(),
      requestDigest: digest(JSON.stringify(request)),
      request: request as unknown as Prisma.InputJsonValue,
      applicationId: existing?.id,
    },
  });
  const job = await db.job.create({
    data: {
      name: "Editable integration test",
      jobType: "INTEGRATION_EDITABLE_PROJECT",
      status: "in_progress",
      input: { operationId: operation.id, grantId: grant.id },
      createdByUserId: ids.user,
      lockedBy: "editable-test-worker",
      leaseExpiresAt: new Date(Date.now() + 300_000),
    },
  });
  jobIds.push(job.id);
  await db.integrationOperation.update({
    where: { id: operation.id },
    data: { jobId: job.id },
  });
  const controller = new AbortController();
  const ctx: JobExecutionContext = {
    job,
    signal: controller.signal,
    prisma: db,
    hapiClient: {} as JobExecutionContext["hapiClient"],
    updateProgress: async () => {},
    isCancelled: async () =>
      (await db.job.findUniqueOrThrow({ where: { id: job.id } })).status !==
      "in_progress",
  };
  return { db, remote, grant, operation, job, controller, ctx };
}

test("copies only pinned safe source, installs a fresh workflow, and provisions new public SMART clients", async () => {
  const { db, remote, ctx, operation } = await fixture();
  const result = await createEditableProject(ctx);
  const app = await db.hostedApplication.findUniqueOrThrow({
    where: { id: String(result.applicationId) },
  });
  assert.equal(app.repository, remote.fullName);
  assert.equal(app.originatingCommit, sourceCommit);
  assert.equal(app.integrationClientId, ids.client);
  assert.equal(app.sourceKind, "repository");
  assert.equal(
    remote.writes.filter((call) => call.path === "/user/repos").length,
    1,
  );
  assert.deepEqual(remote.sourceTrees, [sourceCommit]);
  assert.deepEqual([...remote.sourceBlobReads].sort(), [
    "callback.html",
    "index.html",
    "package.json",
  ]);
  const sourceTree = remote.writes.find(
    (call) =>
      call.path.endsWith("/git/trees") &&
      (call.body.tree as Array<{ path: string }>).some(
        (entry) => entry.path === "index.html",
      ),
  )!;
  assert.deepEqual(
    (sourceTree.body.tree as Array<{ path: string }>)
      .map((entry) => entry.path)
      .sort(),
    ["callback.html", "index.html", "package.json"],
  );
  const workflowTree = remote.writes.find(
    (call) =>
      call.path.endsWith("/git/trees") &&
      (call.body.tree as Array<{ path: string }>).some(
        (entry) => entry.path === workflowPath(app.id),
      ),
  )!;
  assert.ok(workflowTree);
  assert.match(
    String((workflowTree.body.tree as Array<{ content: string }>)[0]!.content),
    new RegExp(`name: FHIR Studio ${app.id}`),
  );
  const clients = await db.application.findMany({
    where: { hostedApplicationId: app.id },
  });
  assert.equal(clients.length, 2);
  assert.deepEqual(
    clients.map((client) => client.clientId).sort(),
    [`hosted-${app.id}-preview`, `hosted-${app.id}-published`].sort(),
  );
  assert.ok(
    clients.every(
      (client) =>
        client.clientSecret === null &&
        client.tokenEndpointAuthMethod === "none" &&
        client.pkceRequired,
    ),
  );
  assert.ok(
    clients.every((client) =>
      (client.redirectUris as string[]).every((uri) => uri.includes(app.id)),
    ),
  );
  const build = await db.hostedBuild.findUniqueOrThrow({
    where: { id: app.desiredBuildId! },
  });
  assert.equal(
    build.integrationGrantId,
    ctx.job.input && (ctx.job.input as { grantId: string }).grantId,
  );
  assert.deepEqual(build.publicConfiguration, { greeting: "Hello" });
  assert.deepEqual(
    build.runtimeContract,
    (operation.request as { runtime_contract: unknown }).runtime_contract,
  );
  const dispatch = remote.writes.find((call) =>
    call.path.endsWith("/dispatches"),
  )!;
  assert.deepEqual(dispatch.body.inputs, { studio_request_id: build.id });
});

test("resumes a workflow failure without recreating the repository, application, or copied source", async () => {
  const { db, remote, ctx, operation } = await fixture();
  remote.failure = "workflow";
  await assert.rejects(
    createEditableProject(ctx),
    (error) => error instanceof HostingError && error.status === 503,
  );
  const retained = await db.integrationOperation.findUniqueOrThrow({
    where: { id: operation.id },
  });
  assert.ok(retained.applicationId);
  assert.equal(
    await db.hostedApplication.count({
      where: { repositoryId: String(remote.repositoryId), integrationClientId: ids.client },
    }),
    1,
  );
  assert.equal(
    await db.hostedAudit.count({
      where: {
        applicationId: retained.applicationId,
        action: "CATALOG_SOURCE_COPIED",
      },
    }),
    1,
  );
  const copiedBlobs = remote.writes.filter((call) =>
    call.path.endsWith("/git/blobs"),
  ).length;
  const result = await createEditableProject(ctx);
  assert.equal(result.applicationId, retained.applicationId);
  assert.equal(
    remote.writes.filter((call) => call.path === "/user/repos").length,
    1,
  );
  assert.equal(
    remote.writes.filter((call) => call.path.endsWith("/git/blobs")).length,
    copiedBlobs,
  );
  assert.equal(
    await db.hostedApplication.count({
      where: { repositoryId: String(remote.repositoryId), integrationClientId: ids.client },
    }),
    1,
  );
});

test("rejects a destination installation outside the chosen owner before repository creation", async () => {
  const { db, remote, ctx, operation } = await fixture({ installation: "999" });
  await assert.rejects(
    createEditableProject(ctx),
    (error) => error instanceof HostingError && error.status === 403,
  );
  assert.deepEqual(remote.writes, []);
  assert.equal(
    (
      await db.integrationOperation.findUniqueOrThrow({
        where: { id: operation.id },
      })
    ).applicationId,
    null,
  );
});

test("a cancelled existing operation never mutates GitHub source", async () => {
  const { db, remote, ctx, job, operation } = await fixture({ existing: true });
  await db.job.update({
    where: { id: job.id },
    data: { status: "cancelled", cancelledAt: new Date() },
  });
  await assert.rejects(createEditableProject(ctx), /cancelled|lease/i);
  assert.deepEqual(remote.writes, []);
  assert.equal(
    await db.hostedAudit.count({
      where: {
        applicationId: operation.applicationId,
        action: "CATALOG_SOURCE_COPIED",
      },
    }),
    0,
  );
});

test("a revoked grant prevents existing operation source mutations", async () => {
  const { db, remote, ctx, grant } = await fixture({ existing: true });
  await db.integrationGrant.update({
    where: { id: grant.id },
    data: { revokedAt: new Date() },
  });
  await assert.rejects(
    createEditableProject(ctx),
    (error) => error instanceof HostingError && error.status === 403,
  );
  assert.deepEqual(remote.writes, []);
});

test("revocation during source metadata discovery is rechecked before copying source", async () => {
  const { db, remote, ctx, grant } = await fixture({ existing: true });
  remote.beforeSourceMetadata = async () => {
    await db.integrationGrant.update({
      where: { id: grant.id },
      data: { revokedAt: new Date() },
    });
  };
  await assert.rejects(
    createEditableProject(ctx),
    (error) => error instanceof HostingError && error.status === 403,
  );
  assert.deepEqual(remote.writes, []);
});

test("cancellation during source metadata discovery is rechecked before copying source", async () => {
  const { db, remote, ctx, job } = await fixture({ existing: true });
  remote.beforeSourceMetadata = async () => {
    await db.job.update({
      where: { id: job.id },
      data: { status: "cancelled", cancelledAt: new Date() },
    });
  };
  await assert.rejects(createEditableProject(ctx), /cancelled|lease/i);
  assert.deepEqual(remote.writes, []);
});
