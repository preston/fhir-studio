// Author: Preston Lee

import crypto from "node:crypto";
import express, { type Request, type Router } from "express";
import type { IntegrationGrant, Prisma } from "@prisma/client";
import { getPrisma } from "../db/prisma.js";
import { HostingError, assertDeploymentPermission } from "../hosted/access.js";
import { requireEnv } from "../env.js";
import { hasPermission } from "../authorization/permissions.js";
import { routeParam } from "../http/routeParam.js";

export const integrationScopes = [
  "account:read",
  "sandbox:read",
  "applications:read",
  "applications:write",
  "applications:publish",
  "projects:create",
] as const;
export function integrationEnabled(): boolean {
  return process.env.FHIR_STUDIO_INTEGRATION_ENABLED === "true";
}
export function integrationIssuer(): string {
  const configured = requireEnv("FHIR_STUDIO_INTEGRATION_ISSUER");
  const url = new URL(configured);
  if (
    url.hash ||
    url.search ||
    url.username ||
    url.password ||
    url.pathname !== "/integration" ||
    (url.protocol !== "https:" &&
      !(
        url.protocol === "http:" &&
        process.env.NODE_ENV !== "production" &&
        ["localhost", "127.0.0.1"].includes(url.hostname)
      ))
  )
    throw new Error(
      "FHIR_STUDIO_INTEGRATION_ISSUER must be an HTTPS origin followed by /integration.",
    );
  return url.href.replace(/\/$/, "");
}
export const digest = (value: string): string =>
  crypto.createHash("sha256").update(value).digest("hex");
const token = (kind: string): string =>
  `fsi_${kind}_${crypto.randomBytes(32).toString("base64url")}`;
const equal = (a: string, b: string): boolean =>
  a.length === b.length &&
  crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
export function jsonValue(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}
const query = (req: Request, key: string): string =>
  typeof req.query[key] === "string" ? (req.query[key] as string) : "";
function requireBrowser(req: Request): string {
  if (!req.sessionAuth?.sessionId)
    throw new HostingError(401, "Sign in with your Studio browser account.");
  return req.sessionAuth.userId;
}
function validateClient(value: unknown): {
  name: string;
  redirectUris: string[];
  scopes: string[];
  enabled: boolean;
} {
  const body = value as Record<string, unknown>;
  if (
    !body ||
    typeof body.name !== "string" ||
    !body.name.trim() ||
    body.name.length > 200 ||
    !Array.isArray(body.redirect_uris) ||
    !body.redirect_uris.length ||
    body.redirect_uris.length > 10 ||
    !Array.isArray(body.scopes) ||
    !body.scopes.length ||
    body.scopes.some(
      (s) =>
        !integrationScopes.includes(s as (typeof integrationScopes)[number]),
    )
  )
    throw new HostingError(
      400,
      "Provide a name, exact callback URLs, and supported integration scopes.",
    );
  const uris = body.redirect_uris.map((value) => {
    if (typeof value !== "string")
      throw new HostingError(400, "Invalid callback URL.");
    const uri = new URL(value);
    if (
      uri.hash ||
      uri.username ||
      uri.password ||
      value.includes("*") ||
      (uri.protocol !== "https:" &&
        !(
          uri.protocol === "http:" &&
          process.env.NODE_ENV !== "production" &&
          ["localhost", "127.0.0.1"].includes(uri.hostname)
        ))
    )
      throw new HostingError(
        400,
        "Callbacks require HTTPS, no fragment or embedded credentials.",
      );
    return uri.href;
  });
  return {
    name: body.name.trim(),
    redirectUris: uris,
    scopes: body.scopes as string[],
    enabled: body.enabled !== false,
  };
}
export async function assertActiveGrant(
  db: Prisma.TransactionClient,
  id: string,
  scope?: string,
): Promise<IntegrationGrant> {
  const identity = await db.integrationGrant.findUnique({
    where: { id },
    select: { clientId: true },
  });
  if (identity)
    await db.$queryRaw`SELECT id FROM integration_clients WHERE id = ${identity.clientId}::uuid FOR SHARE`;
  await db.$queryRaw`SELECT id FROM integration_grants WHERE id = ${id}::uuid FOR SHARE`;
  const grant = await db.integrationGrant.findUnique({
    where: { id },
    include: { client: true, user: true },
  });
  if (
    !grant ||
    grant.revokedAt ||
    !grant.client.enabled ||
    grant.user.isSuspended ||
    grant.refreshExpiresAt <= new Date() ||
    (scope &&
      (!grant.scope.split(" ").includes(scope) ||
        !Array.isArray(grant.client.scopes) ||
        !grant.client.scopes.includes(scope)))
  )
    throw new HostingError(
      403,
      "Integration authorization expired, was revoked, or lacks the required scope.",
    );
  await assertDeploymentPermission(db, grant.userId);
  return {
    ...grant,
    scope: grant.scope
      .split(" ")
      .filter(
        (scope) =>
          Array.isArray(grant.client.scopes) &&
          grant.client.scopes.includes(scope),
      )
      .join(" "),
  };
}
export async function bearerGrant(
  req: Request,
  scope: string,
): Promise<IntegrationGrant> {
  const value = /^Bearer (fsi_access_[A-Za-z0-9_-]+)$/.exec(
    req.get("authorization") || "",
  )?.[1];
  if (!value)
    throw new HostingError(401, "An integration access token is required.");
  const grant = await getPrisma().integrationGrant.findUnique({
    where: { accessTokenHash: digest(value) },
  });
  if (!grant || grant.accessExpiresAt <= new Date())
    throw new HostingError(
      401,
      "Integration access token expired or is invalid.",
    );
  const active = await assertActiveGrant(getPrisma(), grant.id, scope);
  await getPrisma().integrationGrant.update({
    where: { id: grant.id },
    data: { lastUsedAt: new Date() },
  });
  return active;
}
export function createIntegrationOAuthRouter(): Router {
  const router = express.Router();
  const db = getPrisma();
  router.get(
    "/.well-known/oauth-authorization-server/integration",
    (_req, res) => {
      if (!process.env.FHIR_STUDIO_INTEGRATION_ISSUER) {
        res.sendStatus(404);
        return;
      }
      const issuer = integrationIssuer();
      res.json({
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        revocation_endpoint: `${issuer}/revoke`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["client_secret_basic"],
        scopes_supported: integrationScopes,
        authorization_response_iss_parameter_supported: true,
      });
    },
  );
  router.use(
    ["/integration", "/api/integration/authorization"],
    (_req, res, next) => {
      if (
        !integrationEnabled() &&
        _req.originalUrl.split("?")[0] !== "/integration/revoke"
      ) {
        res.status(503).json({ error: "Integration is disabled." });
        return;
      }
      next();
    },
  );
  router.get("/integration/authorize", (req, res) => {
    const target = new URL(
      "/integration/authorize",
      requireEnv("FHIR_STUDIO_SERVER_UI_BASE_URL", "UI_BASE_URL"),
    );
    for (const [key, value] of Object.entries(req.query))
      if (typeof value === "string") target.searchParams.set(key, value);
    res.redirect(target.href);
  });
  router.get("/api/integration/authorization", async (req, res) => {
    const userId = requireBrowser(req);
    await assertDeploymentPermission(db, userId);
    if (
      !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(
        query(req, "client_id"),
      )
    )
      throw new HostingError(400, "Invalid integration client.");
    const client = await db.integrationClient.findFirst({
      where: { id: query(req, "client_id"), enabled: true },
    });
    const redirectUri = query(req, "redirect_uri");
    const scopes = [...new Set(query(req, "scope").split(" ").filter(Boolean))];
    const challenge = query(req, "code_challenge");
    if (
      !client ||
      !Array.isArray(client.redirectUris) ||
      !client.redirectUris.includes(redirectUri) ||
      query(req, "response_type") !== "code" ||
      query(req, "code_challenge_method") !== "S256" ||
      !/^[A-Za-z0-9_-]{43}$/.test(challenge) ||
      !scopes.length ||
      !Array.isArray(client.scopes) ||
      scopes.some((s) => !(client.scopes as string[]).includes(s)) ||
      !query(req, "state") ||
      query(req, "state").length > 1000
    )
      throw new HostingError(
        400,
        "Invalid client, callback, scope, state, or PKCE request.",
      );
    const request = await db.integrationAuthorization.create({
      data: {
        clientId: client.id,
        userId,
        sessionId: req.sessionAuth!.sessionId,
        redirectUri,
        scope: scopes.join(" "),
        state: query(req, "state"),
        codeChallenge: challenge,
        expiresAt: new Date(Date.now() + 600_000),
      },
    });
    res.setHeader("Cache-Control", "no-store");
    res.json({
      request_id: request.id,
      client: { id: client.id, name: client.name },
      scopes,
      account: {
        subject: userId,
        display_name: req.sessionAuth!.displayName,
        email: req.sessionAuth!.email,
      },
    });
  });
  router.post("/api/integration/authorization/:id", async (req, res) => {
    const userId = requireBrowser(req);
    const request = await db.integrationAuthorization.findUnique({
      where: { id: routeParam(req.params.id) },
      include: { client: true },
    });
    if (
      !request ||
      request.userId !== userId ||
      request.sessionId !== req.sessionAuth!.sessionId ||
      request.usedAt ||
      request.approvedAt ||
      request.expiresAt <= new Date() ||
      !request.client.enabled
    )
      throw new HostingError(
        400,
        "Authorization request expired or belongs to another browser session.",
      );
    await assertDeploymentPermission(db, userId);
    const code = token("code");
    const approved = req.body?.approve === true;
    const updated = await db.integrationAuthorization.updateMany({
      where: { id: request.id, approvedAt: null, usedAt: null },
      data: approved
        ? {
            approvedAt: new Date(),
            codeHash: digest(code),
            expiresAt: new Date(Date.now() + 60_000),
          }
        : { usedAt: new Date() },
    });
    if (updated.count !== 1)
      throw new HostingError(409, "Authorization request already completed.");
    const target = new URL(request.redirectUri);
    target.searchParams.set("state", request.state);
    target.searchParams.set("iss", integrationIssuer());
    target.searchParams.set(
      approved ? "code" : "error",
      approved ? code : "access_denied",
    );
    res.setHeader("Cache-Control", "no-store");
    res.json({ redirect_url: target.href });
  });
  async function authenticateClient(req: Request, requireEnabled = true) {
    const basic = /^Basic (.+)$/.exec(req.get("authorization") || "")?.[1];
    let id = "",
      secret = "";
    try {
      const decoded = Buffer.from(basic || "", "base64").toString();
      const index = decoded.indexOf(":");
      id = decodeURIComponent(decoded.slice(0, index));
      secret = decodeURIComponent(decoded.slice(index + 1));
    } catch {
      /* reject */
    }
    const client = await db.integrationClient.findUnique({
      where: {
        id: /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(id)
          ? id
          : "00000000-0000-0000-0000-000000000000",
      },
    });
    if (
      !client ||
      (requireEnabled && !client.enabled) ||
      !equal(digest(secret), client.secretHash)
    )
      throw new HostingError(401, "invalid_client");
    return client;
  }
  router.post("/integration/token", async (req, res) => {
    const client = await authenticateClient(req);
    const body = req.body as Record<string, string>;
    const access = token("access"),
      refresh = token("refresh");
    const grant = await db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM integration_clients WHERE id = ${client.id}::uuid FOR SHARE`;
      const currentClient = await tx.integrationClient.findUniqueOrThrow({
        where: { id: client.id },
      });
      if (!currentClient.enabled) throw new HostingError(401, "invalid_client");
      if (body.grant_type === "authorization_code") {
        const code = await tx.integrationAuthorization.findUnique({
          where: { codeHash: digest(body.code || "") },
        });
        const verifier = body.code_verifier || "";
        if (
          !code ||
          code.clientId !== client.id ||
          !code.approvedAt ||
          code.usedAt ||
          code.expiresAt <= new Date() ||
          code.redirectUri !== body.redirect_uri ||
          !/^[A-Za-z0-9._~-]{43,128}$/.test(verifier) ||
          !equal(
            crypto.createHash("sha256").update(verifier).digest("base64url"),
            code.codeChallenge,
          )
        )
          throw new HostingError(400, "invalid_grant");
        if (
          !Array.isArray(currentClient.scopes) ||
          code.scope
            .split(" ")
            .some(
              (scope) => !(currentClient.scopes as string[]).includes(scope),
            )
        )
          throw new HostingError(400, "invalid_scope");
        await assertDeploymentPermission(tx, code.userId);
        const consumed = await tx.integrationAuthorization.updateMany({
          where: { id: code.id, usedAt: null },
          data: { usedAt: new Date() },
        });
        if (consumed.count !== 1) throw new HostingError(400, "invalid_grant");
        return tx.integrationGrant.create({
          data: {
            clientId: client.id,
            userId: code.userId,
            scope: code.scope,
            accessTokenHash: digest(access),
            accessExpiresAt: new Date(Date.now() + 300_000),
            refreshTokenHash: digest(refresh),
            refreshExpiresAt: new Date(Date.now() + 30 * 86400000),
          },
        });
      }
      if (body.grant_type !== "refresh_token")
        throw new HostingError(400, "unsupported_grant_type");
      const hash = digest(body.refresh_token || "");
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`integration-refresh:${client.id}`},0))`;
      const retired = await tx.integrationRetiredToken.findUnique({
        where: { hash },
      });
      if (retired) {
        const family = await tx.integrationGrant.findUnique({
          where: { id: retired.grantId },
        });
        if (family?.clientId === client.id) {
          await tx.integrationGrant.update({
            where: { id: family.id },
            data: { revokedAt: new Date() },
          });
          return null;
        }
      }
      const current = await tx.integrationGrant.findFirst({
        where: { clientId: client.id, refreshTokenHash: hash },
      });
      if (
        !current ||
        current.revokedAt ||
        current.refreshExpiresAt <= new Date()
      )
        throw new HostingError(400, "invalid_grant");
      if (current.previousRefreshTokenHash === hash) return null;
      await assertActiveGrant(tx, current.id);
      await tx.integrationRetiredToken.create({
        data: {
          hash,
          grantId: current.id,
          expiresAt: current.refreshExpiresAt,
        },
      });
      return tx.integrationGrant.update({
        where: { id: current.id },
        data: {
          scope: current.scope
            .split(" ")
            .filter(
              (scope) =>
                Array.isArray(currentClient.scopes) &&
                currentClient.scopes.includes(scope),
            )
            .join(" "),
          previousRefreshTokenHash: hash,
          refreshTokenHash: digest(refresh),
          accessTokenHash: digest(access),
          accessExpiresAt: new Date(Date.now() + 300_000),
        },
      });
    });
    if (!grant) {
      await db.integrationGrant.updateMany({
        where: {
          clientId: client.id,
          previousRefreshTokenHash: digest(body.refresh_token || ""),
        },
        data: { revokedAt: new Date() },
      });
      throw new HostingError(400, "invalid_grant");
    }
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Pragma", "no-cache");
    res.json({
      access_token: access,
      token_type: "Bearer",
      expires_in: 300,
      refresh_token: refresh,
      scope: grant.scope,
    });
  });
  router.post("/integration/revoke", async (req, res) => {
    const client = await authenticateClient(req, false);
    const hash = digest(
      typeof req.body?.token === "string" ? req.body.token : "",
    );
    const retired = await db.integrationRetiredToken.findUnique({
      where: { hash },
    });
    await db.integrationGrant.updateMany({
      where: {
        clientId: client.id,
        OR: [
          { accessTokenHash: hash },
          { refreshTokenHash: hash },
          { previousRefreshTokenHash: hash },
          ...(retired ? [{ id: retired.grantId }] : []),
        ],
      },
      data: { revokedAt: new Date() },
    });
    res.sendStatus(200);
  });
  router.get("/api/integration/connections", async (req, res) => {
    const userId = requireBrowser(req);
    const rows = await db.integrationGrant.findMany({
      where: { userId, revokedAt: null },
      include: { client: { select: { id: true, name: true } } },
      orderBy: { createdAt: "desc" },
    });
    res.json({
      connections: rows.map((g) => ({
        id: g.id,
        client: g.client,
        scopes: g.scope.split(" "),
        created_at: g.createdAt,
        last_used_at: g.lastUsedAt,
        revoked_at: g.revokedAt,
      })),
    });
  });
  router.delete("/api/integration/connections/:id", async (req, res) => {
    const userId = requireBrowser(req);
    await db.integrationGrant.updateMany({
      where: { id: routeParam(req.params.id), userId },
      data: { revokedAt: new Date() },
    });
    res.sendStatus(204);
  });
  router.use("/api/admin/integration-clients", (req, _res, next) => {
    requireBrowser(req);
    if (!hasPermission(req.effectivePermissions, "global_manage"))
      throw new HostingError(403, "Administrator permission required.");
    next();
  });
  const summary = (c: {
    id: string;
    name: string;
    redirectUris: unknown;
    scopes: unknown;
    enabled: boolean;
    createdAt: Date;
  }) => ({
    id: c.id,
    name: c.name,
    redirect_uris: c.redirectUris,
    scopes: c.scopes,
    enabled: c.enabled,
    created_at: c.createdAt,
  });
  router.get("/api/admin/integration-clients", async (_req, res) => {
    res.json({
      clients: (
        await db.integrationClient.findMany({ orderBy: { name: "asc" } })
      ).map(summary),
    });
  });
  router.post("/api/admin/integration-clients", async (req, res) => {
    const settings = validateClient(req.body),
      secret = token("client");
    const c = await db.integrationClient.create({
      data: { ...settings, secretHash: digest(secret) },
    });
    res.status(201).json({ ...summary(c), client_secret: secret });
  });
  router.patch("/api/admin/integration-clients/:id", async (req, res) => {
    const c = await db.integrationClient.update({
      where: { id: routeParam(req.params.id) },
      data: validateClient(req.body),
    });
    res.json(summary(c));
  });
  router.post("/api/admin/integration-clients/:id/rotate", async (req, res) => {
    const secret = token("client");
    await db.$transaction(async (tx) => {
      await tx.integrationClient.update({
        where: { id: routeParam(req.params.id) },
        data: { secretHash: digest(secret) },
      });
      await tx.integrationGrant.updateMany({
        where: { clientId: routeParam(req.params.id), revokedAt: null },
        data: { revokedAt: new Date() },
      });
    });
    res.json({ client_secret: secret });
  });
  return router;
}
