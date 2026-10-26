import assert from "node:assert/strict";
import crypto from "node:crypto";
import { before, after, test, mock } from "node:test";
import { getPrisma, disconnectPrisma } from "../src/db/prisma.js";
import { syncIdpRoleMappings } from "../src/authorization/iam.js";
import { loadEffectivePermissions } from "../src/authorization/effectivePermissions.js";
import {
  resolveSessionFromRequest,
  SESSION_COOKIE,
} from "../src/authentication/session.js";
import { encryptTokenBundle } from "../src/authentication/token-crypto.js";
import { hmacSign } from "../src/authentication/hmac.js";
import { clearOidcConfigCache } from "../src/authentication/oidc.js";
import type { OidcBffConfig } from "../src/auth/sso_config.js";

const databaseUrl = process.env.FHIR_STUDIO_SECURITY_TEST_DATABASE_URL ?? process.env.FHIR_STUDIO_INTEGRATION_TEST_DATABASE_URL;
assert.ok(
  databaseUrl && /test|integration/.test(new URL(databaseUrl).pathname),
  "Use a disposable integration test database.",
);
process.env.FHIR_STUDIO_SERVER_DATABASE_URL = databaseUrl;
const db = getPrisma();
const prefix = `sso-security-${crypto.randomUUID()}`;
const users: string[] = [];
let roleId: string, groupId: string, ordinaryRoleId: string;
async function user() {
  const row = await db.user.create({
    data: { ssoIssuer: prefix, ssoSubject: crypto.randomUUID() },
  });
  users.push(row.id);
  return row.id;
}
before(async () => {
  const role = await db.role.create({
    data: {
      name: `${prefix}-administrator`,
      ssoRoleMapping: `${prefix}-admin`,
      permission_global_manage: true,
    },
  });
  roleId = role.id;
  const group = await db.group.create({
    data: {
      name: `${prefix}-administrators`,
      ssoRoleMapping: `${prefix}-admin`,
    },
  });
  groupId = group.id;
  await db.appointment.create({
    data: { entityType: "Group", entityId: groupId, roleId, manualGrant: true },
  });
  const ordinary = await db.role.create({
    data: { name: `${prefix}-manual`, permission_data_manager: true },
  });
  ordinaryRoleId = ordinary.id;
});
after(async () => {
  await db.appointment.deleteMany({
    where: {
      OR: [
        { entityId: { in: [...users, groupId] } },
        { roleId: { in: [roleId, ordinaryRoleId] } },
      ],
    },
  });
  await db.group.deleteMany({ where: { id: groupId } });
  await db.user.deleteMany({ where: { id: { in: users } } });
  await db.role.deleteMany({ where: { id: { in: [roleId, ordinaryRoleId] } } });
  await disconnectPrisma();
});

test("removing the final IdP claim revokes both mapped roles and groups, including PAT effective permissions", async () => {
  const userId = await user();
  await syncIdpRoleMappings(db, userId, [`${prefix}-admin`]);
  assert.equal(
    (await loadEffectivePermissions(db, userId)).global_manage,
    true,
  );
  const appointment = await db.appointment.findFirstOrThrow({
    where: { entityId: userId, roleId },
  });
  assert.equal(appointment.manualGrant, false);
  assert.equal(appointment.ssoGrant, true);
  await syncIdpRoleMappings(db, userId, []);
  assert.equal(
    (await loadEffectivePermissions(db, userId)).global_manage,
    false,
  );
  assert.equal(await db.member.count({ where: { userId } }), 0);
  assert.equal(await db.appointment.count({ where: { entityId: userId } }), 0);
});

test("independent explicit manual appointments and memberships survive SSO revocation", async () => {
  const userId = await user();
  await db.member.create({ data: { userId, groupId, manualGrant: true } });
  await db.appointment.create({
    data: { entityType: "User", entityId: userId, roleId, manualGrant: true },
  });
  await syncIdpRoleMappings(db, userId, [`${prefix}-admin`]);
  await syncIdpRoleMappings(db, userId, []);
  assert.equal(
    (await loadEffectivePermissions(db, userId)).global_manage,
    true,
  );
  assert.equal(
    (
      await db.member.findUniqueOrThrow({
        where: { userId_groupId: { userId, groupId } },
      })
    ).ssoGrant,
    false,
  );
  assert.equal(
    (
      await db.appointment.findFirstOrThrow({
        where: { entityId: userId, roleId },
      })
    ).manualGrant,
    true,
  );
});

test("legacy mapped privileges fail closed while unrelated legacy manual appointments remain", async () => {
  const userId = await user();
  await db.member.create({ data: { userId, groupId } });
  await db.appointment.createMany({
    data: [
      { entityType: "User", entityId: userId, roleId },
      { entityType: "User", entityId: userId, roleId: ordinaryRoleId },
    ],
  });
  await syncIdpRoleMappings(db, userId, []);
  assert.equal(
    (await loadEffectivePermissions(db, userId)).global_manage,
    false,
  );
  assert.equal(await db.member.count({ where: { userId } }), 0);
  const remaining = await db.appointment.findMany({
    where: { entityId: userId },
  });
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].roleId, ordinaryRoleId);
  assert.equal(remaining[0].manualGrant, true);
});

test("legacy name-based SSO grants are reconciled from prior session claims", async () => {
  const userId = await user();
  const role = await db.role.findUniqueOrThrow({
    where: { id: ordinaryRoleId },
  });
  await db.appointment.create({
    data: { entityType: "User", entityId: userId, roleId: ordinaryRoleId },
  });
  await db.session.create({
    data: {
      userId,
      expiresAt: new Date(Date.now() + 60_000),
      idleExpiresAt: new Date(Date.now() + 60_000),
      ssoRoles: [role.name],
    },
  });
  await syncIdpRoleMappings(db, userId, []);
  assert.equal(await db.appointment.count({ where: { entityId: userId } }), 0);
});

test("refreshing a session with empty current roles revokes old mapped privileges and clears cached claims", async () => {
  const userId = await user();
  await syncIdpRoleMappings(db, userId, [`${prefix}-admin`]);
  const secret = "sso-regression-session-secret";
  const config: OidcBffConfig = {
    databaseUrl: databaseUrl!,
    issuerUrl: "https://idp.example.org/",
    clientId: "test-client",
    clientSecret: "test-secret",
    clientSecretPrevious: [],
    redirectUrl: "https://studio.example.org/sso/callback",
    scopes: "openid profile",
    postLogoutRedirectUrl: "https://studio.example.org/",
    uiBaseUrl: "https://studio.example.org",
    corsOrigins: ["https://studio.example.org"],
    sessionSecret: secret,
    sessionSecrets: [secret],
    sessionIdleHours: 1,
    sessionAbsoluteHours: 2,
    rolesClaim: "roles",
    bootstrapAdminEmails: [],
    apiTokenPepper: "test-pepper",
    nodeEnv: "test",
  };
  const session = await db.session.create({
    data: {
      userId,
      expiresAt: new Date(Date.now() + 3600_000),
      idleExpiresAt: new Date(Date.now() + 3600_000),
      accessTokenExpiresAt: new Date(0),
      ssoRoles: [`${prefix}-admin`],
      encryptedTokenBundle: encryptTokenBundle(
        { refreshToken: "sentinel-refresh", idToken: "" },
        secret,
      ),
    },
  });
  mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    const body = url.includes(".well-known")
      ? {
          issuer: config.issuerUrl,
          token_endpoint: "https://idp.example.org/token",
          authorization_endpoint: "https://idp.example.org/authorize",
          jwks_uri: "https://idp.example.org/jwks",
        }
      : {
          access_token: `e30.${Buffer.from(JSON.stringify({ roles: [] })).toString("base64url")}.signature`,
          token_type: "Bearer",
          expires_in: 3600,
        };
    return new Response(JSON.stringify(body), {
      headers: { "content-type": "application/json" },
    });
  });
  clearOidcConfigCache();
  try {
    const resolved = await resolveSessionFromRequest(
      { cookies: { [SESSION_COOKIE]: hmacSign(session.id, secret) } },
      config,
    );
    assert.ok(resolved);
    assert.deepEqual(resolved.ssoRoles, []);
    assert.equal(
      (await loadEffectivePermissions(db, userId)).global_manage,
      false,
    );
    assert.deepEqual(
      (await db.session.findUniqueOrThrow({ where: { id: session.id } }))
        .ssoRoles,
      [],
    );
  } finally {
    mock.restoreAll();
    clearOidcConfigCache();
  }
});
