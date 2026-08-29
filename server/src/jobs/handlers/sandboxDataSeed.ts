// Author: Preston Lee

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import axios from 'axios';
import type { JobHandler } from '../types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

interface ScenarioDefinition {
  title: string;
  description: string;
  patientFileName: string;
  intent?: string;
}

const SCENARIO_DEFS: ScenarioDefinition[] = [
  {
    title: 'Pediatric Wellness & Asthma Review',
    description: '11-year-old female patient with childhood asthma management, immunizations, and routine pediatric clinical follow-ups.',
    patientFileName: 'patient_1_pediatric.json',
    intent: 'routine-care',
  },
  {
    title: 'Acute Encounter & Clinical Triage',
    description: '35-year-old male with acute injury/wrist subluxation, triage evaluation, and outpatient clinical care.',
    patientFileName: 'patient_2_young_adult.json',
    intent: 'urgent-care',
  },
  {
    title: 'Chronic Disease Management (Hypertension & SDOH)',
    description: '41-year-old male presenting with essential hypertension, stress management, and SDOH housing evaluation.',
    patientFileName: 'patient_3_chronic_adult.json',
    intent: 'chronic-care',
  },
  {
    title: 'Geriatric Multi-Morbidity & Pain Management',
    description: '63-year-old senior patient presenting with chronic pain, obesity, and longitudinal clinical encounters.',
    patientFileName: 'patient_4_geriatric.json',
    intent: 'geriatric-care',
  },
];

export const sandboxDataSeedHandler: JobHandler = async (ctx) => {
  const input = (ctx.job.input as Record<string, any>) || {};
  const { sandboxId: inputSandboxId } = input;
  const sandboxId = inputSandboxId || ctx.job.sandboxId;

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
  
  let seedDir = path.resolve(__dirname, '../../data/seed', versionFolder);
  if (!fs.existsSync(seedDir)) {
    seedDir = path.resolve(__dirname, '../../../src/data/seed', versionFolder);
  }
  if (!fs.existsSync(seedDir)) {
    seedDir = path.resolve(process.cwd(), 'src/data/seed', versionFolder);
  }
  if (!fs.existsSync(seedDir)) {
    seedDir = path.resolve(process.cwd(), 'server/src/data/seed', versionFolder);
  }

  if (!fs.existsSync(seedDir)) {
    throw new Error(`Seed data directory not found: ${seedDir}`);
  }

  await ctx.updateProgress(10, `Preparing ${fhirVersion} synthetic seed data for sandbox '${sandbox.sandboxId}'...`);

  const hapiBaseUrl = ctx.hapiClient.getHapiBaseUrl(sandbox.fhirVersion);
  const tenantUrl = `${hapiBaseUrl}/${sandbox.sandboxId}`;

  // 1. Submit Hospital and Practitioner dependencies
  const hospitalPath = path.join(seedDir, 'hospital_information.json');
  const practitionerPath = path.join(seedDir, 'practitioner_information.json');

  if (fs.existsSync(hospitalPath)) {
    try {
      const hospitalBundle = JSON.parse(fs.readFileSync(hospitalPath, 'utf8'));
      await axios.post(tenantUrl, hospitalBundle, {
        headers: { 'Content-Type': 'application/fhir+json' },
        timeout: 45_000,
      });
    } catch (err: any) {
      console.warn(`[DataSeed] Hospital dependency bundle warning:`, err?.response?.data || err?.message);
    }
  }

  if (fs.existsSync(practitionerPath)) {
    try {
      const practitionerBundle = JSON.parse(fs.readFileSync(practitionerPath, 'utf8'));
      await axios.post(tenantUrl, practitionerBundle, {
        headers: { 'Content-Type': 'application/fhir+json' },
        timeout: 45_000,
      });
    } catch (err: any) {
      console.warn(`[DataSeed] Practitioner dependency bundle warning:`, err?.response?.data || err?.message);
    }
  }

  if (ctx.signal.aborted || (await ctx.isCancelled())) {
    throw new Error('Job was cancelled.');
  }

  // 2. Lookup Example Application to link launch scenarios
  const exampleApp = await ctx.prisma.application.findFirst({
    where: {
      OR: [
        { clientId: 'example-application' },
        { clientId: 'example-app' },
      ],
    },
  });

  const createdScenarios: any[] = [];
  let totalResourcesSeeded = 0;

  // 3. Process each of the 4 patient files
  for (let idx = 0; idx < SCENARIO_DEFS.length; idx++) {
    if (ctx.signal.aborted || (await ctx.isCancelled())) {
      throw new Error('Job was cancelled.');
    }

    const def = SCENARIO_DEFS[idx];
    const patientFilePath = path.join(seedDir, def.patientFileName);

    if (!fs.existsSync(patientFilePath)) {
      console.warn(`Seed file missing: ${patientFilePath}`);
      continue;
    }

    const patientBundle = JSON.parse(fs.readFileSync(patientFilePath, 'utf8'));
    const entryCount = patientBundle?.entry?.length || 0;
    totalResourcesSeeded += entryCount;

    const currentPercent = 20 + Math.round((idx / SCENARIO_DEFS.length) * 60);
    await ctx.updateProgress(
      currentPercent,
      `Seeding Patient ${idx + 1}/${SCENARIO_DEFS.length}: ${def.title} (${entryCount} resources)...`,
    );

    // Submit patient transaction bundle to HAPI
    try {
      await axios.post(tenantUrl, patientBundle, {
        headers: { 'Content-Type': 'application/fhir+json' },
        timeout: 60_000,
      });
    } catch (err: any) {
      console.warn(`[DataSeed] Patient bundle warning on ${def.patientFileName}:`, err?.response?.data || err?.message);
    }

    // Extract Patient Resource details
    const patientResource = patientBundle.entry?.find(
      (e: any) => e.resource?.resourceType === 'Patient',
    )?.resource;

    const patientFhirId = patientResource?.id || `patient-${idx + 1}`;
    const nameObj = patientResource?.name?.[0];
    const given = nameObj?.given?.join(' ') || '';
    const family = nameObj?.family || '';
    const patientName = `${given} ${family}`.trim() || `Patient #${patientFhirId}`;

    // Extract primary Encounter
    const encounterResource = patientBundle.entry?.find(
      (e: any) => e.resource?.resourceType === 'Encounter',
    )?.resource;
    const encounterFhirId = encounterResource?.id || null;

    // Create LaunchScenario record in Prisma
    const scenario = await ctx.prisma.launchScenario.create({
      data: {
        sandboxId: sandbox.id,
        title: def.title,
        description: def.description,
        applicationId: exampleApp ? exampleApp.id : null,
        patientFhirId,
        patientName,
        encounterFhirId,
        intent: def.intent || null,
        needPatientBanner: true,
        createdByUserId: ctx.job.createdByUserId || null,
      },
    });

    createdScenarios.push({
      scenarioId: scenario.id,
      title: scenario.title,
      patientFhirId,
      patientName,
      encounterFhirId,
    });
  }

  await ctx.updateProgress(100, `Data seeding completed. 4 launch scenarios created successfully.`);

  return {
    sandboxId: sandbox.sandboxId,
    fhirVersion,
    totalResourcesSeeded,
    scenariosCreated: createdScenarios.length,
    scenarios: createdScenarios,
    seededAt: new Date().toISOString(),
  };
};
