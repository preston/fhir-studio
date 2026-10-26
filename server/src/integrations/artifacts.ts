// Author: Preston Lee

import crypto from "node:crypto";
import https from "node:https";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { createWriteStream } from "node:fs";
import { mkdir, rm, stat } from "node:fs/promises";
import { Transform, Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import path from "node:path";
import type {
  IntegrationGrant,
  HostedApplication,
  HostedBuild,
  Prisma,
} from "@prisma/client";
import { getPrisma } from "../db/prisma.js";
import { loadHostingConfig } from "../hosted/config.js";
import { HostingError, assertCurrentCapability } from "../hosted/access.js";
import {
  extractArtifact,
  finalizeBuild,
  reserveStorage,
  checkStorage,
  safeAssetPath,
} from "../hosted/filesystem.js";
import {
  github,
  userToken,
  lockApplication,
  repositoryForUser,
  type GitHubRepo,
} from "../hosted/github.js";
import { assertOwnerQuota, lockHostingAllocation } from "../hosted/quotas.js";
import { provisionClients } from "../hosted/builds.js";
import {
  copyTemplateSnapshot,
  commitFiles,
  workflowPath,
  managedWorkflow,
} from "../hosted/source.js";
import { assertActiveGrant, jsonValue, digest } from "./oauth.js";
import type { JobExecutionContext } from "../jobs/types.js";
import type {
  BuildArtifact,
  StaticSmartRuntimeContract,
  SourceProject,
} from "./catalog-contract.js";

/** Reject non-global addresses before DNS-pinned HTTPS; every redirect is checked again. */
export function publicAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a, b] = address.split(".").map(Number);
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && [0, 2, 168].includes(b)) ||
      (a === 198 && [18, 19, 51].includes(b)) ||
      (a === 203 && b === 0)
    );
  }
  return (
    isIP(address) === 6 &&
    /^[23][0-9a-f]{3}:/i.test(address) &&
    !/^2001:(?:db8|0|10|20):/i.test(address)
  );
}
export async function downloadPublicArchive(
  url: string,
  destination: string,
  limit: number,
  signal: AbortSignal,
): Promise<string> {
  let target = new URL(url);
  for (let hop = 0; hop < 6; hop++) {
    if (
      target.protocol !== "https:" ||
      target.username ||
      target.password ||
      target.hash ||
      (target.port && target.port !== "443") ||
      !target.hostname.includes(".") ||
      target.hostname.endsWith(".local")
    )
      throw new HostingError(
        400,
        "Artifact URL must use public HTTPS without credentials.",
      );
    const addresses = await lookup(target.hostname, { all: true });
    if (
      !addresses.length ||
      addresses.some((item) => !publicAddress(item.address))
    )
      throw new HostingError(
        400,
        "Artifact URL resolves to a private or reserved network.",
      );
    const selected = addresses[0]!;
    const response = await new Promise<import("node:http").IncomingMessage>(
      (resolve, reject) => {
        const request = https.get(
          target,
          {
            signal,
            family: selected.family,
            lookup: (_hostname, _options, callback) =>
              callback(null, selected.address, selected.family),
          },
          resolve,
        );
        request.once("error", reject);
      },
    );
    if ([301, 302, 303, 307, 308].includes(response.statusCode || 0)) {
      response.destroy();
      const next = response.headers.location;
      if (!next) throw new HostingError(502, "Artifact redirect is invalid.");
      target = new URL(next, target);
      continue;
    }
    if (
      response.statusCode !== 200 ||
      Number(response.headers["content-length"] || 0) > limit
    ) {
      response.destroy();
      throw new HostingError(
        response.statusCode === 404 ? 410 : 502,
        "Artifact is unavailable or exceeds the download limit.",
      );
    }
    let bytes = 0;
    const hash = crypto.createHash("sha256");
    await pipeline(
      response,
      new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          bytes += chunk.length;
          if (bytes > limit)
            return callback(
              new HostingError(413, "Artifact exceeds download limit."),
            );
          hash.update(chunk);
          callback(null, chunk);
        },
      }),
      createWriteStream(destination, { flags: "wx", mode: 0o600 }),
      { signal },
    );
    return hash.digest("hex");
  }
  throw new HostingError(502, "Artifact exceeded the redirect limit.");
}
export async function downloadResolvedArchive(
  source: string | Response,
  destination: string,
  limit: number,
  signal: AbortSignal,
): Promise<string> {
  if (typeof source === "string")
    return downloadPublicArchive(source, destination, limit, signal);
  if (
    source.status !== 200 ||
    !source.body ||
    Number(source.headers.get("content-length") || 0) > limit
  ) {
    await source.body?.cancel().catch(() => {});
    throw new HostingError(
      413,
      "Artifact stream is unavailable or exceeds the download limit.",
    );
  }
  const body = source.body;
  const chunks = async function* () {
    const reader = body.getReader();
    try {
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        yield Buffer.from(part.value);
      }
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  };
  let bytes = 0;
  const hash = crypto.createHash("sha256");
  await pipeline(
    Readable.from(chunks()),
    new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        bytes += chunk.length;
        if (bytes > limit)
          return callback(
            new HostingError(413, "Artifact exceeds download limit."),
          );
        hash.update(chunk);
        callback(null, chunk);
      },
    }),
    createWriteStream(destination, { flags: "wx", mode: 0o600 }),
    { signal },
  );
  return hash.digest("hex");
}
export async function resolveArtifact(
  artifact: BuildArtifact,
  userId: string,
): Promise<string | Response> {
  if (artifact.resolver === "public-https")
    return (artifact.locator as { url: string }).url;
  const config = loadHostingConfig("worker");
  const token = await userToken(userId, config);
  const locator = artifact.locator as {
    owner: string;
    repository: string;
    asset_id?: string;
    artifact_id?: string;
  };
  const base = `/repos/${locator.owner}/${locator.repository}`;
  // The user's token is used for access checks and source downloads, never an installation token.
  await github(token, base);
  if (artifact.resolver === "github-actions") {
    const metadata = await github<{
      id: number;
      expired: boolean;
      digest?: string;
    }>(token, `${base}/actions/artifacts/${locator.artifact_id}`);
    if (metadata.expired)
      throw new HostingError(
        410,
        "GitHub artifact expired. Select an available release.",
      );
    if (
      metadata.digest &&
      metadata.digest !== `sha256:${artifact.sha256.toLowerCase()}`
    )
      throw new HostingError(
        400,
        "Source artifact digest differs from the catalog release.",
      );
  } else await github(token, `${base}/releases/assets/${locator.asset_id}`);
  const endpoint =
    artifact.resolver === "github-actions"
      ? `${base}/actions/artifacts/${locator.artifact_id}/zip`
      : `${base}/releases/assets/${locator.asset_id}`;
  const response = await fetch(`https://api.github.com${endpoint}`, {
    redirect: "manual",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/octet-stream",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    signal: AbortSignal.timeout(30_000),
  });
  if (response.status === 200 && artifact.resolver === "github-release")
    return response;
  if (response.status !== 302 || !response.headers.get("location"))
    throw new HostingError(
      502,
      "GitHub download unavailable. Verify repository access and artifact availability.",
    );
  // Only the signed destination leaves this function; the actor credential is never forwarded.
  const url = new URL(response.headers.get("location")!);
  if (
    !/(^|\.)(githubusercontent\.com|blob\.core\.windows\.net|actions\.github\.com)$/.test(
      url.hostname,
    )
  )
    throw new HostingError(502, "GitHub download destination is not approved.");
  return url.href;
}
export async function assertArtifactAccess(
  artifact: BuildArtifact,
  userId: string,
  installedContent = false,
): Promise<void> {
  if (artifact.resolver === "public-https") return;
  const locator = artifact.locator as {
    owner: string;
    repository: string;
    asset_id?: string;
    artifact_id?: string;
  };
  const token = await userToken(userId, loadHostingConfig());
  const base = `/repos/${locator.owner}/${locator.repository}`;
  await github(token, base);
  if (installedContent) return;
  const metadata = await github<{ expired?: boolean }>(
    token,
    artifact.resolver === "github-actions"
      ? `${base}/actions/artifacts/${locator.artifact_id}`
      : `${base}/releases/assets/${locator.asset_id}`,
  );
  if (metadata.expired)
    throw new HostingError(
      410,
      "Artifact expired. Rebuild or select another release.",
    );
}
async function activeAuthority(
  tx: Prisma.TransactionClient,
  app: HostedApplication,
  build: HostedBuild,
): Promise<IntegrationGrant> {
  const grant = await assertActiveGrant(
    tx,
    build.integrationGrantId!,
    "applications:write",
  );
  if (grant.clientId !== app.integrationClientId)
    throw new HostingError(403, "Application is outside this integration.");
  await assertCurrentCapability(tx, app.id, grant.userId, "develop");
  return grant;
}
export async function importCatalogArtifact(
  ctx: JobExecutionContext,
): Promise<Record<string, unknown>> {
  const config = loadHostingConfig("worker"),
    db = getPrisma();
  const { buildId } = ctx.job.input as { buildId: string };
  const build = await db.hostedBuild.findUniqueOrThrow({
    where: { id: buildId },
  });
  if (build.status === "READY") return { buildId };
  const app = await db.hostedApplication.findUniqueOrThrow({
    where: { id: build.applicationId },
  });
  const grant = await activeAuthority(db, app, build);
  const artifact = build.artifactSource as unknown as BuildArtifact;
  const contract =
    build.runtimeContract as unknown as StaticSmartRuntimeContract;
  if (
    app.deletedAt ||
    app.suspended ||
    app.desiredBuildId !== build.id ||
    app.generation !== build.generation
  )
    throw new HostingError(
      409,
      "Deployment superseded or application unavailable.",
    );
  const staging = path.join(
      config.root,
      ".staging",
      `${ctx.job.id}-${crypto.randomUUID()}`,
    ),
    signal = AbortSignal.any([ctx.signal, AbortSignal.timeout(300_000)]);
  try {
    await mkdir(staging, { recursive: true, mode: 0o700 });
    await checkStorage(config);
    await reserveStorage(config, build.id);
    await ctx.updateProgress(10, "Resolving catalog artifact");
    const archive = path.join(staging, "artifact.zip");
    const actual = await downloadResolvedArchive(
      await resolveArtifact(artifact, grant.userId),
      archive,
      config.maxArchiveBytes,
      signal,
    );
    if (actual !== artifact.sha256.toLowerCase())
      throw new HostingError(400, "Artifact integrity verification failed.");
    await ctx.updateProgress(40, "Validating static archive");
    const expanded = path.join(staging, "expanded");
    const bytes = await extractArtifact(archive, expanded, config, signal);
    const content = artifact.archive_root
      ? path.join(expanded, safeAssetPath(artifact.archive_root))
      : expanded;
    for (const entry of [contract.launch_path, ...contract.callback_paths]) {
      const file = await stat(path.join(content, safeAssetPath(entry))).catch(
        () => null,
      );
      if (!file?.isFile())
        throw new HostingError(
          400,
          `Missing declared static entrypoint: ${entry}`,
        );
    }
    await assertArtifactAccess(artifact, grant.userId);
    await db.$transaction(
      async (tx) => {
        await assertActiveGrant(
          tx,
          build.integrationGrantId!,
          "applications:write",
        );
        await lockApplication(tx, app.id);
        const current = await tx.hostedApplication.findUniqueOrThrow({
          where: { id: app.id },
        });
        await activeAuthority(tx, current, build);
        const lease = await tx.job.findUniqueOrThrow({
          where: { id: ctx.job.id },
        });
        if (
          signal.aborted ||
          current.generation !== build.generation ||
          current.desiredBuildId !== build.id ||
          current.suspended ||
          lease.lockedBy !== ctx.job.lockedBy ||
          lease.status !== "in_progress" ||
          !lease.leaseExpiresAt ||
          lease.leaseExpiresAt <= new Date()
        )
          throw new HostingError(
            409,
            "Import lease or deployment state changed.",
          );
        if (
          current.previewBuildId !== build.id &&
          current.publishedBuildId !== build.id
        )
          await rm(path.join(config.root, "apps", app.id, build.id), {
            recursive: true,
            force: true,
          });
        const directory = await finalizeBuild(
          config,
          app.id,
          build.id,
          content,
        );
        await activeAuthority(tx, current, build);
        const finalLease = await tx.job.findUniqueOrThrow({
          where: { id: ctx.job.id },
        });
        if (
          signal.aborted ||
          finalLease.status !== "in_progress" ||
          finalLease.lockedBy !== ctx.job.lockedBy ||
          !finalLease.leaseExpiresAt ||
          finalLease.leaseExpiresAt <= new Date()
        )
          throw new HostingError(409, "Import cancelled before activation.");
        await tx.hostedBuild.update({
          where: { id: build.id },
          data: {
            status: "READY",
            error: null,
            directory,
            byteSize: BigInt(bytes),
          },
        });
        const activated = await tx.hostedApplication.update({
          where: { id: app.id },
          data: { previewBuildId: build.id },
        });
        await provisionClients(activated, config, tx);
        await tx.hostedAudit.create({
          data: {
            applicationId: app.id,
            userId: grant.userId,
            action: "CATALOG_PREVIEW_ACTIVATED",
            detail: { buildId: build.id, sha256: actual },
          },
        });
      },
      { timeout: 30_000 },
    );
    return { applicationId: app.id, buildId: build.id };
  } catch (error) {
    await db.hostedBuild.updateMany({
      where: { id: build.id, status: { not: "READY" } },
      data: {
        status: ctx.signal.aborted ? "CANCELLED" : "FAILED",
        error:
          error instanceof HostingError
            ? error.message
            : "Artifact import failed. Retry after checking source availability.",
        byteSize: 0,
      },
    });
    throw error;
  } finally {
    await rm(staging, { recursive: true, force: true }).catch(() => {});
  }
}
export async function createEditableProject(
  ctx: JobExecutionContext,
): Promise<Record<string, unknown>> {
  const db = getPrisma(),
    config = loadHostingConfig("worker");
  const { operationId, grantId } = ctx.job.input as {
    operationId: string;
    grantId: string;
  };
  const operation = await db.integrationOperation.findUniqueOrThrow({
    where: { id: operationId },
  });
  const body = operation.request as unknown as {
    name: string;
    source_project: SourceProject;
    runtime_contract: StaticSmartRuntimeContract;
    repository: {
      owner: string;
      name: string;
      private?: boolean;
      installation_id?: string;
      installationId?: string;
    };
    configuration: Record<string, unknown>;
    origin: Record<string, unknown>;
  };
  const grant = await assertActiveGrant(db, grantId, "projects:create");
  if (
    operation.clientId !== grant.clientId ||
    operation.userId !== grant.userId
  )
    throw new HostingError(
      403,
      "Editable operation does not belong to this grant.",
    );
  async function checkpoint(
    applicationId?: string,
    expectedGeneration?: number,
  ): Promise<void> {
    if (ctx.signal.aborted || (await ctx.isCancelled()))
      throw new HostingError(409, "Operation cancelled. Repository retained.");
    await assertActiveGrant(db, grantId, "projects:create");
    const lease = await db.job.findUniqueOrThrow({ where: { id: ctx.job.id } });
    if (
      lease.status !== "in_progress" ||
      lease.lockedBy !== ctx.job.lockedBy ||
      !lease.leaseExpiresAt ||
      lease.leaseExpiresAt <= new Date()
    )
      throw new HostingError(409, "Editable operation lease expired.");
    if (applicationId) {
      await assertCurrentCapability(db, applicationId, grant.userId, "develop");
      const current = await db.hostedApplication.findUniqueOrThrow({
        where: { id: applicationId },
      });
      if (current.suspended || current.generation !== expectedGeneration)
        throw new HostingError(409, "Application state changed.");
    }
  }
  const token = await userToken(grant.userId, config);
  const source = body.source_project;
  const destination = body.repository;
  if (
    !source ||
    !destination ||
    !/^[\w.-]{1,100}$/.test(destination.name) ||
    !/^[\w.-]+$/.test(destination.owner)
  )
    throw new HostingError(
      400,
      "Provide valid pinned source and destination repository.",
    );
  const me = await github<{ login: string }>(token, "/user");
  const fullName = `${destination.owner}/${destination.name}`;
  let app = operation.applicationId
    ? await db.hostedApplication.findUnique({
        where: { id: operation.applicationId },
      })
    : null;
  const selectedInstallation =
    destination.installation_id || destination.installationId || "";
  const installations = await github<{
    installations: Array<{
      id: number;
      account: { login: string };
      suspended_at: string | null;
    }>;
  }>(token, "/user/installations?per_page=100");
  if (
    !installations.installations.some(
      (i) =>
        String(i.id) === selectedInstallation &&
        i.account.login.toLowerCase() === destination.owner.toLowerCase() &&
        !i.suspended_at,
    )
  )
    throw new HostingError(
      403,
      "Choose an active Studio GitHub installation for the destination owner.",
    );
  if (!app) {
    await ctx.updateProgress(10, "Creating destination repository");
    // The persisted operation ID is an unguessable recovery marker for repository creation.
    const marker = `FHIR Studio integration operation ${operation.id}`;
    let repo: GitHubRepo;
    try {
      const recovered = await github<
        GitHubRepo & { description: string; created_at: string }
      >(token, `/repos/${fullName}`);
      if (recovered.description !== marker || !recovered.permissions?.push)
        throw new HostingError(
          409,
          "Destination repository already exists and was not created by this deployment. Select a different name.",
        );
      repo = recovered;
    } catch (error) {
      if (!(error instanceof HostingError) || error.upstreamStatus !== 404)
        throw error;
      await checkpoint();
      repo = await github<GitHubRepo>(
        token,
        destination.owner.toLowerCase() === me.login.toLowerCase()
          ? "/user/repos"
          : `/orgs/${destination.owner}/repos`,
        "POST",
        {
          name: destination.name,
          private: destination.private !== false,
          auto_init: true,
          description: marker,
        },
      );
    }
    app = await db.$transaction(async (tx) => {
      await assertActiveGrant(tx, grantId, "projects:create");
      const lease = await tx.job.findUniqueOrThrow({
        where: { id: ctx.job.id },
      });
      if (
        ctx.signal.aborted ||
        lease.status !== "in_progress" ||
        lease.lockedBy !== ctx.job.lockedBy ||
        !lease.leaseExpiresAt ||
        lease.leaseExpiresAt <= new Date()
      )
        throw new HostingError(
          409,
          "Operation cancelled; the repository was retained.",
        );
      await lockHostingAllocation(tx, [grant.userId]);
      await assertOwnerQuota(tx, config, grant.userId, 1);
      const created = await tx.hostedApplication.create({
        data: {
          name: body.name,
          ownerUserId: grant.userId,
          createdByUserId: grant.userId,
          sourceKind: "repository",
          integrationClientId: grant.clientId,
          integrationOrigin: jsonValue(body.origin),
          runtimeContract: jsonValue(body.runtime_contract),
          publicConfiguration: jsonValue(body.configuration),
          integrationGrantId: grant.id,
          repositoryId: String(repo.id),
          repository: repo.full_name,
          installationId:
            destination.installation_id || destination.installationId || "",
          branch: repo.default_branch,
          projectDirectory: source.project_directory,
          buildCommand: source.build_command,
          outputDirectory: source.output_directory,
          nodeVersion: source.runtime,
          launchPath: body.runtime_contract.launch_path,
          callbackPath: body.runtime_contract.callback_paths[0],
          scope: body.runtime_contract.scopes.join(" "),
          originatingCommit: source.commit,
        },
      });
      await tx.integrationOperation.update({
        where: { id: operation.id },
        data: {
          applicationId: created.id,
          request: jsonValue({
            ...body,
            _expected_generation: created.generation,
          }),
        },
      });
      return created;
    });
  }
  const expectedGeneration =
    (operation.request as Record<string, unknown>)._expected_generation ?? 0;
  if (app.generation !== expectedGeneration || app.suspended || app.deletedAt)
    throw new HostingError(
      409,
      "Application changed or was removed. Resume development in Studio.",
    );
  await assertCurrentCapability(db, app.id, grant.userId, "develop");
  if (ctx.signal.aborted || (await ctx.isCancelled()))
    throw new HostingError(
      409,
      "Operation cancelled. The repository was retained.",
    );
  await assertActiveGrant(db, grantId, "projects:create");
  const target = await repositoryForUser(
    grant.userId,
    app.repositoryId,
    config,
    true,
  );
  const base = `/repos/${fullName}`;
  const sourceRepo = await github<GitHubRepo>(
    token,
    `/repos/${source.owner}/${source.repository}`,
  );
  const head = await github<{ sha: string }>(
    token,
    `${base}/commits/${encodeURIComponent(app.branch)}`,
  );
  const marker = await db.hostedAudit.findFirst({
    where: { applicationId: app.id, action: "CATALOG_SOURCE_COPIED" },
  });
  if (!marker) {
    const currentCommit = await github<{ commit: { message: string } }>(
      token,
      `${base}/commits/${head.sha}`,
    );
    if (
      currentCommit.commit.message !==
      `Create application from template ${source.commit}`
    ) {
      const tree = await github<{
        tree: Array<{ path: string; type: string }>;
      }>(token, `${base}/git/trees/${head.sha}?recursive=1`);
      if (
        tree.tree.some(
          (f) =>
            f.type === "blob" &&
            !/^(README(?:\.md)?|LICENSE(?:\.md)?|\.gitignore)$/i.test(f.path),
        )
      )
        throw new HostingError(
          409,
          "Destination source changed before copying. Resume development in Studio to protect existing files.",
        );
      await checkpoint(app.id, Number(expectedGeneration));
      await ctx.updateProgress(35, "Copying pinned source snapshot");
      await copyTemplateSnapshot(
        grant.userId,
        String(sourceRepo.id),
        source.commit,
        token,
        base,
        app.branch,
        head.sha,
        config,
        () => checkpoint(app!.id, Number(expectedGeneration)),
      );
    }
    await db.hostedAudit.create({
      data: {
        applicationId: app.id,
        userId: grant.userId,
        action: "CATALOG_SOURCE_COPIED",
        detail: { commit: source.commit },
      },
    });
  }
  if (ctx.signal.aborted || (await ctx.isCancelled()))
    throw new HostingError(409, "Operation cancelled. Repository retained.");
  await assertActiveGrant(db, grantId, "projects:create");
  await assertCurrentCapability(db, app.id, grant.userId, "develop");
  await ctx.updateProgress(65, "Installing Studio build workflow");
  const current = await github<{ sha: string }>(
    token,
    `${base}/commits/${encodeURIComponent(app.branch)}`,
  );
  await commitFiles(
    token,
    base,
    app.branch,
    current.sha,
    [{ path: workflowPath(app.id), content: managedWorkflow(app) }],
    "Install FHIR Studio build workflow",
    () => checkpoint(app!.id, Number(expectedGeneration)),
  );
  // Verify the selected installation can build this repository. Organization approval may require a resumable retry.
  let installed = false;
  for (let page = 1; page <= 100; page++) {
    const repos = await github<{ repositories: GitHubRepo[] }>(
      target.token,
      `/user/installations/${app.installationId}/repositories?per_page=100&page=${page}`,
    );
    if (repos.repositories.some((r) => String(r.id) === app!.repositoryId)) {
      installed = true;
      break;
    }
    if (repos.repositories.length < 100) break;
  }
  if (!installed)
    throw new HostingError(
      403,
      "Add the new repository to the Studio GitHub App installation, then retry. The repository and application were retained.",
    );
  await provisionClients(app, config);
  const latest = app.desiredBuildId
    ? await db.hostedBuild.findUnique({ where: { id: app.desiredBuildId } })
    : null;
  if (!latest || ["FAILED", "CANCELLED"].includes(latest.status)) {
    const head = await github<{ sha: string }>(
      token,
      `${base}/commits/${encodeURIComponent(app.branch)}`,
    );
    const build = await db.$transaction(async (tx) => {
      await assertActiveGrant(tx, grantId, "applications:write");
      await lockApplication(tx, app!.id);
      await assertCurrentCapability(tx, app!.id, grant.userId, "develop");
      const current = await tx.hostedApplication.findUniqueOrThrow({
        where: { id: app!.id },
      });
      if (current.suspended || current.generation !== expectedGeneration)
        throw new HostingError(409, "Application state changed.");
      const created = await tx.hostedBuild.create({
        data: {
          applicationId: app!.id,
          branch: app!.branch,
          commit: head.sha,
          generation: app!.generation,
          requestedByUserId: grant.userId,
          requestEvent: "workflow_dispatch",
          runtimeContract: jsonValue(body.runtime_contract),
          publicConfiguration: jsonValue(body.configuration),
          integrationGrantId: grantId,
          revisionDigest: digest(
            JSON.stringify({
              commit: head.sha,
              contract: body.runtime_contract,
              configuration: body.configuration,
            }),
          ),
        },
      });
      await tx.hostedApplication.update({
        where: { id: app!.id },
        data: { desiredBuildId: created.id },
      });
      return created;
    });
    try {
      await github(
        token,
        `${base}/actions/workflows/${encodeURIComponent(workflowPath(app.id))}/dispatches`,
        "POST",
        { ref: app.branch, inputs: { studio_request_id: build.id } },
      );
    } catch (error) {
      await db.hostedBuild.update({
        where: { id: build.id },
        data: {
          status: "FAILED",
          error:
            "Workflow dispatch failed. Check GitHub workflow permissions, then retry.",
        },
      });
      throw error;
    }
  }
  await ctx.updateProgress(95, "Waiting for repository build");
  return { applicationId: app.id, repository: app.repository };
}
