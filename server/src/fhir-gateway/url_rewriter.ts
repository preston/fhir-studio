// Author: Preston Lee

/**
 * Rewrites URLs inside FHIR JSON resources (such as Bundle links, entries, fullUrls)
 * and response headers (such as Location, Content-Location) from HAPI partition URL to
 * the external FHIR Studio proxy gateway URL.
 */
export function rewriteFhirPayload(
  data: any,
  hapiBaseUrl: string,
  proxyBaseUrl: string,
): any {
  if (!data) return data;

  if (typeof data === 'string') {
    if (data.startsWith(hapiBaseUrl)) {
      return data.replace(hapiBaseUrl, proxyBaseUrl);
    }
    return data;
  }

  if (Array.isArray(data)) {
    return data.map((item) => rewriteFhirPayload(item, hapiBaseUrl, proxyBaseUrl));
  }

  if (typeof data === 'object') {
    const output: Record<string, any> = {};
    for (const [key, value] of Object.entries(data)) {
      output[key] = rewriteFhirPayload(value, hapiBaseUrl, proxyBaseUrl);
    }
    return output;
  }

  return data;
}

export function rewriteHeaderUrl(
  headerVal: string | undefined,
  hapiBaseUrl: string,
  proxyBaseUrl: string,
): string | undefined {
  if (!headerVal) return headerVal;
  return headerVal.replace(hapiBaseUrl, proxyBaseUrl);
}
