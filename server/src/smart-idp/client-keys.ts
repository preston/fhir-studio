import { lookup } from "node:dns/promises";
import https from "node:https";
import { isIP } from "node:net";

interface DownloadedKeys {
  keys: unknown;
  cacheControl?: string;
}
interface RegisteredKeys {
  jwks: unknown;
  jwksUri: string | null;
}

export function publicKeyAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a, b, c] = address.split(".").map(Number);
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)))) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113)
    );
  }
  // Global unicast only; exclude documentation and transition ranges that can tunnel private IPv4.
  return (
    isIP(address) === 6 &&
    /^[23][a-f0-9]{3}:/i.test(address) &&
    !/^2001:(?:0*:|0?db8:)/i.test(address) &&
    !/^2002:/i.test(address)
  );
}

export function keySetUrl(value: string): URL {
  const url = new URL(value);
  if (
    value.length > 2048 ||
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.hash ||
    (url.port && url.port !== "443") ||
    (!isIP(url.hostname) &&
      (!url.hostname.includes(".") || url.hostname.endsWith(".localhost")))
  )
    throw new Error(
      "Register a public HTTPS JWKS URL without credentials or a custom port.",
    );
  return url;
}

async function downloadKeys(value: string): Promise<DownloadedKeys> {
  const url = keySetUrl(value);
  const addresses = await lookup(url.hostname.replace(/^\[|\]$/g, ""), {
    all: true,
    verbatim: true,
  });
  if (
    !addresses.length ||
    addresses.some((item) => !publicKeyAddress(item.address))
  )
    throw new Error(
      "JWKS URLs must resolve only to public internet addresses.",
    );
  // Pin the validated addresses to the TLS request so DNS cannot change between validation and connection.
  return new Promise((resolve, reject) => {
    const request = https.get(
      url,
      {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(10000),
        lookup: (_hostname, options, callback) => {
          if (options.all) callback(null, addresses);
          else callback(null, addresses[0].address, addresses[0].family);
        },
      },
      (response) => {
        if (
          response.statusCode !== 200 ||
          Number(response.headers["content-length"] ?? 0) > 65536
        ) {
          response.destroy();
          reject(
            new Error(
              "The registered JWKS URL did not return a bounded successful response.",
            ),
          );
          return;
        }
        const chunks: Buffer[] = [];
        let length = 0;
        response.on("data", (chunk: Buffer) => {
          length += chunk.length;
          if (length > 65536)
            response.destroy(new Error("JWKS response exceeds 64 KiB."));
          else chunks.push(chunk);
        });
        response.on("error", reject);
        response.on("end", () => {
          try {
            resolve({
              keys: JSON.parse(
                Buffer.concat(chunks).toString("utf8"),
              ) as unknown,
              cacheControl: response.headers["cache-control"],
            });
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    request.on("error", reject);
  });
}

export class ClientKeyResolver {
  private readonly cache = new Map<
    string,
    { keys: unknown; expires: number }
  >();
  constructor(
    private readonly download: (
      url: string,
    ) => Promise<DownloadedKeys> = downloadKeys,
  ) {}

  async resolve(client: RegisteredKeys, assertion: string): Promise<unknown> {
    const header = JSON.parse(
      Buffer.from(assertion.split(".")[0], "base64url").toString(),
    ) as { jku?: unknown };
    if (header.jku !== undefined && header.jku !== client.jwksUri)
      throw new Error(
        "Client assertion jku must match the registered JWKS URL.",
      );
    if (!client.jwksUri || (client.jwks && header.jku === undefined))
      return client.jwks;
    keySetUrl(client.jwksUri);
    const cached = this.cache.get(client.jwksUri);
    if (cached && cached.expires > Date.now()) return cached.keys;
    const downloaded = await this.download(client.jwksUri);
    const keys = downloaded.keys;
    if (
      !keys ||
      typeof keys !== "object" ||
      !("keys" in keys) ||
      !Array.isArray(keys.keys) ||
      keys.keys.length > 50
    )
      throw new Error(
        "The registered JWKS URL must return a bounded JSON Web Key Set.",
      );
    const control = downloaded.cacheControl ?? "";
    const maxAge = /\bmax-age\s*=\s*"?(\d+)/i.exec(control)?.[1];
    const seconds = /\bno-store\b|\bno-cache\b/i.test(control)
      ? 0
      : Math.min(300, Number(maxAge ?? 60));
    if (this.cache.size >= 256)
      this.cache.delete(this.cache.keys().next().value!);
    this.cache.set(client.jwksUri, {
      keys,
      expires: Date.now() + seconds * 1000,
    });
    return keys;
  }
}
