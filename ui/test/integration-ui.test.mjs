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

test("handoff accepts only the Studio hosted-app launcher and rejects remote destinations", () => {
  assert.equal(
    verifiedLauncherPath(
      "/applications/hosted?app=abc&channel=preview",
      "https://studio.example",
    ),
    "/applications/hosted?app=abc&channel=preview",
  );
  for (const value of [
    "https://evil.example/applications/hosted",
    "//evil.example/applications/hosted",
    "javascript:alert(1)",
    "/api/session",
    "https://user:secret@studio.example/applications/hosted",
  ])
    assert.equal(verifiedLauncherPath(value, "https://studio.example"), null);
});
