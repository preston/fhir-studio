import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { getPrisma } from '../db/prisma.js';
import type { OidcBffConfig } from '../auth/sso_config.js';
import { loadHostingConfig } from '../hosted/config.js';
import { isHostingEnabled } from '../env.js';

export function controlPlaneAuthentication(
  authentication: RequestHandler,
): RequestHandler {
  return (req, res, next) => {
    if (res.locals.smartBrowserOrigin) {
      delete req.headers.cookie;
      req.cookies = {};
      req.signedCookies = {};
      delete req.sessionAuth;
      delete req.effectivePermissions;
      next();
      return;
    }
    return authentication(req, res, next);
  };
}

export function browserSecurity(config: OidcBffConfig) {
  const hosting = isHostingEnabled() ? loadHostingConfig() : null;
  const studioOrigins = new Set([
    ...config.corsOrigins,
    new URL(config.redirectUrl).origin,
    new URL(config.uiBaseUrl).origin,
  ]);
  if (config.nodeEnv === 'production' && hosting) {
    if (
      [config.redirectUrl, config.uiBaseUrl].some(
        (value) => new URL(value).origin !== hosting.studioOrigin,
      )
    )
      throw new Error(
        'Production hosting requires the SSO callback and UI base URL on HOSTING_STUDIO_ORIGIN.',
      );
    for (const origin of studioOrigins) {
      const parsed = new URL(origin);
      if (
        parsed.protocol !== 'https:' ||
        parsed.origin !== origin ||
        parsed.hostname === hosting.domain ||
        parsed.hostname.endsWith(`.${hosting.domain}`)
      )
        throw new Error(
          'Management CORS origins must be exact HTTPS origins outside the hosted application sub-zone.',
        );
    }
  }
  return async (
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> => {
    const origin = req.get('origin');
    const dataPath =
      /\/fhir\//.test(req.path) ||
      req.path === '/oauth/token' ||
      req.path === '/oauth/revoke' ||
      req.path.includes('/.well-known/') ||
      req.path === '/oauth/jwks.json';
    if (origin && !studioOrigins.has(origin)) {
      if (!dataPath) {
        res.status(403).json({ error: 'Untrusted browser origin.' });
        return;
      }
      const registrations = await getPrisma().application.findMany({
        select: { launchUri: true, redirectUris: true },
      });
      const approved = registrations.some((client) =>
        [
          client.launchUri,
          ...(Array.isArray(client.redirectUris) ? client.redirectUris : []),
        ].some((uri) => {
          try {
            return typeof uri === 'string' && new URL(uri).origin === origin;
          } catch {
            return false;
          }
        }),
      );
      if (!approved) {
        res.status(403).json({ error: 'Unregistered SMART origin.' });
        return;
      }
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.vary('Origin');
    } else if (origin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.vary('Origin');
    }
    if (
      !['GET', 'HEAD', 'OPTIONS'].includes(req.method) &&
      !dataPath &&
      !origin &&
      req.get('cookie')
    ) {
      const referer = req.get('referer');
      let trusted = false;
      try {
        trusted = !!referer && studioOrigins.has(new URL(referer).origin);
      } catch {
        /* reject */
      }
      if (!trusted) {
        res.status(403).json({ error: 'CSRF origin verification failed.' });
        return;
      }
    }
    if (req.method === 'OPTIONS') {
      res.setHeader(
        'Access-Control-Allow-Methods',
        'GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS',
      );
      res.setHeader(
        'Access-Control-Allow-Headers',
        'Content-Type,Authorization,Prefer,If-Match,If-None-Match,If-None-Exist,If-Modified-Since,If-Unmodified-Since',
      );
      res.sendStatus(204);
      return;
    }
    if (origin) {
      res.setHeader('Access-Control-Expose-Headers', 'Location,Content-Location,ETag,Last-Modified,Preference-Applied,Retry-After');
    }
    if (origin && !studioOrigins.has(origin)) {
      res.locals.smartBrowserOrigin = true;
    }
    // Subresource GETs and navigations can omit Origin. SameSite cookies alone do
    // not separate a hosted subdomain from Studio. Never borrow its session.
    if (!origin && dataPath) {
      let trustedReferer = false;
      try {
        trustedReferer = studioOrigins.has(
          new URL(req.get('referer') || '').origin,
        );
      } catch {
        /* absent */
      }
      if (
        !trustedReferer &&
        ['same-site', 'cross-site'].includes(req.get('sec-fetch-site') || '')
      )
        res.locals.smartBrowserOrigin = true;
    }
    next();
  };
}
