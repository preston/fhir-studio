/** Express has already decoded the route once. Never let an HTTP client decode it again. */
export function isSafeFhirPath(path: string): boolean {
  // A negated character class also rejects trailing newlines ($ anchors would accept one).
  if (/[^A-Za-z0-9._$*/-]/.test(path)) return false;
  return path.split('/').every(segment => segment !== '.' && segment !== '..');
}

export function isUnsafeHapiOperationPath(path: string): boolean {
  return path.split('/').some(segment => segment.toLowerCase().startsWith('$partition-management-') ||
    ['$expunge', '$delete-expunge'].includes(segment.toLowerCase()));
}

/** A batch entry must stay under the outer request's tenant, including nested bundles. */
export function isSafeFhirBundle(value: unknown, depth = 0): boolean {
  if (!value || typeof value !== 'object' || depth > 10) return false;
  const bundle = value as { entry?: unknown };
  if (!Array.isArray(bundle.entry)) return false;
  return bundle.entry.every((entry: unknown) => {
    if (!entry || typeof entry !== 'object') return false;
    const item = entry as { request?: { url?: unknown; method?: unknown }; resource?: { resourceType?: string; type?: string } };
    const url = item.request?.url;
    if (typeof url !== 'string' || !url || url.length > 8192 || url.startsWith('/') || url.includes('#')) return false;
    const path = url.split('?')[0];
    const parts = path.split('/');
    if (!isSafeFhirPath(path) || parts.some(part => !part) || isUnsafeHapiOperationPath(path) ||
        !/^[A-Z][A-Za-z0-9]+$/.test(parts[0]) ||
        !['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(String(item.request?.method).toUpperCase())) return false;
    if (item.resource?.resourceType && !parts.some(part => part.startsWith('$')) && item.resource.resourceType !== parts[0]) return false;
    if (item.resource?.resourceType === 'Bundle' && ['batch', 'transaction'].includes(item.resource.type ?? ''))
      return isSafeFhirBundle(item.resource, depth + 1);
    return true;
  });
}

/** CDS prefetch is a relative FHIR read/search, never another tenant or an operation. */
export function prefetchPath(value: string): string {
  if (!value || value.length > 4096 || value.startsWith('/'))
    throw new Error('Prefetch templates must be relative FHIR resource queries.');
  const separator = value.indexOf('?');
  const rawPath = separator < 0 ? value : value.slice(0, separator);
  const path = decodeURIComponent(rawPath);
  if (!isSafeFhirPath(path) || !/^[A-Z][A-Za-z0-9]+(?:\/|$)/.test(path) ||
      path.split('/').some(segment => !segment || segment.startsWith('$')))
    throw new Error('Prefetch templates must stay within this sandbox.');
  const query = separator < 0 ? '' : `?${new URLSearchParams(value.slice(separator + 1))}`;
  return `${path}${query}`;
}
