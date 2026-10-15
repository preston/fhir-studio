// Author: Preston Lee

/**
 * Normalize an Express 5 route param to a single string.
 *
 * `@types/express-serve-static-core` ≥5.1.2 types `ParamsDictionary` values as
 * `string | string[]` (named wildcards are arrays). Handlers that annotate
 * `req: Request` lose path-based inference and hit that union; this helper
 * recovers a single string for ordinary `:param` segments.
 */
export function routeParam(value: string | string[] | undefined): string {
  if (Array.isArray(value)) {
    return value[0] ?? '';
  }
  return value ?? '';
}
