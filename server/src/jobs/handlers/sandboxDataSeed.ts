// Author: Preston Lee

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import axios from 'axios';
import type { JobHandler } from '../types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const BUNDLE_TIMEOUT_MS = 180_000;

interface PatientSeedDefinition {
  label: string;
  patientFileName: string;
}

const PATIENT_SEED_DEFS: PatientSeedDefinition[] = [
  { label: 'Pediatric', patientFileName: 'patient_1_pediatric.json' },
  { label: 'Young Adult', patientFileName: 'patient_2_young_adult.json' },
  { label: 'Chronic Adult', patientFileName: 'patient_3_chronic_adult.json' },
  { label: 'Geriatric', patientFileName: 'patient_4_geriatric.json' },
];

function resolveSeedDir(versionFolder: string): string {
  const candidates = [
    path.resolve(__dirname, '../../data/seed', versionFolder),
    path.resolve(__dirname, '../../../src/data/seed', versionFolder),
    path.resolve(process.cwd(), 'src/data/seed', versionFolder),
    path.resolve(process.cwd(), 'server/src/data/seed', versionFolder),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error(`Seed data directory not found for ${versionFolder}`);
}

async function postBundle(
  tenantUrl: string,
  bundle: unknown,
  label: string,
): Promise<void> {
  const response = await axios.post(tenantUrl, bundle, {
    headers: { 'Content-Type': 'application/fhir+json', Accept: 'application/fhir+json' },
    timeout: BUNDLE_TIMEOUT_MS,
    validateStatus: () => true,
  });

  if (response.status >= 200 && response.status < 300) {
    return;
  }

  const diagnostics =
    response.data?.issue?.map((i: { diagnostics?: string }) => i.diagnostics).filter(Boolean).join('; ') ||
    `HTTP ${response.status}`;
  throw new Error(`${label}: ${diagnostics}`);
}

export const sandboxDataSeedHandler: JobHandler = async (ctx) => {
  const input = (ctx.job.input as Record<string, any>) || {};
  const sandboxId = input.sandboxId || ctx.job.sandboxId;

  if (!sandboxId) {
    throw new Error('Sandbox ID is required for data seeding.');
  }

  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sandboxId);
  const sandbox = await ctx.prisma.sandbox.findFirst({
    where: isUuid ? { OR: [{ id: sandboxId }, { sandboxId }] } : { sandboxId },
  });

  if (!sandbox) {
    throw new Error(`Sandbox '${sandboxId}' not found.`);
  }

  const fhirVersion = (sandbox.fhirVersion || 'R4').toUpperCase();
  const versionFolder = fhirVersion === 'R5' ? 'r5' : 'r4';
  const seedDir = resolveSeedDir(versionFolder);
  const tenantUrl = `${ctx.hapiClient.getHapiBaseUrl(sandbox.fhirVersion)}/${sandbox.sandboxId}`;

  await ctx.updateProgress(10, `Preparing ${fhirVersion} synthetic seed data for sandbox '${sandbox.sandboxId}'...`);

  const dependenciesPath = path.join(seedDir, 'dependencies.json');
  if (!fs.existsSync(dependenciesPath)) {
    throw new Error(`Missing seed dependencies file: ${dependenciesPath}`);
  }

  await ctx.updateProgress(20, 'Importing Organizations, Locations, and Practitioners...');
  const dependenciesBundle = JSON.parse(fs.readFileSync(dependenciesPath, 'utf8'));
  await postBundle(tenantUrl, dependenciesBundle, 'dependencies.json');

  let totalResourcesSeeded = dependenciesBundle?.entry?.length || 0;
  let patientsSeeded = 0;
  const patientErrors: string[] = [];

  for (let idx = 0; idx < PATIENT_SEED_DEFS.length; idx++) {
    if (ctx.signal.aborted || (await ctx.isCancelled())) {
      throw new Error('Job was cancelled.');
    }

    const def = PATIENT_SEED_DEFS[idx];
    const patientFilePath = path.join(seedDir, def.patientFileName);
    if (!fs.existsSync(patientFilePath)) {
      console.warn(`Seed file missing: ${patientFilePath}`);
      continue;
    }

    const patientBundle = JSON.parse(fs.readFileSync(patientFilePath, 'utf8'));
    const entryCount = patientBundle?.entry?.length || 0;
    totalResourcesSeeded += entryCount;

    const percent = 30 + Math.round((idx / PATIENT_SEED_DEFS.length) * 65);
    await ctx.updateProgress(
      percent,
      `Seeding Patient ${idx + 1}/${PATIENT_SEED_DEFS.length}: ${def.label} (${entryCount} resources)...`,
    );

    try {
      await postBundle(tenantUrl, patientBundle, def.patientFileName);
      patientsSeeded += 1;
    } catch (err: any) {
      console.warn(`[DataSeed] ${err?.message || err}`);
      patientErrors.push(err?.message || String(err));
    }
  }

  if (patientsSeeded === 0 && patientErrors.length > 0) {
    throw new Error(`Patient seeding failed for all bundles. Sample errors: ${patientErrors.slice(0, 3).join(' | ')}`);
  }

  await ctx.updateProgress(100, `Data seeding completed. ${patientsSeeded} patient bundles imported successfully.`);

  return {
    sandboxId: sandbox.sandboxId,
    fhirVersion,
    totalResourcesSeeded,
    patientsSeeded,
    patientErrors: patientErrors.length > 0 ? patientErrors : undefined,
    seededAt: new Date().toISOString(),
  };
};
