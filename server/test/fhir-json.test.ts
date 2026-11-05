import assert from "node:assert/strict";
import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { test } from "node:test";
import express, {
  type Request,
  type Response,
  type NextFunction,
} from "express";
import { jsonBodyParser } from "../src/http/json-body.js";

/** Feed real request bytes through production parsing without opening a socket. */
async function parse(
  contentType: string,
  payload: string,
): Promise<{ status: number; body: unknown }> {
  const app = express();
  app.use(jsonBodyParser());
  app.post("/resource", (req, res) => res.json({ resource: req.body ?? null }));
  app.use(
    (_error: unknown, _req: Request, res: Response, _next: NextFunction) =>
      res.sendStatus(400),
  );
  const req = new IncomingMessage(new Socket()) as Request;
  req.method = "POST";
  req.url = "/resource";
  req.headers = {
    "content-type": contentType,
    "content-length": String(Buffer.byteLength(payload)),
  };
  const result = new Promise<{ status: number; body: unknown }>(
    (resolve, reject) => {
      const res = new ServerResponse(req);
      Object.assign(res, {
        end(chunk?: string | Buffer) {
          let body: unknown = String(chunk ?? "");
          try {
            body = JSON.parse(String(chunk)) as unknown;
          } catch {
            /* Non-JSON error response. */
          }
          resolve({ status: res.statusCode, body });
          return res;
        },
      });
      app.handle(req, res, reject);
    },
  );
  req.push(Buffer.from(payload));
  req.push(null);
  return result;
}

test("production JSON parser accepts real FHIR JSON bodies and existing management JSON", async () => {
  const resource = {
    resourceType: "Observation",
    status: "final",
    subject: { reference: "Patient/p1" },
    code: { text: "Temperature" },
  };
  for (const contentType of [
    "application/fhir+json",
    "application/fhir+json; charset=utf-8",
    "application/json",
  ]) {
    assert.deepEqual(await parse(contentType, JSON.stringify(resource)), {
      status: 200,
      body: { resource },
    });
  }
});

test("production JSON parser rejects malformed FHIR bodies and leaves non-JSON payloads alone", async () => {
  assert.equal((await parse("application/fhir+json", "{invalid")).status, 400);
  assert.deepEqual(await parse("text/plain", "not JSON"), {
    status: 200,
    body: { resource: null },
  });
});
