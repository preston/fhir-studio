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
