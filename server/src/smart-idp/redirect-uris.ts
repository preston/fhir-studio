import { readEnv } from '../env.js';

export function isRegisteredRedirectUri(
  redirectUri: string,
  registeredUris: unknown,
  uiBaseUrl: string,
  studioOrigin: string,
): boolean {
  if (!Array.isArray(registeredUris)) return false;

  const bases = new Set([uiBaseUrl, studioOrigin]);
  // Built-in applications use relative registrations and run on either Studio
  // or an explicitly configured development UI (for example, ng serve).
  if (process.env.NODE_ENV?.trim() !== 'production') {
    for (const value of (readEnv('FHIR_STUDIO_SERVER_CORS_ORIGINS') ?? '').split(',')) {
      const origin = value.trim();
      try {
        const url = new URL(origin);
        if (['http:', 'https:'].includes(url.protocol) && url.origin === origin && !url.hostname.includes('*')) bases.add(origin);
      } catch {
        // An invalid CORS entry cannot authorize a callback origin.
      }
    }
  }

  return registeredUris.some((uri: unknown) => {
    if (typeof uri !== 'string') return false;
    try {
      if (new URL(uri, uiBaseUrl).href === redirectUri) return true;
      return [...bases].some(base => {
        const callback = new URL(uri, base);
        return callback.origin === new URL(base).origin && callback.href === redirectUri;
      });
    } catch {
      return false;
    }
  });
}
