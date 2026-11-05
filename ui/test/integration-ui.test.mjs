// Author: Preston Lee

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  integrationSignInUrl,
  verifiedLauncherPath,
} from "../src/app/integration/integration-ui.ts";

test("integration sign-in preserves the local authorization request and account-selection intent", () => {
  const url = new URL(
    integrationSignInUrl(
      "/integration/authorize",
      "?state=a&client_id=b",
      true,
    ),
    "https://studio.example",
  );
  assert.equal(url.pathname, "/sso/login");
  assert.equal(
    url.searchParams.get("returnTo"),
    "/integration/authorize?state=a&client_id=b",
  );
  assert.equal(url.searchParams.get("prompt"), "select_account");
  assert.equal(
    new URL(
      integrationSignInUrl("//evil.example", ""),
      "https://studio.example",
    ).searchParams.get("returnTo"),
    "/",
  );
});

test("handoff accepts the deployment launcher and rejects remote destinations", () => {
  assert.equal(
    verifiedLauncherPath(
      "/deployment/github-repositories?app=abc&tab=Launch",
      "https://studio.example",
    ),
    "/deployment/github-repositories?app=abc&tab=Launch",
  );
  for (const value of [
    "https://evil.example/deployment/github-repositories",
    "//evil.example/deployment/github-repositories",
    "https://evil.example/applications/hosted",
    "//evil.example/applications/hosted",
    "javascript:alert(1)",
    "/api/session",
    "/deployment/github-repositories/other",
    "https://user:secret@studio.example/deployment/github-repositories",
    "https://user:secret@studio.example/applications/hosted",
  ])
    assert.equal(verifiedLauncherPath(value, "https://studio.example"), null);
});

test("handoff normalizes existing launcher links while preserving application and launch context", () => {
  for (const path of [
    "/applications/hosted",
    "/deployment/github-repositories",
  ]) {
    for (const prefix of ["", "https://studio.example"]) {
      assert.equal(
        verifiedLauncherPath(
          `${prefix}${path}?app=abc&sandbox=def&tab=Launch`,
          "https://studio.example",
        ),
        "/deployment/github-repositories?app=abc&sandbox=def&tab=Launch",
      );
    }
  }
});
