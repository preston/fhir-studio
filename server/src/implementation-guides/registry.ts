// Author: Preston Lee

import {
  publicHttpUrl,
  PublicRequestError,
  requestPublicBuffer,
  requestPublicJson,
} from "../http/public-request.js";

export interface PackageTarballResult {
  buffer: Buffer;
  filename: string;
}

const MAX_PACKAGE_BYTES = 50 * 1024 * 1024;

function packageFilename(header: string | undefined, fallback: string): string {
  const match = header?.match(/filename\*?=(?:UTF-8'')?["']?([^"';]+)["']?/i);
  // Do not reflect response-controlled paths or control characters into HTTP headers.
  return (
    (match?.[1] ?? fallback).replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 200) ||
    "package.tgz"
  );
}

async function download(
  url: string,
  fallback: string,
): Promise<PackageTarballResult> {
  const response = await requestPublicBuffer(url, {
    maxBytes: MAX_PACKAGE_BYTES,
    timeoutMs: 60_000,
  });
  if (response.body[0] !== 0x1f || response.body[1] !== 0x8b) {
    throw new PublicRequestError(
      502,
      "Package source did not return a gzip archive.",
    );
  }
  return {
    buffer: response.body,
    filename: packageFilename(
      response.headers["content-disposition"],
      fallback,
    ),
  };
}

/** All package sources, registry metadata URLs, and redirects use pinned public HTTPS. */
export async function fetchPackageTarball(
  packageId: string,
  version?: string,
  customTarballUrl?: string | null,
): Promise<PackageTarballResult> {
  const cleanPkg = packageId.trim();
  const cleanVer = version?.trim() ?? "";
  const isSpecificVersion = Boolean(
    cleanVer && !["latest", "current", "*"].includes(cleanVer),
  );
  const fallback = `${cleanPkg}-${isSpecificVersion ? cleanVer : "latest"}.tgz`;
  if (customTarballUrl?.trim()) {
    // Explicit user input errors must not fall through to an unrelated registry source.
    publicHttpUrl(customTarballUrl.trim());
    return download(customTarballUrl.trim(), fallback);
  }
  const sources = [
    `https://packages2.fhir.org/packages/${encodeURIComponent(cleanPkg)}${isSpecificVersion ? "/" + encodeURIComponent(cleanVer) : ""}`,
    `https://packages.fhir.org/${encodeURIComponent(cleanPkg)}${isSpecificVersion ? "/" + encodeURIComponent(cleanVer) : ""}`,
  ];
  for (const url of sources) {
    try {
      return await download(url, fallback);
    } catch (error) {
      if (error instanceof PublicRequestError && error.status === 400)
        throw error;
    }
  }
  try {
    const metadata = await requestPublicJson(
      `https://packages.fhir.org/${encodeURIComponent(cleanPkg)}`,
      { timeoutMs: 15_000 },
    );
    if (metadata && typeof metadata === "object" && !Array.isArray(metadata)) {
      const meta = metadata as Record<string, unknown>;
      const versions =
        meta.versions &&
        typeof meta.versions === "object" &&
        !Array.isArray(meta.versions)
          ? (meta.versions as Record<string, unknown>)
          : {};
      const tags =
        meta["dist-tags"] && typeof meta["dist-tags"] === "object"
          ? (meta["dist-tags"] as Record<string, unknown>)
          : {};
      const target = isSpecificVersion
        ? cleanVer
        : typeof tags.latest === "string"
          ? tags.latest
          : Object.keys(versions).pop();
      const entry = target ? versions[target] : undefined;
      if (entry && typeof entry === "object") {
        const item = entry as Record<string, unknown>;
        const dist =
          item.dist && typeof item.dist === "object"
            ? (item.dist as Record<string, unknown>)
            : {};
        const url = dist.tarball ?? item.url;
        if (typeof url === "string") return await download(url, fallback);
      }
    }
  } catch (error) {
    if (error instanceof PublicRequestError && error.status === 400)
      throw error;
  }
  throw new PublicRequestError(
    502,
    `Unable to download FHIR package '${cleanPkg}${cleanVer ? "@" + cleanVer : ""}' from registry.`,
  );
}
