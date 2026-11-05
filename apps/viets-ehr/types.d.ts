export interface FhirResource {
  resourceType: string;
  id?: string;
  [key: string]: unknown;
}

export interface FhirBundle extends FhirResource {
  resourceType: "Bundle";
  entry?: Array<{ resource?: FhirResource }>;
  link?: Array<{ relation: string; url: string }>;
  total?: number;
}

export interface SmartSession {
  issuer: string;
  accessToken: string;
  patient: string;
  encounter?: string;
  scope: string;
  expiresAt: number;
  clientId: string;
  studioOrigin: string;
}

export interface ViewDefinition {
  id: string;
  label: string;
  description: string;
  resourceType: string;
  patientParameter: string;
  filters?: Record<string, string>;
  editable: boolean;
}

export interface FieldDefinition {
  name: string;
  label: string;
  type: "text" | "textarea" | "date" | "datetime-local" | "number" | "select";
  required?: boolean;
  options?: string[];
}

export interface ClinicalContext {
  patientId: string;
  encounterId?: string;
  fhirVersion?: string;
  now?: string;
}

export interface QuestionField {
  linkId: string;
  text: string;
  type: string;
  required: boolean;
  readOnly: boolean;
  initial?: string;
  options?: Array<{ label: string; value: string }>;
}
