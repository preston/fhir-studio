import { isSupportedFhirRelease } from '@fhir-studio/core';

// Stock HAPI JPA supports these patient reference searches, but does not expose
// /Patient/:id/:resourceType compartment search routes. Keep this list explicit:
// an unknown search parameter can be ignored by HAPI and must never grant access.
const COMMON_PATIENT_SEARCH_TYPES = new Set([
  'Account', 'AllergyIntolerance', 'Appointment', 'AppointmentResponse', 'AuditEvent',
  'Basic', 'BodyStructure', 'CarePlan', 'CareTeam', 'ChargeItem', 'Claim', 'ClaimResponse',
  'ClinicalImpression', 'Communication', 'CommunicationRequest', 'Composition',
  'Condition', 'Consent', 'Contract', 'Coverage', 'CoverageEligibilityRequest',
  'CoverageEligibilityResponse', 'DetectedIssue', 'DeviceRequest', 'DiagnosticReport',
  'DocumentReference', 'Encounter', 'EnrollmentRequest', 'EpisodeOfCare',
  'ExplanationOfBenefit', 'FamilyMemberHistory', 'Flag', 'Goal', 'GuidanceResponse',
  'ImagingStudy', 'Immunization', 'ImmunizationEvaluation', 'ImmunizationRecommendation',
  'Invoice', 'List', 'MeasureReport', 'MedicationAdministration', 'MedicationDispense',
  'MedicationRequest', 'MedicationStatement', 'MolecularSequence', 'NutritionOrder',
  'Observation', 'Person', 'Procedure', 'Provenance', 'QuestionnaireResponse',
  'RelatedPerson', 'ResearchSubject', 'RiskAssessment', 'ServiceRequest', 'Specimen',
  'SupplyDelivery', 'Task', 'VisionPrescription',
]);

const R4_PATIENT_SEARCH_TYPES = new Set([
  'Device', 'DeviceUseStatement', 'DocumentManifest', 'Media', 'RequestGroup',
]);

const R5_PATIENT_SEARCH_TYPES = new Set([
  'AdverseEvent', 'BiologicallyDerivedProductDispense', 'DeviceAssociation',
  'DeviceDispense', 'DeviceUsage', 'EncounterHistory', 'GenomicStudy', 'ImagingSelection',
  'NutritionIntake', 'RequestOrchestration', 'SupplyRequest',
]);

/** Return a server-controlled search constraint, or deny unsupported resource types. */
export function patientSearchConstraint(
  release: string,
  resourceType: string,
  patientId: string,
): Record<string, string> | undefined {
  if (!isSupportedFhirRelease(release)) return undefined;
  if (resourceType === 'Patient') return { _id: patientId };
  if (resourceType === 'AdverseEvent' && release !== 'R5') {
    return { subject: `Patient/${patientId}` };
  }
  const releaseTypes = release === 'R5' ? R5_PATIENT_SEARCH_TYPES : R4_PATIENT_SEARCH_TYPES;
  if (!COMMON_PATIENT_SEARCH_TYPES.has(resourceType) && !releaseTypes.has(resourceType)) {
    return undefined;
  }
  return { patient: `Patient/${patientId}` };
}

// A patient search parameter does not imply a `patient` or `subject` property.
// Write support is explicit so an invented property cannot authorize a resource
// whose real compartment association points to somebody else.
const PATIENT_WRITE_FIELDS: Readonly<Record<string, string>> = {
  AllergyIntolerance: 'patient',
  CarePlan: 'subject',
  Claim: 'patient',
  ClinicalImpression: 'subject',
  Communication: 'subject',
  Condition: 'subject',
  Coverage: 'beneficiary',
  DiagnosticReport: 'subject',
  DocumentReference: 'subject',
  Encounter: 'subject',
  ExplanationOfBenefit: 'patient',
  ImagingStudy: 'subject',
  Immunization: 'patient',
  MeasureReport: 'subject',
  MedicationRequest: 'subject',
  Observation: 'subject',
  QuestionnaireResponse: 'subject',
  ServiceRequest: 'subject',
  Task: 'for',
};

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

/** Validate the actual patient association of a supported clinical write. */
export function validPatientWriteAssociation(
  resourceType: string,
  body: unknown,
  patientId: string,
  fhirBaseUrl: string,
): boolean {
  const resource = record(body);
  if (!resource) return false;
  const patientReferences = new Set([
    `Patient/${patientId}`,
    `${fhirBaseUrl}/Patient/${patientId}`,
  ]);
  if (resourceType === 'Appointment') {
    if (!Array.isArray(resource.participant) || !resource.participant.length) return false;
    let foundPatient = false;
    for (const participant of resource.participant) {
      const actor = record(record(participant)?.actor);
      const reference = actor?.reference;
      // An unassigned participant has no patient identity to move across compartments.
      if (!actor) continue;
      if (typeof reference !== 'string') return false;
      if (patientReferences.has(reference)) {
        foundPatient = true;
        continue;
      }
      // Reject foreign/contained/identifier-only Patient actors, while retaining
      // ordinary clinician and location participants in an existing appointment.
      if (actor.type === 'Patient' || actor.type === 'http://hl7.org/fhir/StructureDefinition/Patient'
        || !/^(?:https?:\/\/[^?#]+\/)?(?:Practitioner|PractitionerRole|RelatedPerson|Device|HealthcareService|Location|Group)\/[A-Za-z0-9.-]{1,64}$/.test(reference)) return false;
    }
    return foundPatient;
  }
  const field = PATIENT_WRITE_FIELDS[resourceType];
  if (!field) return false;
  const reference = record(resource[field])?.reference;
  return typeof reference === 'string' && patientReferences.has(reference);
}
