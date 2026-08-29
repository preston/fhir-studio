// Author: Preston Lee

import axios from 'axios';

export interface PackageTarballResult {
  buffer: Buffer;
  filename: string;
}

/**
 * Extracts a filename from the Content-Disposition header, or returns a fallback.
 */
function getFilenameFromContentDisposition(header?: string, fallback = 'package.tgz'): string {
  if (!header) return fallback;
  const match = header.match(/filename\*?=(?:UTF-8'')?["']?([^"';]+)["']?/i);
  return match && match[1] ? match[1].trim() : fallback;
}

/**
 * Downloads a FHIR NPM package (.tgz) from upstream registries or a custom URL.
 * Handles fallbacks between packages2.fhir.org, packages.fhir.org direct, and registry metadata manifests.
 */
export async function fetchPackageTarball(
  packageId: string,
  version?: string,
  customTarballUrl?: string | null,
): Promise<PackageTarballResult> {
  const cleanPkg = packageId.trim();
  const cleanVer = version ? version.trim() : '';
  const isSpecificVersion = Boolean(
    cleanVer && cleanVer !== 'latest' && cleanVer !== 'current' && cleanVer !== '*',
  );
  const fallbackFilename = `${cleanPkg}-${isSpecificVersion ? cleanVer : 'latest'}.tgz`;

  // 1. If explicit custom URL is provided, try downloading from it first
  if (customTarballUrl && customTarballUrl.trim()) {
    try {
      const resp = await axios.get(customTarballUrl.trim(), {
        responseType: 'arraybuffer',
        timeout: 60_000,
        maxRedirects: 10,
      });
      if (resp.status === 200 && resp.data?.length > 0) {
        const filename = getFilenameFromContentDisposition(
          resp.headers['content-disposition'],
          fallbackFilename,
        );
        return { buffer: Buffer.from(resp.data), filename };
      }
    } catch (err: any) {
      console.warn(`Custom tarballUrl (${customTarballUrl}) failed:`, err?.message);
    }
  }

  // 2. Try packages2.fhir.org
  const p2Url = isSpecificVersion
    ? `https://packages2.fhir.org/packages/${encodeURIComponent(cleanPkg)}/${encodeURIComponent(cleanVer)}`
    : `https://packages2.fhir.org/packages/${encodeURIComponent(cleanPkg)}`;

  try {
    const resp = await axios.get(p2Url, {
      responseType: 'arraybuffer',
      timeout: 60_000,
      maxRedirects: 10,
      headers: { Accept: 'application/tar+gzip, application/octet-stream, */*' },
    });
    if (resp.status === 200 && resp.data?.length > 0) {
      const filename = getFilenameFromContentDisposition(
        resp.headers['content-disposition'],
        fallbackFilename,
      );
      return { buffer: Buffer.from(resp.data), filename };
    }
  } catch (err: any) {
    console.warn(`packages2.fhir.org download failed for ${cleanPkg}#${cleanVer || 'latest'}:`, err?.message);
  }

  // 3. Try packages.fhir.org direct endpoint
  const p1Url = isSpecificVersion
    ? `https://packages.fhir.org/${encodeURIComponent(cleanPkg)}/${encodeURIComponent(cleanVer)}`
    : `https://packages.fhir.org/${encodeURIComponent(cleanPkg)}`;

  try {
    const resp = await axios.get(p1Url, {
      responseType: 'arraybuffer',
      timeout: 60_000,
      maxRedirects: 10,
      headers: { Accept: 'application/tar+gzip, application/octet-stream, */*' },
    });
    // Check if response is actually a tarball/gzip (or at least non-empty and not an HTML/JSON error)
    if (resp.status === 200 && resp.data?.length > 0) {
      const contentType = String(resp.headers['content-type'] || '');
      if (contentType.includes('gzip') || contentType.includes('octet-stream') || resp.data.length > 512) {
        const filename = getFilenameFromContentDisposition(
          resp.headers['content-disposition'],
          fallbackFilename,
        );
        return { buffer: Buffer.from(resp.data), filename };
      }
    }
  } catch (err: any) {
    console.warn(`packages.fhir.org direct download failed for ${cleanPkg}#${cleanVer || 'latest'}:`, err?.message);
  }

  // 4. Query packages.fhir.org package metadata for tarball location
  try {
    const metaResp = await axios.get(`https://packages.fhir.org/${encodeURIComponent(cleanPkg)}`, {
      timeout: 15_000,
      headers: { Accept: 'application/json' },
    });
    const meta = metaResp.data;
    if (meta && typeof meta === 'object') {
      const targetVer = isSpecificVersion
        ? cleanVer
        : meta['dist-tags']?.latest || Object.keys(meta.versions || {}).pop();

      const verObj = targetVer && meta.versions ? meta.versions[targetVer] : undefined;
      const tarballUrl = verObj?.dist?.tarball || verObj?.url;

      if (tarballUrl && tarballUrl !== p1Url && tarballUrl !== p2Url) {
        const resp = await axios.get(tarballUrl, {
          responseType: 'arraybuffer',
          timeout: 60_000,
          maxRedirects: 10,
        });
        if (resp.status === 200 && resp.data?.length > 0) {
          const filename = getFilenameFromContentDisposition(
            resp.headers['content-disposition'],
            `${cleanPkg}-${targetVer || 'latest'}.tgz`,
          );
          return { buffer: Buffer.from(resp.data), filename };
        }
      }
    }
  } catch (err: any) {
    console.warn(`packages.fhir.org metadata inspection failed for ${cleanPkg}:`, err?.message);
  }

  throw new Error(`Unable to download FHIR package '${cleanPkg}${cleanVer ? '@' + cleanVer : ''}' from registry.`);
}
