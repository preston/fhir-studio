import axios from "axios";
import type { Request, Response } from "express";
import type { Sandbox } from "@prisma/client";
import { HapiPartitionClient } from "../hapi/partition_client.js";
import { HostingError } from "../hosted/access.js";
import { requireEnv } from "../env.js";

interface Patient {
  resourceType: string;
  id?: string;
  name?: Array<{ text?: string; given?: string[]; family?: string }>;
  birthDate?: string;
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
  const authorizationParams = Object.entries(req.query)
    .filter(
      ([key, value]) =>
        key !== "patient" &&
        key !== "patient_search" &&
        typeof value === "string",
    )
    .map(([key, value]) => [key, String(value)] as [string, string]);
  const hidden = authorizationParams
    .map(
      ([key, value]) =>
        `<input type="hidden" name="${escape(key)}" value="${escape(String(value))}">`,
    )
    .join("");
  const clearSearchUrl = `/oauth/authorize?${new URLSearchParams(authorizationParams)}`;
  const choices = patients
    .map((patient) => {
      const name = patient.name?.[0];
      const label =
        name?.text ||
        [...(name?.given ?? []), name?.family].filter(Boolean).join(" ") ||
        patient.id!;
      return `<button class="list-group-item list-group-item-action d-flex align-items-center gap-3 p-3" type="submit" name="patient" value="${escape(patient.id!)}">
          <span class="badge rounded-circle bg-primary-subtle text-primary-emphasis p-3 d-none d-sm-block" aria-hidden="true">${escape(Array.from(label)[0].toUpperCase())}</span>
          <span class="flex-grow-1 overflow-hidden text-break">
            <span class="d-block fw-semibold">${escape(label)}</span>
            <span class="d-block small text-body-secondary mt-1">Patient ID: ${escape(patient.id!)}${patient.birthDate ? ` &middot; Born ${escape(patient.birthDate)}` : ""}</span>
          </span>
          <span class="flex-shrink-0 text-primary small fw-semibold" aria-hidden="true">Select &rarr;</span>
        </button>`;
    })
    .join("");
  // The UI builds these same theme sources into a stable, non-injected stylesheet.
  const uiBaseUrl = requireEnv(
    "FHIR_STUDIO_SERVER_UI_BASE_URL",
    "UI_BASE_URL",
  ).replace(/\/+$/, "");
  const uiOrigin = new URL(uiBaseUrl).origin;
  const themeUrl = `${uiBaseUrl}/studio-theme.css`;
  res.setHeader("Cache-Control", "no-store");
  res.setHeader(
    "Content-Security-Policy",
    `default-src 'none'; style-src ${uiOrigin} https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src ${uiOrigin}; frame-ancestors 'self'; base-uri 'none'; form-action 'self'`,
  );
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.type("html").send(
    `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Select a patient | FHIR Studio</title>
    <link rel="stylesheet" href="${escape(themeUrl)}">
  </head>
  <body class="bg-light text-dark">
    <header class="navbar navbar-dark bg-primary shadow-sm mb-4">
      <div class="container-fluid px-4 py-2 gap-2">
        <span class="navbar-brand d-flex align-items-center gap-2 fw-bold mb-0">
          <img src="${escape(uiBaseUrl)}/assets/icons/icon-fhir-32.png" alt="" width="24" height="24">
          FHIR Studio
        </span>
        <span class="navbar-text text-white small">Application launch</span>
      </div>
    </header>
    <main class="container py-4">
      <div class="row justify-content-center">
        <div class="col-lg-8 col-xl-7">
          <section class="card border-0 rounded-2 shadow-sm" aria-labelledby="page-title">
            <div class="card-body p-4">
              <span class="badge bg-primary-subtle text-primary-emphasis fw-normal text-wrap text-break mb-3">Sandbox: ${escape(sandbox.name)}</span>
              <h1 class="h3 mb-2" id="page-title">Select a patient</h1>
              <p class="text-body-secondary mb-0">Choose the patient record to use in your application.</p>
              <form class="mt-4" method="get" action="/oauth/authorize" role="search" aria-label="Find a patient">
                ${hidden}
                <label class="form-label" for="patient-search">Patient name</label>
                <div class="d-flex flex-column flex-sm-row gap-2">
                  <input class="form-control" type="search" id="patient-search" name="patient_search" value="${escape(search)}" maxlength="200" placeholder="Search by name" aria-describedby="search-help" autocomplete="off">
                  <button class="btn btn-primary" type="submit">Search</button>
                </div>
                <p class="form-text mb-0" id="search-help">Search by given or family name to narrow the list.</p>
              </form>
              <div class="d-flex justify-content-between align-items-center flex-wrap gap-2 mt-4 mb-3">
                <h2 class="h6 mb-0">${search ? "Search results" : "Available patients"}</h2>
                ${search ? `<a class="small" href="${escape(clearSearchUrl)}">Clear search</a>` : ""}
              </div>
              ${
                patients.length
                  ? `
              <form method="get" action="/oauth/authorize" aria-label="Select a patient">
                ${hidden}
                <div class="list-group">${choices}</div>
              </form>
              <p class="small text-body-secondary mt-3 mb-0">Showing ${patients.length === 20 ? "up to 20 patients. Search by name for more specific results." : `${patients.length} ${patients.length === 1 ? "patient" : "patients"}. Select a patient to continue.`}</p>`
                  : `
              <div class="border rounded-2 p-4 text-center" role="status">
                <p class="fw-semibold mb-2">${search ? "No matching patients" : "No patients available"}</p>
                <p class="text-body-secondary mb-0">${search ? "Try a different name or clear your search to see available patients." : "Add a patient to this sandbox, then return here to continue."}</p>
              </div>`
              }
            </div>
            <footer class="card-footer bg-light text-body-secondary small px-4 py-3">Your application will open with the selected patient as its context.</footer>
          </section>
        </div>
      </div>
    </main>
  </body>
</html>`,
  );
  return null;
}
