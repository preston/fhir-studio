import { lookup } from "node:dns/promises";
import type { LookupAddress } from "node:dns";
import https from "node:https";
import { isIP } from "node:net";
import type { IncomingHttpHeaders } from "node:http";

export class PublicRequestError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "PublicRequestError";
  }
}

/** Only globally routed addresses may receive user-configured outbound requests. */
export function publicAddress(address: string): boolean {
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
      (a === 192 && b === 88 && c === 99) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113)
    );
  }
  if (isIP(address) !== 6 || !/^[23][a-f\d]{3}:/i.test(address)) return false;
  const [first, second = "0"] = address.split(":");
  // Exclude special-use 2001::/23, documentation, and IPv4 transition tunnels.
  return (
    first.toLowerCase() !== "2002" &&
    first.toLowerCase() !== "3fff" &&
    !(
      first.toLowerCase() === "2001" &&
      (parseInt(second || "0", 16) <= 0x1ff || parseInt(second, 16) === 0xdb8)
    )
  );
}

export function publicHttpUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new PublicRequestError(400, "Provide a public HTTPS URL.");
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (
    value.length > 8192 ||
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.hash ||
    (url.port && url.port !== "443") ||
    (isIP(hostname)
      ? !publicAddress(hostname)
      : !hostname.includes(".") ||
        hostname.endsWith(".") ||
        /\.(?:localhost|local|internal|test|invalid)$/.test(hostname))
  ) {
    throw new PublicRequestError(
      400,
      "Provide a public HTTPS URL without credentials, fragments, or a custom port.",
    );
  }
  return url;
}

export interface PublicRequestOptions {
  method?: "GET" | "POST";
  body?: unknown;
  headers?: Record<string, string>;
  maxBytes?: number;
  timeoutMs?: number;
  followRedirects?: boolean;
}

export interface PublicBufferResponse {
  body: Buffer;
  headers: IncomingHttpHeaders;
  status: number;
  url: string;
}

export async function requestPublicBuffer(
  value: string,
  options: PublicRequestOptions = {},
): Promise<PublicBufferResponse> {
  let target = publicHttpUrl(value);
  const method = options.method ?? "GET";
  const maxBytes = options.maxBytes ?? 1024 * 1024;
  const signal = AbortSignal.timeout(options.timeoutMs ?? 10_000);
  const payload =
    options.body === undefined
      ? undefined
      : Buffer.from(JSON.stringify(options.body));
  for (let hop = 0; hop < 6; hop++) {
    signal.throwIfAborted();
    target = publicHttpUrl(target.href);
    const hostname = target.hostname.replace(/^\[|\]$/g, "");
    const addresses = await new Promise<LookupAddress[]>((resolve, reject) => {
      const aborted = () => reject(signal.reason);
      signal.addEventListener("abort", aborted, { once: true });
      lookup(hostname, { all: true, verbatim: true })
        .then(resolve, reject)
        .finally(() => {
          signal.removeEventListener("abort", aborted);
        });
    });
    signal.throwIfAborted();
    if (
      !addresses.length ||
      addresses.some(({ address }) => !publicAddress(address))
    ) {
      throw new PublicRequestError(
        400,
        "Outbound URL must resolve only to public internet addresses.",
      );
    }
    const selected = addresses[0]!;
    const response = await new Promise<import("node:http").IncomingMessage>(
      (resolve, reject) => {
        const request = https.request(
          target,
          {
            method,
            signal,
            family: selected.family,
            agent: false,
            headers: {
              Accept: "application/json",
              "Accept-Encoding": "identity",
              ...(payload ? { "Content-Type": "application/json" } : {}),
              ...options.headers,
              ...(payload ? { "Content-Length": String(payload.length) } : {}),
            },
            // Pin validated DNS answers to this connection; never consult a proxy or resolve again.
            lookup: (_hostname, lookupOptions, callback) => {
              if (lookupOptions.all) callback(null, [selected]);
              else callback(null, selected.address, selected.family);
            },
          },
          resolve,
        );
        request.once("error", reject);
        request.end(payload);
      },
    );
    const status = response.statusCode ?? 502;
    if ([301, 302, 303, 307, 308].includes(status)) {
      response.destroy();
      if (
        method !== "GET" ||
        options.followRedirects === false ||
        !response.headers.location
      ) {
        throw new PublicRequestError(
          502,
          "Outbound redirects are not permitted for this request.",
        );
      }
      // No caller credentials or payload are forwarded to a different origin.
      if (
        options.headers &&
        new URL(response.headers.location, target).origin !== target.origin
      ) {
        throw new PublicRequestError(
          502,
          "Credentialed outbound requests cannot redirect to another origin.",
        );
      }
      target = publicHttpUrl(new URL(response.headers.location, target).href);
      continue;
    }
    if (
      status < 200 ||
      status >= 300 ||
      Number(response.headers["content-length"] ?? 0) > maxBytes
    ) {
      response.destroy();
      throw new PublicRequestError(
        status === 404 ? 404 : 502,
        "Outbound service did not return a bounded successful response.",
      );
    }
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of response) {
      const buffer = Buffer.isBuffer(chunk)
        ? chunk
        : Buffer.from(chunk as Uint8Array);
      bytes += buffer.length;
      if (bytes > maxBytes) {
        response.destroy();
        throw new PublicRequestError(
          413,
          "Outbound response exceeds the download limit.",
        );
      }
      chunks.push(buffer);
    }
    return {
      body: Buffer.concat(chunks),
      headers: response.headers,
      status,
      url: target.href,
    };
  }
  throw new PublicRequestError(
    502,
    "Outbound service exceeded the redirect limit.",
  );
}

export async function requestPublicJson(
  value: string,
  options: PublicRequestOptions = {},
): Promise<unknown> {
  const response = await requestPublicBuffer(value, options);
  if (!response.body.length) return null;
  try {
    return JSON.parse(response.body.toString("utf8")) as unknown;
  } catch {
    throw new PublicRequestError(
      502,
      "Outbound service returned invalid JSON.",
    );
  }
}
