import axios from "axios";
import { createHash } from "node:crypto";
import type { Request, Response } from "express";
import type { Sandbox } from "@prisma/client";
import { HapiPartitionClient } from "../hapi/partition_client.js";
import { HostingError } from "../hosted/access.js";

interface Patient {
  resourceType: string;
  id?: string;
  name?: Array<{ text?: string; given?: string[]; family?: string }>;
  birthDate?: string;
}

// Match the UI's Bootswatch Materia palette and card treatment without loading
// the Angular bundle or external assets during authorization.
const styles = `
  * { box-sizing: border-box; }
  body {
    margin: 0;
    background: #f8f9fa;
    color: #212529;
    font: 1rem/1.5 Roboto, -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
  }
  .app-header { background: #2196f3; color: #fff; box-shadow: 0 2px 4px #00000014; }
  .header-content {
    max-width: 76rem;
    margin: auto;
    padding: 1rem 1.5rem;
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: .25rem 1.5rem;
  }
  .brand { font-size: 1.25rem; font-weight: 700; letter-spacing: .5px; }
  .header-caption { font-size: .875rem; }
  main { max-width: 48rem; margin: 3rem auto; padding: 0 1.5rem; }
  .card { background: #fff; border-radius: 6px; box-shadow: 0 2px 4px #00000014; overflow: hidden; }
  .card-body { padding: 2rem; }
  h1 { margin: 0 0 .5rem; font-size: 1.75rem; line-height: 1.25; font-weight: 500; }
  p { margin: 0; }
  .muted { color: #626970; }
  .sandbox {
    display: inline-block;
    max-width: 100%;
    margin-bottom: 1.25rem;
    padding: .25rem .625rem;
    background: #e3f2fd;
    color: #1565c0;
    border-radius: 4px;
    font-size: .875rem;
    overflow-wrap: anywhere;
  }
  .search-form { margin-top: 1.5rem; }
  label { display: block; margin-bottom: .5rem; font-weight: 600; }
  .search-controls { display: flex; gap: .75rem; }
  input, button { font: inherit; }
  input[type="search"] {
    width: 100%;
    min-width: 0;
    padding: .625rem .75rem;
    color: inherit;
    background: #fff;
    border: 1px solid #adb5bd;
    border-radius: 4px;
  }
  button, a { -webkit-tap-highlight-color: transparent; }
  button { cursor: pointer; }
  .search-button {
    padding: .625rem 1.25rem;
    border: 1px solid #1976d2;
    border-radius: 4px;
    background: #1976d2;
    color: #fff;
    font-weight: 500;
    box-shadow: 0 2px 4px #00000014;
  }
  .search-button:hover { background: #1565c0; }
  input:focus-visible, button:focus-visible, a:focus-visible {
    outline: 3px solid #1565c0;
    outline-offset: 3px;
  }
  .search-help { margin-top: .5rem; font-size: .875rem; }
  a { color: #1565c0; text-underline-offset: .15em; }
  .results-header { display: flex; justify-content: space-between; flex-wrap: wrap; gap: .5rem; margin: 1.75rem 0 .75rem; }
  h2 { margin: 0; font-size: 1rem; font-weight: 600; }
  .results-header a { font-size: .875rem; }
  .patient-list { list-style: none; margin: 0; padding: 0; }
  .patient-list li + li { margin-top: .625rem; }
  .patient-choice {
    display: flex;
    align-items: center;
    gap: 1rem;
    width: 100%;
    padding: 1rem;
    text-align: left;
    color: inherit;
    background: #fff;
    border: 1px solid #dee2e6;
    border-radius: 6px;
  }
  .patient-choice:hover { border-color: #2196f3; background: #f2f8fd; }
  .patient-avatar {
    display: grid;
    place-items: center;
    flex: 0 0 2.5rem;
    height: 2.5rem;
    border-radius: 50%;
    background: #e3f2fd;
    color: #1565c0;
    font-weight: 600;
  }
  .patient-details { flex: 1; min-width: 0; overflow-wrap: anywhere; }
  .patient-name { display: block; font-weight: 600; }
  .patient-meta { display: block; margin-top: .125rem; font-size: .875rem; color: #626970; }
  .select-label { flex-shrink: 0; color: #1565c0; font-size: .875rem; font-weight: 600; }
  .results-help { margin-top: .875rem; font-size: .875rem; }
  .empty-state { padding: 2rem 1.25rem; text-align: center; border: 1px dashed #ced4da; border-radius: 6px; }
  .empty-state p + p { margin-top: .375rem; }
  .card-footer { padding: 1rem 2rem; background: #f8f9fa; border-top: 1px solid #eee; font-size: .875rem; color: #626970; }
  @media (max-width: 480px) {
    main { margin: 1.5rem auto; padding: 0 1rem; }
    .card-body { padding: 1.25rem; }
    .card-footer { padding: 1rem 1.25rem; }
    .search-controls { flex-direction: column; }
    .patient-choice { gap: .75rem; padding: .875rem; }
    .patient-avatar { display: none; }
  }
`;
const styleHash = createHash("sha256").update(styles).digest("base64");
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
      return `<li>
        <button class="patient-choice" type="submit" name="patient" value="${escape(patient.id!)}">
          <span class="patient-avatar" aria-hidden="true">${escape(Array.from(label)[0].toUpperCase())}</span>
          <span class="patient-details">
            <span class="patient-name">${escape(label)}</span>
            <span class="patient-meta">Patient ID: ${escape(patient.id!)}${patient.birthDate ? ` &middot; Born ${escape(patient.birthDate)}` : ""}</span>
          </span>
          <span class="select-label" aria-hidden="true">Select &rarr;</span>
        </button>
      </li>`;
    })
    .join("");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader(
    "Content-Security-Policy",
    `default-src 'none'; style-src 'sha256-${styleHash}'; frame-ancestors 'self'; base-uri 'none'; form-action 'self'`,
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
    <style>${styles}</style>
  </head>
  <body>
    <header class="app-header">
      <div class="header-content">
        <span class="brand">FHIR Studio</span>
        <span class="header-caption">Application launch</span>
      </div>
    </header>
    <main>
      <section class="card" aria-labelledby="page-title">
        <div class="card-body">
          <span class="sandbox">Sandbox: ${escape(sandbox.name)}</span>
          <h1 id="page-title">Select a patient</h1>
          <p class="muted">Choose the patient record to use in your application.</p>
          <form class="search-form" method="get" action="/oauth/authorize" role="search" aria-label="Find a patient">
            ${hidden}
            <label for="patient-search">Patient name</label>
            <div class="search-controls">
              <input type="search" id="patient-search" name="patient_search" value="${escape(search)}" maxlength="200" placeholder="Search by name" aria-describedby="search-help" autocomplete="off">
              <button class="search-button" type="submit">Search</button>
            </div>
            <p class="search-help muted" id="search-help">Search by given or family name to narrow the list.</p>
          </form>
          <div class="results-header">
            <h2>${search ? "Search results" : "Available patients"}</h2>
            ${search ? `<a href="${escape(clearSearchUrl)}">Clear search</a>` : ""}
          </div>
          ${
            patients.length
              ? `
          <form method="get" action="/oauth/authorize" aria-label="Select a patient">
            ${hidden}
            <ul class="patient-list">${choices}</ul>
          </form>
          <p class="results-help muted">Showing ${patients.length === 20 ? "up to 20 patients. Search by name for more specific results." : `${patients.length} ${patients.length === 1 ? "patient" : "patients"}. Select a patient to continue.`}</p>`
              : `
          <div class="empty-state" role="status">
            <p><strong>${search ? "No matching patients" : "No patients available"}</strong></p>
            <p class="muted">${search ? "Try a different name or clear your search to see available patients." : "Add a patient to this sandbox, then return here to continue."}</p>
          </div>`
          }
        </div>
        <footer class="card-footer">Your application will open with the selected patient as its context.</footer>
      </section>
    </main>
  </body>
</html>`,
  );
  return null;
}
