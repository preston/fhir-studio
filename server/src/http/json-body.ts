import express, { type RequestHandler } from "express";

/** FHIR clients send the FHIR JSON media type; management APIs use ordinary JSON. */
export function jsonBodyParser(): RequestHandler {
  return express.json({
    limit: "50mb",
    type: ["application/json", "application/fhir+json"],
  });
}
