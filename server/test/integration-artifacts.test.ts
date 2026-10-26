// Author: Preston Lee

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  publicAddress,
  downloadPublicArchive,
} from "../src/integrations/artifacts.js";
import {
  artifactErrors,
  deploymentProfileErrors,
  defaultStaticSmartContract,
} from "../src/integrations/catalog-contract.js";

test("artifact downloads reject local, reserved and mapped addresses before contacting sources", async () => {
  for (const address of [
    "127.0.0.1",
    "10.1.2.3",
    "172.16.0.1",
    "192.168.0.1",
    "169.254.169.254",
    "100.64.0.1",
    "198.18.0.1",
    "224.0.0.1",
    "::1",
    "fc00::1",
    "fe80::1",
    "::ffff:127.0.0.1",
    "2001:db8::1",
  ])
    assert.equal(publicAddress(address), false, address);
  assert.equal(publicAddress("1.1.1.1"), true);
  assert.equal(publicAddress("2606:4700:4700::1111"), true);
  for (const url of [
    "http://public.example/app.zip",
    "https://user:secret@public.example/app.zip",
    "https://localhost/app.zip",
    "https://public.example:8443/app.zip",
  ])
    await assert.rejects(
      downloadPublicArchive(url, "/unused", 100, new AbortController().signal),
      /public HTTPS/,
    );
});
test("catalog profiles require actual static SMART inputs and reject source credentials and private runtime secrets", () => {
  const artifact = {
    name: "app",
    format_version: 1,
    resolver: "public-https",
    locator: { url: "https://cdn.example/app.zip" },
    immutable_id: "v1",
    sha256: "a".repeat(64),
    archive_root: "",
  };
  assert.deepEqual(artifactErrors(artifact), {});
  assert.ok(
    artifactErrors({
      ...artifact,
      locator: { url: "https://cdn.example/app.zip?token=private" },
    }).locator,
  );
  const contract = defaultStaticSmartContract();
  assert.deepEqual(
    deploymentProfileErrors({
      name: "app",
      artifact_id: "a",
      runtime_contract: contract,
      source_project: null,
    }),
    {},
  );
  assert.ok(
    deploymentProfileErrors({
      name: "app",
      artifact_id: "a",
      runtime_contract: { ...contract, authentication: "external-sso" },
    }).runtime_contract,
  );
  assert.ok(
    deploymentProfileErrors({
      name: "app",
      artifact_id: "a",
      runtime_contract: {
        ...contract,
        dependencies: [{ name: "api", kind: "backend", required: true }],
      },
    }).dependencies,
  );
});
