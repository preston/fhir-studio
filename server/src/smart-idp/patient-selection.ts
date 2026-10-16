import axios from "axios";
import type { Request, Response } from "express";
import type { Sandbox } from "@prisma/client";
import { HapiPartitionClient } from "../hapi/partition_client.js";
import { HostingError } from "../hosted/access.js";

interface Patient {
  resourceType: string;
  id?: string;
  name?: Array<{ text?: string; given?: string[]; family?: string }>;
}
const escape = (value: string): string =>
  value.replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        character
      ]!,
  );
const validId = (value: string): boolean => /^[A-Za-z0-9.-]{1,64}$/.test(value);

/** Patient context is selected on the authorization server, within an authorized sandbox. */
export async function standalonePatient(
  req: Request,
  res: Response,
  sandbox: Sandbox,
): Promise<string | null> {
  const base = `${new HapiPartitionClient().getHapiBaseUrl(sandbox.fhirVersion)}/${encodeURIComponent(sandbox.sandboxId)}/Patient`;
  const selected = req.query.patient;
  if (selected !== undefined) {
    if (typeof selected !== "string" || !validId(selected))
      throw new HostingError(400, "Choose a valid patient from this sandbox.");
    const response = await axios.get<Patient>(
      `${base}/${encodeURIComponent(selected)}`,
      {
        timeout: 10000,
        validateStatus: (status) => status === 200 || status === 404,
      },
    );
    if (
      response.status !== 200 ||
      response.data.resourceType !== "Patient" ||
      response.data.id !== selected
    )
      throw new HostingError(
        400,
        "The selected patient is not available in this sandbox.",
      );
    return selected;
  }
  const search =
    typeof req.query.patient_search === "string"
      ? req.query.patient_search.slice(0, 200)
      : "";
  const response = await axios.get<{ entry?: Array<{ resource?: Patient }> }>(
    base,
    {
      params: { _count: 20, ...(search ? { name: search } : {}) },
      timeout: 10000,
    },
  );
  const patients = (response.data.entry ?? []).flatMap((entry) => {
    const patient = entry.resource;
    return patient?.resourceType === "Patient" &&
      patient.id &&
      validId(patient.id)
      ? [patient]
      : [];
  });
  const hidden = Object.entries(req.query)
    .filter(
      ([key, value]) =>
        key !== "patient" &&
        key !== "patient_search" &&
        typeof value === "string",
    )
    .map(
      ([key, value]) =>
        `<input type="hidden" name="${escape(key)}" value="${escape(String(value))}">`,
    )
    .join("");
  const choices = patients
    .map((patient) => {
      const name = patient.name?.[0];
      const label =
        name?.text ||
        [...(name?.given ?? []), name?.family].filter(Boolean).join(" ") ||
        patient.id!;
      return `<li><button name="patient" value="${escape(patient.id!)}">${escape(label)} (${escape(patient.id!)})</button></li>`;
    })
    .join("");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'none'; frame-ancestors 'self'; base-uri 'none'; form-action 'self'",
  );
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res
    .type("html")
    .send(
      `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Select a patient</title></head><body><main><h1>Select a patient</h1><p>Choose the patient this application may access in ${escape(sandbox.name)}.</p><form method="get" action="/oauth/authorize">${hidden}<label>Patient name <input name="patient_search" value="${escape(search)}" maxlength="200"></label><button>Search</button><ul>${choices}</ul>${patients.length ? "<p>Showing up to 20 patients. Search by name to narrow the results.</p>" : "<p>No patients found. Search again or add a patient to this sandbox.</p>"}</form></main></body></html>`,
    );
  return null;
}
