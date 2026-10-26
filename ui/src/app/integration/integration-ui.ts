// Author: Preston Lee

export const integrationScopeLabels: Readonly<Record<string, string>> = {
  "account:read": "Identify your FHIR Studio account",
  "sandbox:read": "List sandbox metadata you may manage",
  "applications:read": "View applications created through this integration",
  "applications:write":
    "Install and manage applications created through this integration",
  "applications:publish":
    "Publish reviewed applications and enable them in your sandboxes",
  "projects:create": "Create editable projects in repositories you authorize",
};

/** Keep account switching in the authorization flow without carrying clinical context. */
export function integrationSignInUrl(
  path: string,
  search: string,
  switchAccount = false,
): string {
  const safePath = [
    "/integration/authorize",
    "/integration/handoff",
    "/handoff",
  ].includes(path)
    ? path
    : "/";
  const params = new URLSearchParams({ returnTo: safePath + search });
  if (switchAccount) params.set("prompt", "select_account");
  return `/sso/login?${params.toString()}`;
}

export function verifiedLauncherPath(
  value: string,
  origin: string,
): string | null {
  try {
    const url = new URL(value, origin);
    return url.origin === origin &&
      url.pathname === "/applications/hosted" &&
      !url.username &&
      !url.password
      ? url.pathname + url.search
      : null;
  } catch {
    return null;
  }
}
