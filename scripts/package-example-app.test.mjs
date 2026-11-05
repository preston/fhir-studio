import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { inflateRawSync } from "node:zlib";
import { packageExampleApp } from "./package-example-app.mjs";

const manifest = JSON.parse(
  await readFile(
    new URL("../apps/viets-ehr/fhir-studio.json", import.meta.url),
    "utf8",
  ),
);

async function fixture(run) {
  const parent = await mkdtemp(path.join(tmpdir(), "studio-example-"));
  const project = path.join(parent, "example");
  await mkdir(path.join(project, "public"), { recursive: true });
  await writeFile(
    path.join(project, "package.json"),
    JSON.stringify({ fhirStudio: { staticDirectory: "public" } }),
  );
  await writeFile(
    path.join(project, "fhir-studio.json"),
    JSON.stringify(manifest),
  );
  await writeFile(
    path.join(project, "public/index.html"),
    '<script type="module" src="./app.js"></script>',
  );
  await writeFile(
    path.join(project, "public/app.js"),
    'document.body.dataset.ready = "true";',
  );
  try {
    await run(project);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
}

function unzip(buffer) {
  const files = new Map();
  let offset = 0;
  while (buffer.readUInt32LE(offset) === 0x04034b50) {
    const compressedSize = buffer.readUInt32LE(offset + 18);
    const nameLength = buffer.readUInt16LE(offset + 26);
    const extraLength = buffer.readUInt16LE(offset + 28);
    const name = buffer
      .subarray(offset + 30, offset + 30 + nameLength)
      .toString("utf8");
    const start = offset + 30 + nameLength + extraLength;
    files.set(
      name,
      inflateRawSync(buffer.subarray(start, start + compressedSize)).toString(
        "utf8",
      ),
    );
    offset = start + compressedSize;
  }
  assert.equal(buffer.readUInt32LE(offset), 0x02014b50);
  return files;
}

test("packages flat static assets and a manifest, excluding source and producing repeatable ZIPs", async () => {
  await fixture(async (project) => {
    await writeFile(path.join(project, ".env"), "SECRET=source-only");
    const result = await packageExampleApp(project);
    const first = await readFile(result.output);
    const files = unzip(first);
    assert.deepEqual(
      [...files.keys()],
      ["fhir-studio.json", "app.js", "index.html"],
    );
    assert.equal(JSON.parse(files.get("fhir-studio.json")).name, "Viet's EHR");
    assert.equal(result.output, path.join(project, "dist/example.zip"));
    await packageExampleApp(project);
    assert.deepEqual(await readFile(result.output), first);
  });
});

test("supports an explicit compiled directory, including dist output on repeated packaging", async () => {
  await fixture(async (project) => {
    await mkdir(path.join(project, "dist"));
    await writeFile(
      path.join(project, "dist/index.html"),
      "<h1>Compiled app</h1>",
    );
    await packageExampleApp(project, "dist");
    const result = await packageExampleApp(project, "dist");
    assert.deepEqual(
      [...unzip(await readFile(result.output)).keys()],
      ["fhir-studio.json", "index.html"],
    );
  });
});

test("requires real callbacks and rejects symlinks, secret paths, and duplicate names", async () => {
  await fixture(async (project) => {
    const callbackManifest = structuredClone(manifest);
    callbackManifest.runtime_contract.callback_paths = ["callback.html"];
    await writeFile(
      path.join(project, "fhir-studio.json"),
      JSON.stringify(callbackManifest),
    );
    await assert.rejects(
      packageExampleApp(project),
      /Missing static entrypoint: callback.html/,
    );
    await writeFile(
      path.join(project, "fhir-studio.json"),
      JSON.stringify(manifest),
    );
    await symlink("../package.json", path.join(project, "public/config.json"));
    await assert.rejects(packageExampleApp(project), /Symlinks/);
    await rm(path.join(project, "public/config.json"));
    await writeFile(
      path.join(project, "public/.env"),
      "SECRET=must-not-publish",
    );
    await assert.rejects(packageExampleApp(project), /unsafe static asset/);
    await rm(path.join(project, "public/.env"));
    await writeFile(path.join(project, "public/FHIR-STUDIO.json"), "{}");
    await assert.rejects(packageExampleApp(project), /Duplicate or reserved/);
  });
});

test("rejects traversal, symlinked static roots and symlinked package destinations", async () => {
  await fixture(async (project) => {
    await assert.rejects(
      packageExampleApp(project, "../outside"),
      /dedicated static directory/,
    );
    await symlink("public", path.join(project, "linked"));
    await assert.rejects(
      packageExampleApp(project, "linked"),
      /cannot be symlinks/,
    );
    await symlink("public", path.join(project, "dist"));
    await assert.rejects(
      packageExampleApp(project),
      /destination dist cannot be a symlink/,
    );
  });
});
