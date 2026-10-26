import assert from "node:assert/strict";
import { test, mock } from "node:test";
import dns from "node:dns/promises";
import https from "node:https";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { syncBuiltinESMExports } from "node:module";
import type { IncomingMessage, RequestOptions } from "node:http";
import type {
  Request as ExpressRequest,
  Response as ExpressResponse,
} from "express";
import {
  publicAddress,
  publicHttpUrl,
  requestPublicBuffer,
  requestPublicJson,
} from "../src/http/public-request.js";
import { fetchPackageTarball } from "../src/implementation-guides/registry.js";
import { createImplementationGuidesRouter } from "../src/implementation-guides/routes.js";
import { disconnectPrisma } from "../src/db/prisma.js";
import { createDefaultEffectivePermissions } from "@fhir-studio/core";

interface Reply {
  status?: number;
  headers?: Record<string, string>;
  body?: Buffer | string;
}
function transport(
  replies: Reply[],
  resolve: (host: string) => string[] = () => ["1.1.1.1"],
) {
  const requests: { url: URL; options: RequestOptions; body?: unknown }[] = [];
  mock.method(dns, "lookup", async (host: string) =>
    resolve(host).map((address) => ({
      address,
      family: address.includes(":") ? 6 : 4,
    })),
  );
  mock.method(https, "request", ((
    url: URL,
    options: RequestOptions,
    callback: (response: IncomingMessage) => void,
  ) => {
    const reply = replies.shift();
    assert.ok(reply, `Unexpected network request: ${url}`);
    const call = { url, options, body: undefined as unknown };
    requests.push(call);
    const request = new EventEmitter();
    Object.assign(request, {
      end(body: unknown) {
        call.body = body;
        const response = Object.assign(Readable.from([reply.body ?? "{}"]), {
          statusCode: reply.status ?? 200,
          headers: reply.headers ?? {},
        });
        queueMicrotask(() => callback(response as IncomingMessage));
      },
    });
    return request;
  }) as unknown as typeof https.request);
  syncBuiltinESMExports();
  return requests;
}
function restore() {
  mock.restoreAll();
  syncBuiltinESMExports();
}

test("public requests reject loopback, private, reserved, mapped and transition destinations", () => {
  for (const address of [
    "127.0.0.1",
    "10.0.0.1",
    "169.254.169.254",
    "172.16.0.1",
    "192.168.0.1",
    "100.64.0.1",
    "198.18.0.1",
    "192.0.2.1",
    "::1",
    "::ffff:127.0.0.1",
    "fc00::1",
    "fe80::1",
    "2001:db8::1",
    "2002:7f00:1::1",
    "2001::1",
  ])
    assert.equal(publicAddress(address), false, address);
  for (const address of ["1.1.1.1", "8.8.8.8", "2606:4700:4700::1111"])
    assert.equal(publicAddress(address), true, address);
  for (const url of [
    "http://public.example.org",
    "https://127.1",
    "https://2130706433",
    "https://[::1]",
    "https://[::ffff:127.0.0.1]",
    "https://local.internal",
    "https://localhost",
    "https://foo.local",
    "https://user:pass@public.example.org",
    "https://public.example.org:8443",
  ])
    assert.throws(() => publicHttpUrl(url), /public HTTPS/);
});

test("DNS resolution rejects any private answer before opening a connection", async () => {
  const calls = transport([], () => ["1.1.1.1", "127.0.0.1"]);
  try {
    await assert.rejects(
      requestPublicBuffer("https://public.example.org/archive.tgz"),
      /public internet/,
    );
    assert.equal(calls.length, 0);
  } finally {
    restore();
  }
});

test("HTTPS connection pins the validated address and preserves the original TLS hostname", async () => {
  const calls = transport([{ body: '{"ok":true}' }]);
  try {
    assert.deepEqual(
      await requestPublicJson("https://public.example.org/data"),
      { ok: true },
    );
    assert.equal(calls[0].url.hostname, "public.example.org");
    assert.equal(calls[0].options.agent, false);
    const lookup = calls[0].options.lookup!;
    lookup("public.example.org", { family: 4 }, (error, address, family) => {
      assert.equal(error, null);
      assert.equal(address, "1.1.1.1");
      assert.equal(family, 4);
    });
  } finally {
    restore();
  }
});

test("every redirect is checked again, including redirect DNS, and POST bodies never redirect", async () => {
  let calls = transport([
    { status: 302, headers: { location: "https://127.0.0.1/admin" } },
  ]);
  try {
    await assert.rejects(
      requestPublicBuffer("https://public.example.org/data"),
      /public HTTPS/,
    );
    assert.equal(calls.length, 1);
  } finally {
    restore();
  }
  calls = transport(
    [
      {
        status: 302,
        headers: { location: "https://redirect.example.org/private" },
      },
    ],
    (host) => (host.startsWith("redirect") ? ["10.0.0.1"] : ["1.1.1.1"]),
  );
  try {
    await assert.rejects(
      requestPublicBuffer("https://public.example.org/data"),
      /public internet/,
    );
    assert.equal(calls.length, 1);
  } finally {
    restore();
  }
  calls = transport([
    { status: 307, headers: { location: "https://public.example.org/other" } },
  ]);
  try {
    await assert.rejects(
      requestPublicJson("https://public.example.org/data", {
        method: "POST",
        body: { secret: "sentinel" },
        followRedirects: false,
      }),
      /redirects/,
    );
    assert.equal(calls.length, 1);
  } finally {
    restore();
  }
});

test("response bytes are bounded and subscription content type is preserved", async () => {
  let calls = transport([{ body: "oversized" }]);
  try {
    await assert.rejects(
      requestPublicBuffer("https://public.example.org/data", { maxBytes: 3 }),
      /download limit/,
    );
  } finally {
    restore();
  }
  calls = transport([{ status: 204, body: "" }]);
  try {
    await requestPublicBuffer("https://public.example.org/events", {
      method: "POST",
      body: { event: "test" },
      headers: { "Content-Type": "application/fhir+json" },
    });
    assert.equal(
      (calls[0].options.headers as Record<string, string>)["Content-Type"],
      "application/fhir+json",
    );
  } finally {
    restore();
  }
});

test("package downloads reject internal URLs and non-archives while permitting bounded public gzip bytes", async () => {
  let calls = transport([]);
  try {
    await assert.rejects(
      fetchPackageTarball("probe", "1", "https://127.0.0.1/private"),
      /public HTTPS/,
    );
    assert.equal(calls.length, 0);
  } finally {
    restore();
  }
  transport([{ body: "private service sentinel" }]);
  try {
    await assert.rejects(
      fetchPackageTarball("probe", "1", "https://public.example.org/archive"),
      /gzip archive/,
    );
  } finally {
    restore();
  }
  const body = Buffer.from([0x1f, 0x8b, 1, 2]);
  transport([
    {
      body,
      headers: {
        "content-disposition": 'attachment; filename="../unsafe\r\nfile.tgz"',
      },
    },
  ]);
  try {
    const result = await fetchPackageTarball(
      "probe",
      "1",
      "https://public.example.org/archive",
    );
    assert.deepEqual(result.buffer, body);
    assert.doesNotMatch(result.filename, /[\r\n/\\]/);
  } finally {
    restore();
  }
});

test("registry routes require authenticated package-import permission before any outbound work", async () => {
  const saved = process.env.FHIR_STUDIO_SERVER_DATABASE_URL;
  process.env.FHIR_STUDIO_SERVER_DATABASE_URL =
    "postgresql://unused:unused@127.0.0.1:1/unused";
  try {
    const router = createImplementationGuidesRouter();
    const guard = router.stack[0].handle;
    let status = 0,
      next = false;
    const response = {
      status(value: number) {
        status = value;
        return this;
      },
      json() {
        return this;
      },
    } as ExpressResponse;
    guard({} as ExpressRequest, response, () => {
      next = true;
    });
    assert.equal(status, 401);
    assert.equal(next, false);
    guard(
      {
        sessionAuth: { userId: "sentinel" },
        effectivePermissions: {
          ...createDefaultEffectivePermissions(),
          package_import: false,
        },
      } as ExpressRequest,
      response,
      () => {
        next = true;
      },
    );
    assert.equal(status, 403);
    assert.equal(next, false);
    guard(
      {
        sessionAuth: { userId: "sentinel" },
        effectivePermissions: createDefaultEffectivePermissions(),
      } as ExpressRequest,
      response,
      () => {
        next = true;
      },
    );
    assert.equal(next, true);
  } finally {
    if (saved === undefined) delete process.env.FHIR_STUDIO_SERVER_DATABASE_URL;
    else process.env.FHIR_STUDIO_SERVER_DATABASE_URL = saved;
    await disconnectPrisma();
  }
});
