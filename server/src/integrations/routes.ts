// Author: Preston Lee

import { stat } from "node:fs/promises";
import path from "node:path";
import { safeAssetPath } from "../hosted/filesystem.js";
import express, { type Request, type Router } from "express";
import type {
  HostedApplication,
  IntegrationGrant,
  IntegrationOperation,
  Prisma,
} from "@prisma/client";
import { getPrisma } from "../db/prisma.js";
import {
  isHostingEnabled,
  isGitHubHostingEnabled,
  requireEnv,
} from "../env.js";
import { loadHostingConfig, appOrigin } from "../hosted/config.js";
import {
  HostingError,
  capabilities,
  assertCurrentCapability,
  sandboxAccess,
  assertDeploymentPermission,
} from "../hosted/access.js";
import { assertOwnerQuota, lockHostingAllocation } from "../hosted/quotas.js";
import { github, userToken, lockApplication } from "../hosted/github.js";
import { provisionClients } from "../hosted/builds.js";
import {
  performHostingAction,
  revokeHostedSessions,
} from "../hosted/operations.js";
import { cancelJob } from "../jobs/queue.js";
import { hasPermission } from "../authorization/permissions.js";
import { loadEffectivePermissions } from "../authorization/effectivePermissions.js";
import {
  enabledFhirVersionWhere,
  isFhirReleaseEnabled,
} from "../hapi/partition_client.js";
import {
  integrationEnabled,
  bearerGrant,
  assertActiveGrant,
  digest,
  jsonValue,
} from "./oauth.js";
import {
  artifactErrors,
  deploymentProfileErrors,
  publicConfigurationErrors,
  type BuildArtifact,
  type StaticSmartRuntimeContract,
  type SourceProject,
} from "./catalog-contract.js";
import { assertArtifactAccess } from "./artifacts.js";
import { routeParam } from "../http/routeParam.js";

interface DeploymentRequest {
  request_id?: string;
  name: string;
  mode: "install" | "editable";
  artifact: BuildArtifact;
  runtime_contract: StaticSmartRuntimeContract;
  source_project: SourceProject | null;
  configuration: Record<string, unknown>;
  sandboxId?: string;
  sandbox_id?: string;
  repository?: {
    owner: string;
    name: string;
    private?: boolean;
    installation_id?: string;
    installationId?: string;
  };
  origin: Record<string, unknown>;
}
function validatedRequest(value: unknown): DeploymentRequest {
  const body = value as DeploymentRequest;
  if (
    !body ||
    typeof body.name !== "string" ||
    !body.name.trim() ||
    body.name.length > 200 ||
    !["install", "editable"].includes(body.mode) ||
    !body.origin ||
    typeof body.origin.installation_id !== "string" ||
    typeof body.origin.deployment_id !== "string" ||
    !body.configuration ||
    typeof body.configuration !== "object" ||
    Array.isArray(body.configuration)
  )
    throw new HostingError(
      400,
      "Provide an application name, deployment mode, catalog origin, and public configuration.",
    );
  const errors = {
    ...artifactErrors(body.artifact),
    ...deploymentProfileErrors({
      name: body.name,
      artifact_id: body.artifact?.id || "catalog-artifact",
      runtime_contract: body.runtime_contract,
      source_project: body.source_project,
    }),
  };
  if (Object.keys(errors).length)
    throw new HostingError(
      400,
      `Incompatible catalog release: ${Object.entries(errors)
        .map(([key, values]) => `${key} ${values.join(", ")}`)
        .join("; ")}`,
    );
  if (
    body.runtime_contract.scopes.some(
      (s) =>
        s.startsWith("system/") ||
        s.includes("?") ||
        s.includes("offline_access") ||
        /[\x00-\x20]/.test(s),
    )
  )
    throw new HostingError(400, "Unsupported SMART public-client scopes.");
  if (JSON.stringify(body).length > 100_000)
    throw new HostingError(413, "Deployment metadata is too large.");
  const configuration = publicConfigurationErrors(
    body.runtime_contract,
    body.configuration,
  );
  if (Object.keys(configuration).length)
    throw new HostingError(
      400,
      `Public configuration requires attention: ${Object.keys(configuration).join(", ")}`,
    );
  const resolved: Record<string, unknown> = {};
  for (const field of body.runtime_contract.public_configuration) {
    const val = body.configuration[field.name] ?? field.default;
    if (val !== undefined) resolved[field.name] = val;
  }
  return { ...body, name: body.name.trim(), configuration: resolved };
}
async function applicationFor(
  grant: IntegrationGrant,
  id: string,
  permission: "read" | "develop" | "publish" = "read",
  includeTrash = false,
  tx: Prisma.TransactionClient = getPrisma(),
) {
  const app = await tx.hostedApplication.findFirst({
    where: {
      id,
      integrationClientId: grant.clientId,
      ...(includeTrash ? {} : { deletedAt: null }),
    },
    include: { collaborators: true },
  });
  if (!app)
    throw new HostingError(404, "Application not found for this integration.");
  const rights = capabilities(
    app.ownerUserId,
    grant.userId,
    app.collaborators.find((c) => c.userId === grant.userId)?.role,
  );
  if (!rights.read)
    throw new HostingError(404, "Application not found for this account.");
  if (!rights[permission])
    throw new HostingError(
      403,
      "Your current application role does not permit this operation.",
    );
  return { app, rights };
}
async function serialize(app: HostedApplication, grant: IntegrationGrant) {
  const db = getPrisma(),
    config = loadHostingConfig();
  const [builds, bindings, review, members] = await Promise.all([
    db.hostedBuild.findMany({
      where: { applicationId: app.id },
      orderBy: { createdAt: "desc" },
      take: 20,
    }),
    db.hostedSandbox.findMany({
      where: { applicationId: app.id },
      include: {
        sandbox: {
          select: { id: true, sandboxId: true, name: true, fhirVersion: true },
        },
      },
    }),
    db.integrationReview.findUnique({
      where: {
        applicationId_userId: { applicationId: app.id, userId: grant.userId },
      },
    }),
    db.hostedCollaborator.findUnique({
      where: {
        applicationId_userId: { applicationId: app.id, userId: grant.userId },
      },
    }),
  ]);
  const missingActive = [
    app.previewBuildId,
    app.publishedBuildId,
    app.desiredBuildId,
  ].filter(
    (id): id is string => !!id && !builds.some((build) => build.id === id),
  );
  if (missingActive.length)
    builds.push(
      ...(await db.hostedBuild.findMany({
        where: { applicationId: app.id, id: { in: missingActive } },
      })),
    );
  const preview = app.previewBuildId
    ? await db.hostedBuild.findUnique({ where: { id: app.previewBuildId } })
    : null;
  return {
    id: app.id,
    name: app.name,
    source_kind: app.sourceKind,
    origin: app.integrationOrigin,
    repository: app.repository || null,
    preview_build_id: app.previewBuildId,
    published_build_id: app.publishedBuildId,
    desired_build_id: app.desiredBuildId,
    reviewed_preview_id:
      review?.buildId === preview?.id &&
      review?.revisionDigest === preview?.revisionDigest
        ? review?.buildId
        : null,
    preview_url: appOrigin(config, app.id, "preview"),
    published_url: appOrigin(config, app.id, "published"),
    deleted_at: app.deletedAt,
    delete_after: app.deleteAfter,
    suspended: app.suspended,
    reconciliation_error: app.reconciliationError,
    capabilities: capabilities(app.ownerUserId, grant.userId, members?.role),
    sandboxes: bindings.map((b) => ({
      id: b.sandbox.id,
      sandbox_id: b.sandbox.sandboxId,
      name: b.sandbox.name,
      fhir_version: b.sandbox.fhirVersion,
    })),
    builds: builds.map((b) => ({
      id: b.id,
      revision_id: b.id,
      status: b.status,
      error: b.error,
      created_at: b.createdAt,
      commit: b.commit,
      artifact: b.artifactSource,
      runtime_contract: b.runtimeContract,
      configuration: b.publicConfiguration,
      revision_digest: b.revisionDigest,
    })),
    handoff_url: `${config.studioOrigin}/integration/handoff?applicationId=${app.id}&channel=preview&subject=${grant.userId}`,
  };
}
async function operationView(operation: IntegrationOperation) {
  const db = getPrisma();
  const job = operation.jobId
    ? await db.job.findUnique({ where: { id: operation.jobId } })
    : null;
  const app = operation.applicationId
    ? await db.hostedApplication.findUnique({
        where: { id: operation.applicationId },
      })
    : null;
  const repositoryBuild =
    job?.jobType === "INTEGRATION_EDITABLE" &&
    job.status === "completed" &&
    app?.desiredBuildId
      ? await db.hostedBuild.findUnique({ where: { id: app.desiredBuildId } })
      : null;
  const building =
    repositoryBuild &&
    ["WAITING", "BUILDING", "IMPORTING"].includes(repositoryBuild.status);
  const failedBuild =
    repositoryBuild && ["FAILED", "CANCELLED"].includes(repositoryBuild.status);
  return {
    id: operation.id,
    application_id: operation.applicationId,
    revision_id: app?.desiredBuildId,
    status:
      repositoryBuild?.status === "CANCELLED"
        ? "cancelled"
        : building
          ? "in_progress"
          : failedBuild
            ? "failed"
            : job?.status || "failed",
    progress: building ? 95 : job?.progress || 0,
    stage: building
      ? "Building repository preview"
      : job?.stage || "Operation unavailable",
    error: failedBuild
      ? sanitizeError(
          repositoryBuild.error ||
            "Repository preview failed. Retry or open Studio.",
        )
      : job?.error
        ? sanitizeError(job.error)
        : null,
  };
}
function sanitizeError(value: string): string {
  return value
    .replace(/https?:\/\/\S+/g, "[source URL redacted]")
    .slice(0, 2000);
}
async function manageSandbox(
  tx: Prisma.TransactionClient,
  userId: string,
  slug: string,
  contract?: StaticSmartRuntimeContract,
) {
  const sandbox = await tx.sandbox.findFirst({
    where: {
      OR: [
        {
          id: /^[a-f0-9-]{36}$/i.test(slug)
            ? slug
            : "00000000-0000-0000-0000-000000000000",
        },
        { sandboxId: slug },
      ],
    },
    include: { collaborators: true },
  });
  if (
    !sandbox ||
    !(
      sandbox.createdByUserId === userId ||
      sandbox.collaborators.some(
        (c) => c.userId === userId && ["MANAGE", "OWNER"].includes(c.role),
      )
    )
  )
    throw new HostingError(403, "Select a sandbox you currently manage.");
  if (
    !isFhirReleaseEnabled(sandbox.fhirVersion) ||
    (contract && !contract.fhir_versions.includes(sandbox.fhirVersion as "R4"))
  )
    throw new HostingError(
      409,
      "The sandbox FHIR release is not supported by this application.",
    );
  return sandbox;
}
export function createIntegrationRouter(): Router {
  const router = express.Router(),
    db = getPrisma();
  router.get("/api/integration/v1/capabilities", (_req, res) => {
    res.json({
      api_version: 1,
      artifact_resolvers: isGitHubHostingEnabled()
        ? ["public-https", "github-release", "github-actions"]
        : ["public-https"],
      runtime_contract_versions: [1],
      fhir_versions: ["R4", "R4B", "R5"].filter(isFhirReleaseEnabled),
      hosting_available: integrationEnabled() && isHostingEnabled(),
      modes: isGitHubHostingEnabled() ? ["install", "editable"] : ["install"],
      scopes: [
        "account:read",
        "sandbox:read",
        "applications:read",
        "applications:write",
        "applications:publish",
        "projects:create",
      ],
      public_hosting: true,
    });
  });
  router.use("/api/integration/v1", (req, _res, next) => {
    if (!integrationEnabled() || !isHostingEnabled())
      throw new HostingError(503, "Catalog integration is disabled.");
    delete req.sessionAuth;
    delete req.effectivePermissions;
    next();
  });
  router.get("/api/integration/v1/account", async (req, res) => {
    const g = await bearerGrant(req, "account:read");
    const user = await db.user.findUniqueOrThrow({ where: { id: g.userId } });
    const p = await loadEffectivePermissions(db, g.userId);
    res.json({
      subject: user.id,
      display_name: user.displayName,
      email: user.email,
      permissions: {
        applications_deployment: hasPermission(p, "applications_deployment"),
        applications_register: hasPermission(p, "applications_register"),
      },
      scopes: g.scope.split(" "),
    });
  });
  router.get("/api/integration/v1/sandboxes", async (req, res) => {
    const g = await bearerGrant(req, "sandbox:read");
    const sandboxes = await db.sandbox.findMany({
      where: {
        ...enabledFhirVersionWhere(),
        OR: [
          { createdByUserId: g.userId },
          {
            collaborators: {
              some: { userId: g.userId, role: { in: ["MANAGE", "OWNER"] } },
            },
          },
        ],
      },
      orderBy: { name: "asc" },
    });
    res.json({
      sandboxes: sandboxes.map((s) => ({
        id: s.id,
        sandbox_id: s.sandboxId,
        name: s.name,
        fhir_version: s.fhirVersion,
      })),
    });
  });
  router.get("/api/integration/v1/source-options", async (req, res) => {
    const g = await bearerGrant(req, "projects:create");
    try {
      const result = await github<{
        installations: Array<{
          id: number;
          account: { login: string };
          suspended_at: string | null;
        }>;
      }>(
        await userToken(g.userId, loadHostingConfig()),
        "/user/installations?per_page=100",
      );
      res.json({
        installations: result.installations
          .filter((i) => !i.suspended_at)
          .map((i) => ({ id: String(i.id), account: i.account })),
      });
    } catch (error) {
      res.status(error instanceof HostingError ? error.status : 502).json({
        error: "Connect GitHub and approve the Studio GitHub App installation.",
        recovery_url: `${loadHostingConfig().studioOrigin}/profile/connections`,
      });
    }
  });
  router.post("/api/integration/v1/preflight", async (req, res) => {
    const g = await bearerGrant(req, "applications:write");
    const blockers: Array<{
      code: string;
      message: string;
      recovery_url?: string;
    }> = [];
    let body: DeploymentRequest | undefined;
    try {
      body = validatedRequest(req.body);
    } catch (error) {
      blockers.push({
        code: "incompatible",
        message: error instanceof Error ? error.message : "Invalid release.",
      });
    }
    if (body) {
      if (!body.sandboxId && !body.sandbox_id)
        blockers.push({
          code: "no_sandbox",
          message:
            "Choose a compatible sandbox you manage, or create one in Studio.",
          recovery_url: `${loadHostingConfig().studioOrigin}/sandboxes`,
        });
      try {
        const permissions = await loadEffectivePermissions(db, g.userId);
        if (
          !req.body?.application_id &&
          !hasPermission(permissions, "applications_register")
        )
          throw new HostingError(
            403,
            "Application creation permission is required.",
          );
        if (!req.body?.application_id)
          await assertOwnerQuota(db, loadHostingConfig(), g.userId, 1);
        if (req.body?.application_id)
          await applicationFor(g, String(req.body.application_id), "develop");
        else await assertArtifactAccess(body.artifact, g.userId);
        if (body.sandboxId || body.sandbox_id)
          await manageSandbox(
            db,
            g.userId,
            body.sandboxId || body.sandbox_id!,
            body.runtime_contract,
          );
        if (body.mode === "editable" && !req.body?.application_id) {
          if (!g.scope.split(" ").includes("projects:create"))
            throw new HostingError(
              403,
              "Reconnect and consent to editable project creation.",
            );
          if (!body.source_project || !body.repository)
            throw new HostingError(
              400,
              "Choose an editable source and destination repository.",
            );
        }
      } catch (error) {
        blockers.push({
          code:
            error instanceof HostingError && error.status === 401
              ? "github_authorization"
              : "not_ready",
          message:
            error instanceof HostingError
              ? error.message
              : "Source availability check failed.",
          recovery_url: `${loadHostingConfig().studioOrigin}/profile/connections`,
        });
      }
    }
    res.json({ ready: blockers.length === 0, blockers, public_hosting: true });
  });
  router.get("/api/integration/v1/applications", async (req, res) => {
    const g = await bearerGrant(req, "applications:read");
    const page = Math.max(1, Number(req.query.page) || 1),
      size = Math.min(100, Math.max(1, Number(req.query.page_size) || 20));
    const where: Prisma.HostedApplicationWhereInput = {
      integrationClientId: g.clientId,
      OR: [
        { ownerUserId: g.userId },
        { collaborators: { some: { userId: g.userId } } },
      ],
      ...(req.query.status === "trash"
        ? { deletedAt: { not: null } }
        : req.query.status === "all"
          ? {}
          : { deletedAt: null }),
    };
    const [apps, total] = await Promise.all([
      db.hostedApplication.findMany({
        where,
        orderBy: { updatedAt: "desc" },
        skip: (page - 1) * size,
        take: size,
      }),
      db.hostedApplication.count({ where }),
    ]);
    res.json({
      applications: await Promise.all(apps.map((a) => serialize(a, g))),
      total,
      page,
      page_size: size,
    });
  });
  router.get("/api/integration/v1/applications/:id", async (req, res) => {
    const g = await bearerGrant(req, "applications:read");
    res.json(
      await serialize(
        (await applicationFor(g, routeParam(req.params.id), "read", true)).app,
        g,
      ),
    );
  });
  async function startDeployment(req: Request, existingId?: string) {
    const g = await bearerGrant(req, "applications:write");
    let input = req.body;
    let existing: HostedApplication | undefined;
    if (existingId) {
      existing = (await applicationFor(g, existingId, "develop")).app;
      const active = await db.hostedBuild.findFirst({
        where: {
          applicationId: existing.id,
          id:
            existing.previewBuildId ||
            existing.publishedBuildId ||
            "00000000-0000-0000-0000-000000000000",
        },
      });
      input = {
        name: existing.name,
        mode: "install",
        origin: existing.integrationOrigin,
        artifact: active?.artifactSource,
        runtime_contract: active?.runtimeContract,
        source_project: null,
        configuration: active?.publicConfiguration,
        ...req.body,
      };
    }
    const body = validatedRequest(input);
    if (!body.sandboxId && !body.sandbox_id)
      throw new HostingError(
        400,
        "Select a compatible sandbox before deploying.",
      );
    if (
      body.mode === "editable" &&
      !g.scope.split(" ").includes("projects:create")
    )
      throw new HostingError(
        403,
        "Editable project creation requires additional consent.",
      );
    const permissions = await loadEffectivePermissions(db, g.userId);
    if (!existing && !hasPermission(permissions, "applications_register"))
      throw new HostingError(
        403,
        "Application registration permission required.",
      );
    const requestId = req.get("idempotency-key") || body.request_id;
    if (!requestId || requestId.length > 200)
      throw new HostingError(400, "Provide a stable Idempotency-Key.");
    const requestDigest = digest(JSON.stringify(body));
    const result = await db.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`integration-operation:${g.clientId}:${g.userId}:${requestId}`},0))`;
        const prior = await tx.integrationOperation.findUnique({
          where: {
            clientId_userId_requestId: {
              clientId: g.clientId,
              userId: g.userId,
              requestId,
            },
          },
        });
        if (prior) {
          if (prior.requestDigest !== requestDigest)
            throw new HostingError(
              409,
              "Idempotency key already used for a different request.",
            );
          return prior;
        }
        await assertActiveGrant(tx, g.id, "applications:write");
        if (body.sandboxId || body.sandbox_id)
          await manageSandbox(
            tx,
            g.userId,
            body.sandboxId || body.sandbox_id!,
            body.runtime_contract,
          );
        await lockHostingAllocation(tx, [g.userId]);
        if (!existing)
          await assertOwnerQuota(tx, loadHostingConfig(), g.userId, 1);
        const operation = await tx.integrationOperation.create({
          data: {
            clientId: g.clientId,
            userId: g.userId,
            requestId,
            requestDigest,
            request: jsonValue(body),
          },
        });
        if (body.mode === "editable" && !existing) {
          const job = await tx.job.create({
            data: {
              name: `Create editable ${body.name}`,
              jobType: "INTEGRATION_EDITABLE",
              createdByUserId: g.userId,
              input: { operationId: operation.id, grantId: g.id },
            },
          });
          return tx.integrationOperation.update({
            where: { id: operation.id },
            data: { jobId: job.id },
          });
        }
        const app = existing
          ? await tx.hostedApplication.findUniqueOrThrow({
              where: { id: existing.id },
            })
          : await tx.hostedApplication.create({
              data: {
                name: body.name,
                ownerUserId: g.userId,
                createdByUserId: g.userId,
                sourceKind: "artifact",
                integrationClientId: g.clientId,
                integrationOrigin: jsonValue(body.origin),
                runtimeContract: jsonValue(body.runtime_contract),
                publicConfiguration: jsonValue(body.configuration),
                integrationGrantId: g.id,
                launchPath: body.runtime_contract.launch_path,
                callbackPath: body.runtime_contract.callback_paths[0],
                scope: body.runtime_contract.scopes.join(" "),
              },
            });
        if (existing) {
          await lockApplication(tx, app.id);
          await assertCurrentCapability(tx, app.id, g.userId, "develop");
          if (
            app.sourceKind === "repository" &&
            (body.mode !== "editable" ||
              body.source_project?.commit !== app.originatingCommit)
          )
            throw new HostingError(
              409,
              "Editable projects retain their independent source history; only runtime configuration can be changed here.",
            );
          if (app.sourceKind === "artifact" && body.mode !== "install")
            throw new HostingError(
              409,
              "Deployment mode cannot be changed after creation.",
            );
        }
        const previous = app.previewBuildId
          ? await tx.hostedBuild.findUnique({
              where: { id: app.previewBuildId },
            })
          : null;
        const previousArtifact =
          previous?.artifactSource as unknown as BuildArtifact | null;
        const reuse =
          previous?.status === "READY" &&
          previous.directory &&
          (app.sourceKind === "repository" ||
            (previousArtifact?.sha256 === body.artifact.sha256 &&
              previousArtifact?.archive_root === body.artifact.archive_root));
        if (existing && app.sourceKind === "repository" && !reuse)
          throw new HostingError(
            409,
            "Wait for an installed repository preview before changing its public configuration.",
          );
        if (reuse) {
          await assertArtifactAccess(body.artifact, g.userId, true);
          const root = path.join(
            loadHostingConfig().root,
            "apps",
            app.id,
            previous!.contentBuildId || previous!.id,
          );
          for (const entry of [
            body.runtime_contract.launch_path,
            ...body.runtime_contract.callback_paths,
          ]) {
            const file = await stat(
              path.join(root, safeAssetPath(entry)),
            ).catch(() => null);
            if (!file?.isFile())
              throw new HostingError(
                400,
                `Missing declared static entrypoint: ${entry}`,
              );
          }
        }
        const build = await tx.hostedBuild.create({
          data: {
            applicationId: app.id,
            requestedByUserId: g.userId,
            branch: "catalog",
            commit: body.artifact.immutable_id,
            generation: app.generation,
            status: reuse ? "READY" : "IMPORTING",
            artifactSource: jsonValue(body.artifact),
            runtimeContract: jsonValue(body.runtime_contract),
            publicConfiguration: jsonValue(body.configuration),
            integrationGrantId: g.id,
            revisionDigest: digest(
              JSON.stringify({
                artifact: body.artifact,
                contract: body.runtime_contract,
                configuration: body.configuration,
              }),
            ),
            launchPath: body.runtime_contract.launch_path,
            callbackPath: body.runtime_contract.callback_paths[0],
            scope: body.runtime_contract.scopes.join(" "),
            ...(reuse
              ? {
                  directory: previous!.directory,
                  contentBuildId: previous!.contentBuildId || previous!.id,
                }
              : {}),
          },
        });
        const job = await tx.job.create({
          data: {
            name: `Import ${body.name}`,
            jobType: "INTEGRATION_ARTIFACT_IMPORT",
            createdByUserId: g.userId,
            input: { buildId: build.id },
            ...(reuse
              ? {
                  status: "completed",
                  progress: 100,
                  stage: "Configuration preview ready",
                  completedAt: new Date(),
                }
              : {}),
          },
        });
        await tx.hostedBuild.update({
          where: { id: build.id },
          data: { jobId: job.id },
        });
        const updated = await tx.hostedApplication.update({
          where: { id: app.id },
          data: {
            desiredBuildId: build.id,
            name: body.name,
            lastDeveloperActivityAt: new Date(),
            runtimeContract: jsonValue(body.runtime_contract),
            publicConfiguration: jsonValue(body.configuration),
            integrationGrantId: app.sourceKind === "repository" ? null : g.id,
            launchPath: body.runtime_contract.launch_path,
            callbackPath: body.runtime_contract.callback_paths[0],
            scope: body.runtime_contract.scopes.join(" "),
            ...(reuse ? { previewBuildId: build.id } : {}),
          },
        });
        if (reuse) await provisionClients(updated, loadHostingConfig(), tx);
        return tx.integrationOperation.update({
          where: { id: operation.id },
          data: { applicationId: app.id, jobId: job.id },
        });
      },
      { timeout: 30_000 },
    );
    return operationView(result);
  }
  router.post("/api/integration/v1/deployments", async (req, res) => {
    res.status(202).json(await startDeployment(req));
  });
  router.post(
    "/api/integration/v1/applications/:id/preview",
    async (req, res) => {
      res
        .status(202)
        .json(await startDeployment(req, routeParam(req.params.id)));
    },
  );
  async function scopedOperation(req: Request) {
    const g = await bearerGrant(req, "applications:read");
    const op = await db.integrationOperation.findFirst({
      where: {
        id: routeParam(req.params.id),
        clientId: g.clientId,
        userId: g.userId,
      },
    });
    if (!op) throw new HostingError(404, "Operation not found.");
    if (op.applicationId)
      await applicationFor(g, op.applicationId, "read", true);
    return { g, op };
  }
  router.get("/api/integration/v1/operations/:id", async (req, res) => {
    res.json(await operationView((await scopedOperation(req)).op));
  });
  router.post("/api/integration/v1/operations/:id/cancel", async (req, res) => {
    const { g, op } = await scopedOperation(req);
    await assertActiveGrant(db, g.id, "applications:write");
    if (op.applicationId)
      await applicationFor(g, op.applicationId, "develop", true);
    if (op.jobId) await cancelJob(op.jobId);
    res.json(await operationView(op));
  });
  router.post("/api/integration/v1/operations/:id/retry", async (req, res) => {
    const { g, op } = await scopedOperation(req);
    await assertActiveGrant(db, g.id, "applications:write");
    if (op.applicationId) await applicationFor(g, op.applicationId, "develop");
    const updated = await db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`integration-retry:${op.id}`},0))`;
      const original = op.jobId
        ? await tx.job.findUnique({ where: { id: op.jobId } })
        : null;
      const failedPreview = op.applicationId
        ? await tx.hostedApplication.findUnique({
            where: { id: op.applicationId },
          })
        : null;
      const preview = failedPreview?.desiredBuildId
        ? await tx.hostedBuild.findUnique({
            where: { id: failedPreview.desiredBuildId },
          })
        : null;
      const retryEditableBuild =
        original?.jobType === "INTEGRATION_EDITABLE" &&
        original.status === "completed" &&
        preview &&
        ["FAILED", "CANCELLED"].includes(preview.status);
      if (
        !original ||
        (!["failed", "cancelled"].includes(original.status) &&
          !retryEditableBuild)
      )
        throw new HostingError(
          409,
          "Only failed or cancelled operations can be retried.",
        );
      const input = original.input as {
        buildId?: string;
        operationId?: string;
        grantId?: string;
      };
      if (input.buildId) {
        const build = await tx.hostedBuild.findUniqueOrThrow({
          where: { id: input.buildId },
        });
        const app = await tx.hostedApplication.findUniqueOrThrow({
          where: { id: build.applicationId },
        });
        if (
          app.desiredBuildId !== build.id ||
          app.generation !== build.generation
        )
          throw new HostingError(
            409,
            "Deployment superseded. Create a new preview.",
          );
        await tx.hostedBuild.update({
          where: { id: build.id },
          data: { status: "IMPORTING", error: null, integrationGrantId: g.id },
        });
      }
      const job = await tx.job.create({
        data: {
          name: original.name,
          jobType: original.jobType,
          createdByUserId: g.userId,
          input: jsonValue({
            ...input,
            ...(input.grantId ? { grantId: g.id } : {}),
          }),
        },
      });
      if (input.buildId)
        await tx.hostedBuild.update({
          where: { id: input.buildId },
          data: { jobId: job.id },
        });
      return tx.integrationOperation.update({
        where: { id: op.id },
        data: { jobId: job.id },
      });
    });
    res.status(202).json(await operationView(updated));
  });
  router.post(
    "/api/integration/v1/applications/:id/publish",
    async (req, res) => {
      const g = await bearerGrant(req, "applications:publish");
      const id = routeParam(req.params.id),
        expected = String(req.body?.buildId || req.body?.revision_id || "");
      await applicationFor(g, id, "publish");
      await db
        .$transaction(async (tx) => {
          await assertActiveGrant(tx, g.id, "applications:publish");
          await lockApplication(tx, id);
          const { app } = await applicationFor(g, id, "publish", false, tx);
          await assertCurrentCapability(tx, id, g.userId, "publish");
          const build = await tx.hostedBuild.findFirst({
            where: {
              id: expected,
              applicationId: id,
              status: "READY",
              directory: { not: null },
            },
          });
          const review = await tx.integrationReview.findUnique({
            where: {
              applicationId_userId: { applicationId: id, userId: g.userId },
            },
          });
          if (
            app.suspended ||
            !build ||
            app.previewBuildId !== expected ||
            review?.buildId !== expected ||
            review.revisionDigest !== build.revisionDigest
          )
            throw new HostingError(
              409,
              "Review the exact current preview in Studio before publishing.",
            );
          const affected = await tx.hostedSandbox.findMany({
            where: { applicationId: id },
            include: { sandbox: true },
          });
          for (const binding of affected)
            await manageSandbox(
              tx,
              g.userId,
              binding.sandbox.sandboxId,
              build.runtimeContract as unknown as StaticSmartRuntimeContract,
            );
          const sandboxId = req.body?.sandboxId || req.body?.sandbox_id;
          if (!sandboxId)
            throw new HostingError(
              400,
              "Select a sandbox to enable this publication.",
            );
          const sandbox = sandboxId
            ? await manageSandbox(
                tx,
                g.userId,
                String(sandboxId),
                build.runtimeContract as unknown as StaticSmartRuntimeContract,
              )
            : null;
          const published = await tx.hostedApplication.update({
            where: { id },
            data: { publishedBuildId: expected, publishingPaused: false },
          });
          if (sandbox)
            await tx.hostedSandbox.upsert({
              where: {
                applicationId_sandboxId: {
                  applicationId: id,
                  sandboxId: sandbox.id,
                },
              },
              create: { applicationId: id, sandboxId: sandbox.id },
              update: {},
            });
          await provisionClients(published, loadHostingConfig(), tx);
          await tx.hostedAudit.create({
            data: {
              applicationId: id,
              userId: g.userId,
              action: "INTEGRATION_PUBLISHED",
              detail: {
                buildId: expected,
                sandboxId: sandbox?.sandboxId || null,
              },
            },
          });
        })
        .catch(async (error: unknown) => {
          const current = await db.hostedApplication.findUnique({
            where: { id },
          });
          if (
            current?.publishedBuildId === expected &&
            error instanceof HostingError
          )
            throw new HostingError(
              error.status,
              `This revision remains published; the sandbox binding could not be changed. ${error.message}`,
            );
          throw error;
        });
      res.json(await serialize((await applicationFor(g, id)).app, g));
    },
  );
  router.post(
    "/api/integration/v1/applications/:id/unpublish",
    async (req, res) => {
      const g = await bearerGrant(req, "applications:publish");
      const { app } = await applicationFor(
        g,
        routeParam(req.params.id),
        "publish",
      );
      await db.$transaction(async (tx) => {
        await assertActiveGrant(tx, g.id, "applications:publish");
        await lockApplication(tx, app.id);
        await assertCurrentCapability(tx, app.id, g.userId, "publish");
        await tx.hostedApplication.update({
          where: { id: app.id },
          data: { publishedBuildId: null, publishingPaused: true },
        });
        await revokeHostedSessions(tx, app.id, true);
      });
      res.json(await serialize((await applicationFor(g, app.id)).app, g));
    },
  );
  router.put(
    "/api/integration/v1/applications/:id/sandboxes",
    async (req, res) => {
      const g = await bearerGrant(req, "applications:publish");
      const { app } = await applicationFor(
        g,
        routeParam(req.params.id),
        "publish",
      );
      const ids = req.body?.sandboxIds ?? req.body?.sandbox_ids;
      if (
        !Array.isArray(ids) ||
        ids.length > 100 ||
        ids.some((i) => typeof i !== "string")
      )
        throw new HostingError(400, "Provide sandbox identifiers.");
      await db.$transaction(async (tx) => {
        await assertActiveGrant(tx, g.id, "applications:publish");
        await lockApplication(tx, app.id);
        await assertCurrentCapability(tx, app.id, g.userId, "publish");
        const current = await tx.hostedSandbox.findMany({
          where: { applicationId: app.id },
          include: { sandbox: true },
        });
        for (const binding of current)
          await manageSandbox(tx, g.userId, binding.sandbox.sandboxId);
        const locked = await tx.hostedApplication.findUniqueOrThrow({
          where: { id: app.id },
        });
        const active = locked.publishedBuildId
          ? await tx.hostedBuild.findUnique({
              where: { id: locked.publishedBuildId },
            })
          : null;
        const sandboxes = await Promise.all(
          ids.map((id) =>
            manageSandbox(
              tx,
              g.userId,
              id,
              active?.runtimeContract as unknown as StaticSmartRuntimeContract,
            ),
          ),
        );
        await revokeHostedSessions(tx, app.id, true);
        await tx.hostedSandbox.deleteMany({ where: { applicationId: app.id } });
        await tx.hostedSandbox.createMany({
          data: sandboxes.map((s) => ({
            applicationId: app.id,
            sandboxId: s.id,
          })),
          skipDuplicates: true,
        });
      });
      res.json(await serialize((await applicationFor(g, app.id)).app, g));
    },
  );
  for (const action of ["trash", "restore"] as const) {
    const handler = async (req: Request, res: express.Response) => {
      const g = await bearerGrant(req, "applications:write");
      const { app, rights } = await applicationFor(
        g,
        routeParam(req.params.id),
        "publish",
        action === "restore",
      );
      if (!rights.own)
        throw new HostingError(
          403,
          "Only the owner can trash or restore catalog applications.",
        );
      await performHostingAction(
        app.id,
        { ids: [app.id], action, reason: "Catalog integration user request" },
        g.userId,
        {
          authorize: async (tx) => {
            await assertActiveGrant(tx, g.id, "applications:write");
          },
          eligible: async (current, tx) => {
            await assertActiveGrant(tx, g.id, "applications:write");
            return (
              current.ownerUserId === g.userId &&
              current.integrationClientId === g.clientId
            );
          },
        },
      );
      res.json({
        id: app.id,
        status: action === "trash" ? "trashed" : "restored",
      });
    };
    if (action === "trash")
      router.delete("/api/integration/v1/applications/:id", handler);
    else router.post("/api/integration/v1/applications/:id/restore", handler);
  }
  router.get("/api/integration/handoff", async (req, res) => {
    if (!req.sessionAuth?.sessionId)
      throw new HostingError(401, "Sign in to Studio.");
    if (
      typeof req.query.subject !== "string" ||
      req.query.subject !== req.sessionAuth.userId
    )
      throw new HostingError(
        409,
        "This Studio browser is signed into a different account. Switch accounts to continue.",
      );
    const app = await db.hostedApplication.findFirst({
      where: {
        id: String(req.query.applicationId || ""),
        integrationClientId: { not: null },
        deletedAt: null,
      },
      include: { collaborators: true },
    });
    if (
      !app ||
      !capabilities(
        app.ownerUserId,
        req.sessionAuth.userId,
        app.collaborators.find((c) => c.userId === req.sessionAuth!.userId)
          ?.role,
      ).read
    )
      throw new HostingError(404, "Application unavailable.");
    const channel = req.query.channel === "published" ? "published" : "preview";
    const sandbox =
      typeof req.query.sandboxId === "string"
        ? await sandboxAccess(req.sessionAuth.userId, req.query.sandboxId)
        : null;
    const target = new URL(
      "/applications/hosted",
      requireEnv("FHIR_STUDIO_SERVER_UI_BASE_URL", "UI_BASE_URL"),
    );
    target.searchParams.set("app", app.id);
    target.searchParams.set("channel", channel);
    if (sandbox) target.searchParams.set("sandbox", sandbox.sandboxId);
    target.searchParams.set("tab", "Preview");
    res.json({
      application_id: app.id,
      channel,
      sandbox_id: sandbox?.sandboxId || null,
      launch_url: target.href,
    });
  });
  router.post("/api/integration/applications/:id/review", async (req, res) => {
    if (!req.sessionAuth?.sessionId)
      throw new HostingError(401, "Sign in to review previews.");
    const userId = req.sessionAuth.userId;
    const id = routeParam(req.params.id);
    await db.$transaction(async (tx) => {
      await lockApplication(tx, id);
      await assertCurrentCapability(tx, id, userId, "publish");
      const app = await tx.hostedApplication.findUniqueOrThrow({
        where: { id },
      });
      const expected = String(req.body?.revision_id || "");
      const build = await tx.hostedBuild.findFirst({
        where: {
          id: expected,
          applicationId: id,
          status: "READY",
          directory: { not: null },
        },
      });
      if (
        !app.integrationClientId ||
        app.suspended ||
        app.previewBuildId !== expected ||
        !build
      )
        throw new HostingError(
          409,
          "Preview changed. Review the current revision.",
        );
      await tx.integrationReview.upsert({
        where: { applicationId_userId: { applicationId: id, userId } },
        create: {
          applicationId: id,
          userId,
          buildId: expected,
          revisionDigest: build.revisionDigest,
        },
        update: {
          buildId: expected,
          revisionDigest: build.revisionDigest,
          reviewedAt: new Date(),
        },
      });
    });
    res.json({ reviewed_preview_id: String(req.body.revision_id) });
  });
  return router;
}
