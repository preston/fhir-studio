#!/usr/bin/env node

import {
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { crc32, deflateRawSync } from "node:zlib";

const MANIFEST = "fhir-studio.json";
const MAX_FILES = 1_000;
const MAX_EXPANDED_BYTES = 50 * 1024 * 1024;
const MAX_ARCHIVE_BYTES = 20 * 1024 * 1024;
const extensions = new Set([
  ".html",
  ".css",
  ".js",
  ".mjs",
  ".json",
  ".map",
  ".txt",
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".ico",
  ".svg",
  ".woff",
  ".woff2",
  ".ttf",
]);

/** @param {string} value */
function assetPath(value) {
  const parts = value.split("/");
  if (
    !value ||
    value.startsWith("/") ||
    /[\\:\u0000-\u001f]/.test(value) ||
    parts.some((part) => !part || part.startsWith(".")) ||
    parts[0] === "_studio" ||
    !extensions.has(path.posix.extname(value).toLowerCase())
  ) {
    throw new Error(`Unsupported or unsafe static asset: ${value}`);
  }
  return value;
}

/** @param {unknown} value @returns {Record<string, unknown>} */
function record(value) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Expected a JSON object.");
  return /** @type {Record<string, unknown>} */ (value);
}

/** @param {unknown} value */
function validateManifest(value) {
  const manifest = record(value);
  if (
    manifest.formatVersion !== 1 ||
    typeof manifest.name !== "string" ||
    !manifest.name.trim() ||
    manifest.name.length > 200 ||
    typeof manifest.description !== "string" ||
    Object.keys(manifest).some(
      (key) =>
        !["formatVersion", "name", "description", "runtime_contract"].includes(
          key,
        ),
    )
  ) {
    throw new Error(
      `${MANIFEST} requires formatVersion 1, name, description, and runtime_contract.`,
    );
  }
  const contract = record(manifest.runtime_contract);
  if (
    contract.kind !== "static-smart" ||
    contract.version !== 1 ||
    contract.authentication !== "studio-smart" ||
    contract.pkce !== "S256"
  ) {
    throw new Error(
      "The runtime contract requires static-smart v1, studio-smart authentication, and PKCE S256.",
    );
  }
  if (
    typeof contract.launch_path !== "string" ||
    !/\.html$/i.test(assetPath(contract.launch_path)) ||
    !Array.isArray(contract.callback_paths) ||
    !contract.callback_paths.length ||
    !contract.callback_paths.every(
      (value) => typeof value === "string" && /\.html$/i.test(assetPath(value)),
    )
  ) {
    throw new Error(
      "Launch and callback paths must identify actual relative HTML files.",
    );
  }
  if (
    !Array.isArray(contract.scopes) ||
    !contract.scopes.length ||
    !contract.scopes.every(
      (value) =>
        typeof value === "string" &&
        value.length > 0 &&
        !/[\s\u0000-\u0020\u007f]/.test(value) &&
        !value.startsWith("system/") &&
        !value.includes("?") &&
        !value.includes("offline_access"),
    )
  ) {
    throw new Error(
      "The runtime contract requires supported SMART public-client scopes.",
    );
  }
  for (const [field, allowed] of [
    ["fhir_versions", ["R4", "R4B", "R5"]],
    ["launch_requirements", ["standalone", "ehr", "patient", "encounter"]],
  ]) {
    const values = contract[field];
    if (
      !Array.isArray(values) ||
      !values.length ||
      !values.every((value) => allowed.includes(value))
    ) {
      throw new Error(`The runtime contract requires supported ${field}.`);
    }
  }
  if (
    !Array.isArray(contract.public_configuration) ||
    !Array.isArray(contract.dependencies) ||
    contract.dependencies.some(
      (dependency) => record(dependency).required !== false,
    )
  ) {
    throw new Error(
      "Declare public_configuration and dependencies; required external dependencies cannot be hosted.",
    );
  }
  const supported = [
    "kind",
    "version",
    "authentication",
    "pkce",
    "launch_path",
    "callback_paths",
    "scopes",
    "fhir_versions",
    "launch_requirements",
    "public_configuration",
    "dependencies",
  ];
  if (Object.keys(contract).some((key) => !supported.includes(key)))
    throw new Error("Unsupported runtime contract field.");
  return {
    manifest,
    entrypoints: [
      contract.launch_path,
      .../** @type {string[]} */ (contract.callback_paths),
    ],
  };
}

/** Reject symlinks in a selected directory and every component below its project root.
 * @param {string} project @param {string} directory */
async function staticDirectory(project, directory) {
  if (
    !directory ||
    path.isAbsolute(directory) ||
    directory.includes("\\") ||
    directory
      .split("/")
      .some(
        (part) =>
          !part || part === "." || part === ".." || part.startsWith("."),
      )
  ) {
    throw new Error(
      "Use a dedicated static directory relative to the project, such as public, dist, or dist/app/browser.",
    );
  }
  let current = project;
  for (const part of ["", ...directory.split("/")]) {
    current = path.join(current, part);
    const info = await lstat(current);
    if (info.isSymbolicLink() || !info.isDirectory())
      throw new Error(`Static directories cannot be symlinks: ${current}`);
  }
  return current;
}

/** @param {Map<string, Buffer>} files */
function zip(files) {
  /** @type {Buffer[]} */
  const local = [];
  /** @type {Buffer[]} */
  const central = [];
  let offset = 0;
  for (const [name, data] of files) {
    const filename = Buffer.from(name, "utf8");
    const compressed = deflateRawSync(data, { level: 9 });
    const checksum = crc32(data);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x0800, 6);
    header.writeUInt16LE(8, 8);
    header.writeUInt16LE(33, 12); // 1980-01-01: reproducible ZIP metadata.
    header.writeUInt32LE(checksum, 14);
    header.writeUInt32LE(compressed.length, 18);
    header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(filename.length, 26);
    local.push(header, filename, compressed);

    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(0x0314, 4);
    header.copy(entry, 6, 4, 30);
    entry.writeUInt32LE(0x81a40000, 38); // Ordinary Unix file, mode 0644.
    entry.writeUInt32LE(offset, 42);
    central.push(entry, filename);
    offset += header.length + filename.length + compressed.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.size, 8);
  end.writeUInt16LE(files.size, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}

/** Build a portable archive without running project code or adding source configuration.
 * @param {string} projectPath @param {string | undefined} outputOverride */
export async function packageExampleApp(projectPath, outputOverride) {
  const project = path.resolve(projectPath);
  const packageInfo = record(
    JSON.parse(await readFile(path.join(project, "package.json"), "utf8")),
  );
  const config =
    outputOverride === undefined ? record(packageInfo.fhirStudio) : {};
  const directory = outputOverride ?? config.staticDirectory;
  if (typeof directory !== "string")
    throw new Error(
      "Set package.json fhirStudio.staticDirectory or supply a static directory argument.",
    );
  const root = await staticDirectory(project, directory);
  const { manifest, entrypoints } = validateManifest(
    JSON.parse(await readFile(path.join(project, MANIFEST), "utf8")),
  );
  const slug = path.basename(project);
  if (!/^[a-z0-9][a-z0-9-]*$/.test(slug))
    throw new Error(
      "Use a project folder with lowercase letters, numbers, and hyphens.",
    );
  const output = path.join(project, "dist", `${slug}.zip`);
  const files = new Map([
    [MANIFEST, Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`)],
  ]);
  const seen = new Set([MANIFEST]);
  let expanded = files.get(MANIFEST)?.length ?? 0;
  /** @param {string} relative */
  async function visit(relative) {
    const entries = await readdir(path.join(root, relative), {
      withFileTypes: true,
    });
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      const full = path.join(root, name);
      if (full === output) continue;
      if (entry.isSymbolicLink())
        throw new Error(`Symlinks cannot be packaged: ${name}`);
      if (entry.isDirectory()) {
        if (
          entry.name.startsWith(".") ||
          (!relative && entry.name === "_studio")
        )
          throw new Error(`Unsafe static directory: ${name}`);
        await visit(name);
        continue;
      }
      if (!entry.isFile())
        throw new Error(`Only ordinary static files can be packaged: ${name}`);
      assetPath(name);
      const normalized = name.toLowerCase();
      if (seen.has(normalized))
        throw new Error(`Duplicate or reserved asset path: ${name}`);
      seen.add(normalized);
      const info = await lstat(full);
      if (!info.isFile() || info.isSymbolicLink())
        throw new Error(`Static asset changed while packaging: ${name}`);
      expanded += info.size;
      if (expanded > MAX_EXPANDED_BYTES || files.size >= MAX_FILES)
        throw new Error(
          "Static output exceeds the default hosting size or file-count limits.",
        );
      files.set(name, await readFile(full));
    }
  }
  await visit("");
  for (const entry of entrypoints)
    if (!files.has(entry))
      throw new Error(`Missing static entrypoint: ${entry}`);
  const archive = zip(files);
  if (archive.length > MAX_ARCHIVE_BYTES)
    throw new Error("ZIP exceeds the default 20 MB hosting archive limit.");
  const dist = path.dirname(output);
  await mkdir(dist, { recursive: true });
  const distInfo = await lstat(dist);
  if (distInfo.isSymbolicLink() || !distInfo.isDirectory())
    throw new Error("The package destination dist cannot be a symlink.");
  const temporary = `${output}.${process.pid}.tmp`;
  try {
    await writeFile(temporary, archive, { flag: "wx", mode: 0o644 });
    await rename(temporary, output);
  } finally {
    await rm(temporary, { force: true });
  }
  return { output, files: files.size, bytes: archive.length };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  const [project, directory, ...extra] = process.argv.slice(2);
  if (!project || extra.length) {
    console.error(
      "Usage: node scripts/package-example-app.mjs <project> [static-output-directory]",
    );
    process.exitCode = 1;
  } else {
    try {
      const result = await packageExampleApp(project, directory);
      console.log(
        `Packaged ${result.files} files (${result.bytes} bytes): ${result.output}`,
      );
    } catch (error) {
      console.error(
        error instanceof Error ? error.message : "Packaging failed.",
      );
      process.exitCode = 1;
    }
  }
}
