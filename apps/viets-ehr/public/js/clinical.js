/**
 * FHIR presentation and resource construction, shared by every clinical view.
 * Values from a sandbox are untrusted data; these helpers return plain text.
 * @typedef {import('../../types.js').FhirResource} FhirResource
 * @typedef {import('../../types.js').ViewDefinition} ViewDefinition
 * @typedef {import('../../types.js').FieldDefinition} FieldDefinition
 * @typedef {import('../../types.js').ClinicalContext} ClinicalContext
 * @typedef {import('../../types.js').QuestionField} QuestionField
 */

/** @param {unknown} value @returns {Record<string, unknown>} */
export function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? /** @type {Record<string, unknown>} */ (value)
    : {};
}

/** @param {unknown} value @returns {unknown[]} */
export function array(value) {
  return Array.isArray(value) ? value : [];
}

/** @param {unknown} value @returns {string} */
export function string(value) {
  return typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
    ? String(value)
    : "";
}

/** @param {unknown} value @returns {string} */
export function concept(value) {
  const item = object(value);
  const coding = object(array(item.coding)[0]);
  return (
    string(item.text) ||
    string(coding.display) ||
    string(coding.code) ||
    (item.concept ? concept(item.concept) : "") ||
    string(object(item.reference).display) ||
    string(object(item.reference).reference) ||
    string(item.display) ||
    string(item.reference)
  );
}

/** @param {FhirResource} patient */
export function patientName(patient) {
  const name = object(array(patient.name)[0]);
  return (
    string(name.text) ||
    [...array(name.given).map(string), string(name.family)]
      .filter(Boolean)
      .join(" ") ||
    patient.id ||
    "Unnamed patient"
  );
}

/** @type {ViewDefinition[]} */
export const VIEWS = [
  {
    id: "schedule",
    label: "Schedule",
    description: "Appointments for the launch patient.",
    resourceType: "Appointment",
    patientParameter: "patient",
    editable: true,
  },
  {
    id: "inbox",
    label: "Inbox",
    description: "FHIR communications concerning the launch patient.",
    resourceType: "Communication",
    patientParameter: "patient",
    editable: true,
  },
  {
    id: "worklist",
    label: "Worklist",
    description: "Patient-related tasks and their workflow state.",
    resourceType: "Task",
    patientParameter: "patient",
    editable: true,
  },
  {
    id: "vitals",
    label: "Vitals & flowsheets",
    description:
      "Recorded vital-sign observations; values retain the server’s original units.",
    resourceType: "Observation",
    patientParameter: "patient",
    filters: { category: "vital-signs" },
    editable: true,
  },
  {
    id: "problems",
    label: "Problem list",
    description: "Conditions recorded in this patient’s chart.",
    resourceType: "Condition",
    patientParameter: "patient",
    editable: true,
  },
  {
    id: "allergies",
    label: "Allergies",
    description: "Recorded allergy and intolerance information.",
    resourceType: "AllergyIntolerance",
    patientParameter: "patient",
    editable: true,
  },
  {
    id: "notes",
    label: "Clinical notes",
    description: "Clinical documents stored as DocumentReference resources.",
    resourceType: "DocumentReference",
    patientParameter: "patient",
    editable: true,
  },
  {
    id: "orders",
    label: "Orders · CPOE",
    description:
      "Service requests, including laboratory and diagnostic orders.",
    resourceType: "ServiceRequest",
    patientParameter: "patient",
    editable: true,
  },
  {
    id: "medications",
    label: "Medications",
    description: "Medication requests and dosage instructions.",
    resourceType: "MedicationRequest",
    patientParameter: "patient",
    editable: true,
  },
  {
    id: "results",
    label: "Results",
    description:
      "All observations, including laboratory results and vital signs.",
    resourceType: "Observation",
    patientParameter: "patient",
    editable: true,
  },
  {
    id: "reports",
    label: "Diagnostic reports",
    description: "Reports and references to diagnostic findings.",
    resourceType: "DiagnosticReport",
    patientParameter: "patient",
    editable: true,
  },
  {
    id: "imaging",
    label: "Imaging & radiology",
    description:
      "Imaging study metadata. Images require the sandbox’s own imaging infrastructure.",
    resourceType: "ImagingStudy",
    patientParameter: "patient",
    editable: false,
  },
  {
    id: "immunizations",
    label: "Immunizations",
    description: "Recorded immunization administrations.",
    resourceType: "Immunization",
    patientParameter: "patient",
    editable: true,
  },
  {
    id: "coverage",
    label: "Registration & coverage",
    description:
      "Insurance coverage for the launch patient. Edit demographics from Patient Summary.",
    resourceType: "Coverage",
    patientParameter: "beneficiary",
    editable: true,
  },
  {
    id: "claims",
    label: "Billing claims",
    description:
      "FHIR claims in this sandbox; submitting a resource does not submit an insurance claim to a payer.",
    resourceType: "Claim",
    patientParameter: "patient",
    editable: true,
  },
  {
    id: "benefits",
    label: "Explanation of benefits",
    description: "Existing payer benefit statements.",
    resourceType: "ExplanationOfBenefit",
    patientParameter: "patient",
    editable: false,
  },
  {
    id: "referrals",
    label: "Referrals & consults",
    description: "Service requests categorized as referrals.",
    resourceType: "ServiceRequest",
    patientParameter: "patient",
    filters: { category: "referral" },
    editable: true,
  },
  {
    id: "encounters",
    label: "Encounters",
    description: "Patient encounters and visit history.",
    resourceType: "Encounter",
    patientParameter: "patient",
    editable: true,
  },
  {
    id: "responses",
    label: "Completed forms",
    description: "Saved QuestionnaireResponse resources.",
    resourceType: "QuestionnaireResponse",
    patientParameter: "patient",
    editable: false,
  },
  {
    id: "clinical-impressions",
    label: "Clinical impressions",
    description:
      "Recorded assessments; this example does not generate clinical decision recommendations.",
    resourceType: "ClinicalImpression",
    patientParameter: "patient",
    editable: false,
  },
  {
    id: "care-plans",
    label: "Care plans",
    description: "Existing care plans for the launch patient.",
    resourceType: "CarePlan",
    patientParameter: "patient",
    editable: false,
  },
  {
    id: "quality-reports",
    label: "Quality measure reports",
    description:
      "Existing individual MeasureReports; population-wide access depends on the granted SMART scopes.",
    resourceType: "MeasureReport",
    patientParameter: "patient",
    editable: false,
  },
];

/** @param {ViewDefinition} view @param {string} patientId @returns {Record<string, string>} */
export function patientQuery(view, patientId) {
  requireId(patientId, "Patient");
  return {
    [view.patientParameter]: `Patient/${patientId}`,
    ...view.filters,
    _count: "50",
  };
}

/** @type {Record<string, FieldDefinition[]>} */
export const CREATE_FIELDS = {
  Appointment: [
    {
      name: "description",
      label: "Appointment description",
      type: "text",
      required: true,
    },
    { name: "start", label: "Start", type: "datetime-local", required: true },
    { name: "end", label: "End", type: "datetime-local", required: true },
  ],
  Communication: [
    { name: "text", label: "Message", type: "textarea", required: true },
  ],
  Task: [
    {
      name: "description",
      label: "Task description",
      type: "textarea",
      required: true,
    },
    {
      name: "status",
      label: "Status",
      type: "select",
      options: [
        "requested",
        "accepted",
        "in-progress",
        "completed",
        "cancelled",
      ],
      required: true,
    },
  ],
  Observation: [
    {
      name: "display",
      label: "Observation name",
      type: "text",
      required: true,
    },
    { name: "code", label: "LOINC code (optional)", type: "text" },
    { name: "value", label: "Numeric value", type: "number", required: true },
    { name: "unit", label: "Unit", type: "text", required: true },
    {
      name: "category",
      label: "Category",
      type: "select",
      options: ["vital-signs", "laboratory", "survey", "exam"],
      required: true,
    },
    { name: "date", label: "Observed at", type: "datetime-local" },
  ],
  Condition: [
    { name: "display", label: "Problem", type: "text", required: true },
    { name: "code", label: "SNOMED CT code (optional)", type: "text" },
    {
      name: "status",
      label: "Clinical status",
      type: "select",
      options: [
        "active",
        "recurrence",
        "relapse",
        "inactive",
        "remission",
        "resolved",
      ],
      required: true,
    },
    { name: "date", label: "Onset date", type: "date" },
  ],
  AllergyIntolerance: [
    {
      name: "display",
      label: "Substance or allergy",
      type: "text",
      required: true,
    },
    {
      name: "criticality",
      label: "Criticality",
      type: "select",
      options: ["unable-to-assess", "low", "high"],
      required: true,
    },
    { name: "reaction", label: "Reaction description", type: "text" },
  ],
  DocumentReference: [
    { name: "description", label: "Note title", type: "text", required: true },
    { name: "text", label: "Clinical note", type: "textarea", required: true },
  ],
  ServiceRequest: [
    {
      name: "display",
      label: "Requested service",
      type: "text",
      required: true,
    },
    {
      name: "category",
      label: "Category",
      type: "select",
      options: ["laboratory", "imaging", "referral", "procedure"],
      required: true,
    },
    {
      name: "priority",
      label: "Priority",
      type: "select",
      options: ["routine", "urgent", "asap", "stat"],
      required: true,
    },
    {
      name: "text",
      label: "Instructions or referral reason",
      type: "textarea",
    },
  ],
  MedicationRequest: [
    { name: "display", label: "Medication", type: "text", required: true },
    { name: "code", label: "RxNorm code (optional)", type: "text" },
    {
      name: "dosage",
      label: "Dosage instructions",
      type: "textarea",
      required: true,
    },
    {
      name: "status",
      label: "Status",
      type: "select",
      options: [
        "draft",
        "active",
        "on-hold",
        "completed",
        "cancelled",
        "stopped",
      ],
      required: true,
    },
  ],
  DiagnosticReport: [
    { name: "display", label: "Report name", type: "text", required: true },
    { name: "text", label: "Conclusion", type: "textarea", required: true },
  ],
  Immunization: [
    { name: "display", label: "Vaccine", type: "text", required: true },
    { name: "code", label: "CVX code (optional)", type: "text" },
    { name: "date", label: "Administered on", type: "date", required: true },
    { name: "lot", label: "Lot number (optional)", type: "text" },
  ],
  Coverage: [
    {
      name: "payer",
      label: "Existing payer reference (Organization/id)",
      type: "text",
      required: true,
    },
    {
      name: "subscriberId",
      label: "Subscriber / member ID",
      type: "text",
      required: true,
    },
    {
      name: "display",
      label: "Plan description",
      type: "text",
      required: true,
    },
  ],
  Claim: [
    {
      name: "provider",
      label: "Existing provider reference (Practitioner/id or Organization/id)",
      type: "text",
      required: true,
    },
    {
      name: "coverage",
      label: "Existing coverage reference (Coverage/id)",
      type: "text",
      required: true,
    },
    {
      name: "display",
      label: "Claim description",
      type: "text",
      required: true,
    },
    { name: "amount", label: "Total amount", type: "number", required: true },
    {
      name: "currency",
      label: "Currency code (e.g. USD)",
      type: "text",
      required: true,
    },
  ],
  Encounter: [
    {
      name: "display",
      label: "Visit description",
      type: "text",
      required: true,
    },
    {
      name: "class",
      label: "Encounter class",
      type: "select",
      options: ["AMB", "IMP", "EMER", "HH", "VR"],
      required: true,
    },
    {
      name: "status",
      label: "Status",
      type: "select",
      options: ["planned", "in-progress", "completed", "cancelled"],
      required: true,
    },
  ],
};

/** @param {string} id @param {string} type */
function requireId(id, type) {
  if (!/^[A-Za-z0-9.-]{1,64}$/.test(id))
    throw new Error(`Invalid ${type} identifier.`);
}

/** @param {string} reference @param {string[]} allowed */
function requireReference(reference, allowed) {
  const [type, id, extra] = reference.split("/");
  if (!type || !id || extra || !allowed.includes(type)) {
    throw new Error(
      `Use an existing ${allowed.join(" or ")} reference, such as ${allowed[0]}/id.`,
    );
  }
  requireId(id, type);
  return { reference };
}

/** @param {string} value */
function dateTime(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()))
    throw new Error("Enter a valid date and time.");
  return date.toISOString();
}

/** @param {string} display @param {string | undefined} code @param {string} system */
function coded(display, code, system) {
  return {
    text: display,
    ...(code ? { coding: [{ system, code, display }] } : {}),
  };
}

/**
 * Create a minimal clinical resource. Every write still requires SMART permission
 * and is validated by the receiving FHIR server and its implementation guides.
 * @param {string} type
 * @param {Record<string, string>} values
 * @param {ClinicalContext} context
 * @returns {FhirResource}
 */
export function createResource(type, values, context) {
  requireId(context.patientId, "Patient");
  for (const field of CREATE_FIELDS[type] || []) {
    const value = values[field.name]?.trim() || "";
    if (field.required && !value)
      throw new Error(`${field.label} is required.`);
    if (value && field.options && !field.options.includes(value))
      throw new Error(`Invalid ${field.label}.`);
  }
  const patient = { reference: `Patient/${context.patientId}` };
  const now = context.now || new Date().toISOString();
  const r5 =
    context.fhirVersion === "R5" || context.fhirVersion?.startsWith("5.");
  const encounter = context.encounterId
    ? { reference: `Encounter/${context.encounterId}` }
    : undefined;
  if (context.encounterId) requireId(context.encounterId, "Encounter");
  const encounterField = encounter ? { encounter } : {};
  const display = values.display || "";
  /** @type {FhirResource} */
  let resource;
  switch (type) {
    case "Appointment": {
      const start = dateTime(values.start || "");
      const end = dateTime(values.end || "");
      if (start >= end)
        throw new Error("Appointment end must be after its start.");
      resource = {
        resourceType: type,
        status: "booked",
        description: values.description,
        start,
        end,
        participant: [{ actor: patient, status: "accepted" }],
      };
      break;
    }
    case "Communication":
      resource = {
        resourceType: type,
        status: "completed",
        subject: patient,
        sent: now,
        payload: [
          r5
            ? { contentCodeableConcept: { text: values.text } }
            : { contentString: values.text },
        ],
        ...encounterField,
      };
      break;
    case "Task":
      resource = {
        resourceType: type,
        status: values.status,
        intent: "order",
        for: patient,
        description: values.description,
        authoredOn: now,
        ...encounterField,
      };
      break;
    case "Observation": {
      const value = Number(values.value);
      if (!Number.isFinite(value))
        throw new Error("Observation value must be a finite number.");
      resource = {
        resourceType: type,
        status: "final",
        subject: patient,
        code: coded(display, values.code, "http://loinc.org"),
        category: [
          {
            coding: [
              {
                system:
                  "http://terminology.hl7.org/CodeSystem/observation-category",
                code: values.category,
              },
            ],
          },
        ],
        effectiveDateTime: values.date ? dateTime(values.date) : now,
        valueQuantity: { value, unit: values.unit },
        ...encounterField,
      };
      break;
    }
    case "Condition":
      resource = {
        resourceType: type,
        subject: patient,
        clinicalStatus: {
          coding: [
            {
              system:
                "http://terminology.hl7.org/CodeSystem/condition-clinical",
              code: values.status,
            },
          ],
        },
        verificationStatus: {
          coding: [
            {
              system:
                "http://terminology.hl7.org/CodeSystem/condition-ver-status",
              code: "confirmed",
            },
          ],
        },
        category: [
          {
            coding: [
              {
                system:
                  "http://terminology.hl7.org/CodeSystem/condition-category",
                code: "problem-list-item",
              },
            ],
          },
        ],
        code: coded(display, values.code, "http://snomed.info/sct"),
        recordedDate: now,
        ...(values.date ? { onsetDateTime: values.date } : {}),
        ...encounterField,
      };
      break;
    case "AllergyIntolerance":
      resource = {
        resourceType: type,
        patient,
        clinicalStatus: {
          coding: [
            {
              system:
                "http://terminology.hl7.org/CodeSystem/allergyintolerance-clinical",
              code: "active",
            },
          ],
        },
        verificationStatus: {
          coding: [
            {
              system:
                "http://terminology.hl7.org/CodeSystem/allergyintolerance-verification",
              code: "confirmed",
            },
          ],
        },
        code: { text: display },
        criticality: values.criticality,
        ...(values.reaction
          ? {
              reaction: [
                {
                  manifestation: r5
                    ? [{ concept: { text: values.reaction } }]
                    : [{ text: values.reaction }],
                },
              ],
            }
          : {}),
        ...encounterField,
      };
      break;
    case "DocumentReference": {
      const bytes = new TextEncoder().encode(values.text || "");
      const data = btoa(
        Array.from(bytes, (byte) => String.fromCharCode(byte)).join(""),
      );
      resource = {
        resourceType: type,
        status: "current",
        subject: patient,
        date: now,
        description: values.description,
        content: [
          {
            attachment: {
              contentType: "text/plain",
              data,
              title: values.description,
            },
          },
        ],
        ...(encounter
          ? r5
            ? { context: [encounter] }
            : { context: { encounter: [encounter] } }
          : {}),
      };
      break;
    }
    case "ServiceRequest":
      resource = {
        resourceType: type,
        status: "active",
        intent: "order",
        subject: patient,
        code: r5 ? { concept: { text: display } } : { text: display },
        priority: values.priority,
        category: [
          {
            coding: [
              {
                system:
                  "https://fhir-studio.dev/examples/viets-ehr/service-category",
                code: values.category,
              },
            ],
            text: values.category,
          },
        ],
        authoredOn: now,
        ...(values.text ? { note: [{ text: values.text }] } : {}),
        ...encounterField,
      };
      break;
    case "MedicationRequest":
      resource = {
        resourceType: type,
        status: values.status,
        intent: "order",
        subject: patient,
        ...(r5
          ? {
              medication: {
                concept: coded(
                  display,
                  values.code,
                  "http://www.nlm.nih.gov/research/umls/rxnorm",
                ),
              },
            }
          : {
              medicationCodeableConcept: coded(
                display,
                values.code,
                "http://www.nlm.nih.gov/research/umls/rxnorm",
              ),
            }),
        authoredOn: now,
        dosageInstruction: [{ text: values.dosage }],
        ...encounterField,
      };
      break;
    case "DiagnosticReport":
      resource = {
        resourceType: type,
        status: "final",
        subject: patient,
        code: { text: display },
        effectiveDateTime: now,
        conclusion: values.text,
        ...encounterField,
      };
      break;
    case "Immunization":
      resource = {
        resourceType: type,
        status: "completed",
        patient,
        vaccineCode: coded(display, values.code, "http://hl7.org/fhir/sid/cvx"),
        occurrenceDateTime: values.date,
        ...(values.lot ? { lotNumber: values.lot } : {}),
        ...encounterField,
      };
      break;
    case "Coverage": {
      const payer = requireReference(values.payer || "", ["Organization"]);
      resource = {
        resourceType: type,
        status: "active",
        beneficiary: patient,
        type: { text: display },
        ...(r5
          ? {
              kind: "insurance",
              insurer: payer,
              subscriberId: [{ value: values.subscriberId }],
            }
          : { payor: [payer], subscriberId: values.subscriberId }),
      };
      break;
    }
    case "Claim": {
      const amount = Number(values.amount);
      if (!Number.isFinite(amount) || amount < 0)
        throw new Error("Enter a nonnegative claim amount.");
      if (!/^[A-Z]{3}$/.test(values.currency || ""))
        throw new Error("Currency must be a three-letter uppercase code.");
      resource = {
        resourceType: type,
        status: "draft",
        use: "claim",
        patient,
        created: now,
        type: {
          coding: [
            {
              system: "http://terminology.hl7.org/CodeSystem/claim-type",
              code: "professional",
            },
          ],
          text: display,
        },
        provider: requireReference(values.provider || "", [
          "Practitioner",
          "Organization",
        ]),
        priority: {
          coding: [
            {
              system: "http://terminology.hl7.org/CodeSystem/processpriority",
              code: "normal",
            },
          ],
        },
        insurance: [
          {
            sequence: 1,
            focal: true,
            coverage: requireReference(values.coverage || "", ["Coverage"]),
          },
        ],
        total: { value: amount, currency: values.currency },
      };
      break;
    }
    case "Encounter": {
      const classCode = {
        system: "http://terminology.hl7.org/CodeSystem/v3-ActCode",
        code: values.class,
      };
      resource = {
        resourceType: type,
        subject: patient,
        status:
          !r5 && values.status === "completed" ? "finished" : values.status,
        class: r5 ? [{ coding: [classCode] }] : classCode,
        type: [{ text: display }],
      };
      break;
    }
    default:
      throw new Error(`Creating ${type} requires the resource JSON editor.`);
  }
  validatePatientResource(resource, context.patientId);
  return resource;
}

/** @param {FhirResource} resource @returns {{title:string,status:string,date:string,detail:string}} */
export function summarize(resource) {
  const type = resource.resourceType;
  const attachment = object(object(array(resource.content)[0]).attachment);
  const coding =
    concept(resource.code) ||
    concept(resource.medicationCodeableConcept) ||
    concept(resource.medication) ||
    concept(resource.vaccineCode);
  const name = type === "Patient" ? patientName(resource) : "";
  const quantity = object(resource.valueQuantity);
  const components = array(resource.component)
    .map((value) => {
      const component = object(value);
      const q = object(component.valueQuantity);
      return [concept(component.code), string(q.value), string(q.unit)]
        .filter(Boolean)
        .join(" ");
    })
    .join("; ");
  const result =
    [string(quantity.value), string(quantity.unit)].filter(Boolean).join(" ") ||
    string(resource.valueString) ||
    concept(resource.valueCodeableConcept) ||
    components;
  const medication = array(resource.dosageInstruction)
    .map((value) => string(object(value).text))
    .filter(Boolean)
    .join("; ");
  const payload = array(resource.payload)
    .map(
      (value) =>
        string(object(value).contentString) ||
        concept(object(value).contentCodeableConcept),
    )
    .filter(Boolean)
    .join("; ");
  let note = "";
  if (
    attachment.contentType === "text/plain" &&
    typeof attachment.data === "string" &&
    attachment.data.length <= 1000000
  ) {
    try {
      note = new TextDecoder().decode(
        Uint8Array.from(atob(attachment.data), (character) =>
          character.charCodeAt(0),
        ),
      );
      if (note.length > 500) note = `${note.slice(0, 500)}…`;
    } catch {
      /* An invalid attachment does not hide the resource's metadata. */
    }
  }
  const status = string(resource.status) || concept(resource.clinicalStatus);
  const date =
    string(resource.effectiveDateTime) ||
    string(resource.authoredOn) ||
    string(resource.recordedDate) ||
    string(resource.occurrenceDateTime) ||
    string(resource.start) ||
    string(resource.sent) ||
    string(resource.date) ||
    string(resource.created) ||
    string(object(resource.period).start) ||
    string(object(resource.actualPeriod).start) ||
    string(object(resource.meta).lastUpdated);
  const detail =
    result ||
    medication ||
    payload ||
    note ||
    string(resource.conclusion) ||
    array(resource.note)
      .map((value) => string(object(value).text))
      .filter(Boolean)
      .join("; ") ||
    concept(resource.type) ||
    array(resource.type).map(concept).join("; ") ||
    string(resource.subscriberId) ||
    string(object(resource.total).value);
  return {
    title:
      name ||
      coding ||
      string(resource.description) ||
      string(resource.title) ||
      string(attachment.title) ||
      string(resource.questionnaire) ||
      string(resource.measure) ||
      type,
    status,
    date,
    detail,
  };
}

/**
 * Stop accidental cross-patient writes in the example before the gateway's own
 * authorization check. This is convenience validation, never an access boundary.
 * @param {FhirResource} resource @param {string} patientId @param {string} [issuer]
 */
export function validatePatientResource(resource, patientId, issuer) {
  requireId(patientId, "Patient");
  if (!/^[A-Z][A-Za-z0-9]+$/.test(resource.resourceType))
    throw new Error("Invalid resourceType.");
  if (resource.resourceType === "Patient") {
    if (resource.id !== patientId)
      throw new Error("Only the launch patient may be edited.");
    return;
  }
  const direct = [
    resource.subject,
    resource.patient,
    resource.beneficiary,
    resource.for,
  ];
  if (resource.resourceType === "Appointment") {
    direct.push(
      ...array(resource.participant).map((value) => object(value).actor),
    );
  }
  const expected = `Patient/${patientId}`;
  const expectedAbsolute = issuer
    ? `${issuer.replace(/\/+$/, "")}/${expected}`
    : undefined;
  const patientReferences = direct.flatMap((value) => {
    const reference = string(object(value).reference);
    if (reference.startsWith("Patient/")) return [reference];
    try {
      const url = new URL(reference);
      if (!/\/Patient\/[^/]+(?:\/_history\/[^/]+)?$/.test(url.pathname))
        return [];
      return [
        expectedAbsolute &&
        url.href === expectedAbsolute &&
        !url.search &&
        !url.hash
          ? expected
          : "unapproved-patient-reference",
      ];
    } catch {
      return [];
    }
  });
  if (
    !patientReferences.includes(`Patient/${patientId}`) ||
    patientReferences.some((reference) => reference !== `Patient/${patientId}`)
  ) {
    throw new Error("Resource must reference only the launch patient.");
  }
}

/** @param {FhirResource} questionnaire @returns {QuestionField[]} */
export function questionnaireFields(questionnaire) {
  if (questionnaire.resourceType !== "Questionnaire")
    throw new Error("Expected a Questionnaire resource.");
  /** @type {QuestionField[]} */
  const result = [];
  const ids = new Set();
  /** @param {unknown[]} items */
  function visit(items) {
    for (const raw of items) {
      const item = object(raw);
      const linkId = string(item.linkId);
      if (!linkId || ids.has(linkId))
        throw new Error("Questionnaire item identifiers must be unique.");
      ids.add(linkId);
      if (
        item.repeats ||
        array(item.enableWhen).length ||
        item.answerValueSet ||
        array(item.extension).length
      ) {
        throw new Error(
          "This example supports basic forms only; conditional, repeating, ValueSet-backed, or extended forms require a full SDC renderer.",
        );
      }
      const type = string(item.type);
      const supported = [
        "group",
        "display",
        "boolean",
        "integer",
        "decimal",
        "date",
        "dateTime",
        "time",
        "string",
        "text",
        "url",
        "choice",
        "coding",
      ];
      if (!supported.includes(type))
        throw new Error(`Unsupported Questionnaire item type: ${type}.`);
      const options = array(item.answerOption).map((rawOption, index) => {
        const option = object(rawOption);
        const label =
          concept(option.valueCoding) ||
          string(option.valueString) ||
          string(option.valueInteger);
        if (!label) throw new Error("Unsupported Questionnaire answer option.");
        return { label, value: String(index) };
      });
      if (options.length && !["choice", "coding"].includes(type)) {
        throw new Error(
          "This example supports inline answer options on choice or coding questions only.",
        );
      }
      if ((type === "choice" || type === "coding") && !options.length)
        throw new Error("Choice questions require inline answer options.");
      if (
        item.readOnly &&
        item.required &&
        !array(item.initial).length &&
        !array(item.answerOption).some(
          (option) => object(option).initialSelected === true,
        )
      ) {
        throw new Error(
          "This form requires a calculated answer; use a full SDC renderer.",
        );
      }
      const initialValues = array(item.initial);
      if (initialValues.length > 1)
        throw new Error(
          "Multiple initial values require a repeating form renderer.",
        );
      const initialValue = object(initialValues[0]);
      const initialKey = Object.keys(initialValue).find((key) =>
        key.startsWith("value"),
      );
      const expectedInitialKey = {
        boolean: "valueBoolean",
        integer: "valueInteger",
        decimal: "valueDecimal",
        date: "valueDate",
        dateTime: "valueDateTime",
        time: "valueTime",
        string: "valueString",
        text: "valueString",
        url: "valueUri",
      };
      if (
        initialValues.length &&
        (!initialKey ||
          (["choice", "coding"].includes(type)
            ? !["valueCoding", "valueString", "valueInteger"].includes(
                initialKey,
              )
            : /** @type {Record<string, string>} */ (expectedInitialKey)[
                type
              ] !== initialKey))
      ) {
        throw new Error(
          `Unsupported initial answer for ${string(item.text) || linkId}.`,
        );
      }
      if (
        (type === "integer" || type === "decimal") &&
        initialKey &&
        (typeof initialValue[initialKey] !== "number" ||
          !Number.isFinite(initialValue[initialKey]) ||
          (type === "integer" && !Number.isInteger(initialValue[initialKey])))
      ) {
        throw new Error(
          `Invalid initial number for ${string(item.text) || linkId}.`,
        );
      }
      if (
        type === "boolean" &&
        initialKey &&
        typeof initialValue[initialKey] !== "boolean"
      ) {
        throw new Error(
          `Invalid initial boolean for ${string(item.text) || linkId}.`,
        );
      }
      const initialCoding = object(initialValue.valueCoding);
      const selectedOption = array(item.answerOption).findIndex((rawOption) => {
        const option = object(rawOption);
        const coding = object(option.valueCoding);
        return (
          option.initialSelected === true ||
          (initialValue.valueCoding !== undefined &&
            coding.code === initialCoding.code &&
            coding.system === initialCoding.system) ||
          (initialKey !== undefined &&
            initialKey !== "valueCoding" &&
            option[initialKey] === initialValue[initialKey])
        );
      });
      if (
        initialValues.length &&
        ["choice", "coding"].includes(type) &&
        selectedOption < 0
      ) {
        throw new Error(
          `Initial answer is absent from the choices for ${string(item.text) || linkId}.`,
        );
      }
      let initial =
        selectedOption >= 0
          ? String(selectedOption)
          : string(initialValue.valueString) ||
            string(initialValue.valueBoolean) ||
            string(initialValue.valueInteger) ||
            string(initialValue.valueDecimal) ||
            string(initialValue.valueDate) ||
            string(initialValue.valueDateTime) ||
            string(initialValue.valueTime) ||
            string(initialValue.valueUri);
      if (initial && type === "dateTime") {
        const date = new Date(initial);
        if (!Number.isFinite(date.getTime()))
          throw new Error(
            `Invalid initial date for ${string(item.text) || linkId}.`,
          );
        initial = new Date(date.getTime() - date.getTimezoneOffset() * 60000)
          .toISOString()
          .slice(0, 19);
      }
      result.push({
        linkId,
        text: string(item.text) || linkId,
        type,
        required: item.required === true,
        readOnly: item.readOnly === true,
        ...(initial ? { initial } : {}),
        ...(options.length ? { options } : {}),
      });
      visit(array(item.item));
    }
  }
  visit(array(questionnaire.item));
  return result;
}

/**
 * Preserve groups, Coding answers, and typed numbers. Include a contained snapshot
 * so bundled forms work without seeding a Questionnaire into each sandbox.
 * @param {FhirResource} questionnaire
 * @param {Record<string, string>} answers
 * @param {ClinicalContext} context
 * @returns {FhirResource}
 */
export function questionnaireResponse(questionnaire, answers, context) {
  const fields = questionnaireFields(questionnaire);
  requireId(context.patientId, "Patient");
  const fieldById = new Map(fields.map((field) => [field.linkId, field]));
  /** @param {unknown[]} items @returns {Record<string, unknown>[]} */
  function respond(items) {
    /** @type {Record<string, unknown>[]} */
    const result = [];
    for (const raw of items) {
      const item = object(raw);
      const linkId = string(item.linkId);
      const field = fieldById.get(linkId);
      if (!field) throw new Error("Questionnaire item is missing.");
      if (field.type === "display") continue;
      const entry = { linkId, ...(item.text ? { text: item.text } : {}) };
      if (field.type === "group") {
        result.push({ ...entry, item: respond(array(item.item)) });
        continue;
      }
      const value = field.readOnly
        ? (field.initial ?? "")
        : (answers[linkId] ?? "");
      if (field.readOnly) {
        const initial = array(item.initial);
        if (initial.length) {
          result.push({ ...entry, answer: initial });
          continue;
        }
      }
      if (!value) {
        if (field.required) throw new Error(`${field.text} is required.`);
        continue;
      }
      /** @type {Record<string, unknown>} */
      let answer;
      switch (field.type) {
        case "choice":
        case "coding": {
          const option = array(item.answerOption)[Number(value)];
          if (!/^\d+$/.test(value) || !option)
            throw new Error(`Select a valid answer for ${field.text}.`);
          answer = Object.fromEntries(
            Object.entries(object(option)).filter(([key]) =>
              key.startsWith("value"),
            ),
          );
          break;
        }
        case "integer":
        case "decimal": {
          const number = Number(value);
          if (
            !Number.isFinite(number) ||
            (field.type === "integer" && !Number.isInteger(number))
          ) {
            throw new Error(`Enter a valid ${field.type} for ${field.text}.`);
          }
          answer = {
            [field.type === "integer" ? "valueInteger" : "valueDecimal"]:
              number,
          };
          break;
        }
        case "boolean":
          if (!["true", "false"].includes(value))
            throw new Error(`Select Yes or No for ${field.text}.`);
          answer = { valueBoolean: value === "true" };
          break;
        case "date":
          answer = { valueDate: value };
          break;
        case "dateTime":
          answer = { valueDateTime: dateTime(value) };
          break;
        case "time":
          answer = {
            valueTime: /^\d{2}:\d{2}$/.test(value) ? `${value}:00` : value,
          };
          break;
        case "url":
          answer = { valueUri: value };
          break;
        default:
          answer = { valueString: value };
      }
      result.push({
        ...entry,
        answer: [
          {
            ...answer,
            ...(array(item.item).length
              ? { item: respond(array(item.item)) }
              : {}),
          },
        ],
      });
    }
    return result;
  }
  const snapshot = structuredClone(questionnaire);
  snapshot.id = "questionnaire";
  delete snapshot.meta;
  delete snapshot.contained;
  if (context.fhirVersion === "R5" || context.fhirVersion?.startsWith("5.")) {
    /** @param {unknown[]} items */
    function convertChoices(items) {
      for (const raw of items) {
        const item = object(raw);
        if (item.type === "choice") item.type = "coding";
        convertChoices(array(item.item));
      }
    }
    convertChoices(array(snapshot.item));
  }
  return {
    resourceType: "QuestionnaireResponse",
    status: "completed",
    questionnaire: "#questionnaire",
    contained: [snapshot],
    subject: { reference: `Patient/${context.patientId}` },
    authored: context.now || new Date().toISOString(),
    ...(context.encounterId
      ? { encounter: { reference: `Encounter/${context.encounterId}` } }
      : {}),
    item: respond(array(questionnaire.item)),
  };
}

const frequencyOptions = [
  "Not at all",
  "Several days",
  "More than half the days",
  "Nearly every day",
].map((display, index) => ({ valueCoding: { code: String(index), display } }));

/** @param {string} id @param {string} title @param {string[]} questions @returns {FhirResource} */
function screening(id, title, questions) {
  return {
    resourceType: "Questionnaire",
    id,
    name: id.toUpperCase(),
    title,
    status: "active",
    subjectType: ["Patient"],
    item: [
      {
        linkId: "intro",
        type: "display",
        text: "Over the last 2 weeks, how often have you been bothered by the following problems?",
      },
      ...questions.map((text, index) => ({
        linkId: `q${index + 1}`,
        type: "choice",
        text,
        required: true,
        answerOption: frequencyOptions,
      })),
    ],
  };
}

/** Basic local forms; never automatically installed or submitted to a sandbox. @type {FhirResource[]} */
export const sampleQuestionnaires = [
  screening("phq9", "PHQ-9 depression screening", [
    "Little interest or pleasure in doing things",
    "Feeling down, depressed, or hopeless",
    "Trouble falling or staying asleep, or sleeping too much",
    "Feeling tired or having little energy",
    "Poor appetite or overeating",
    "Feeling bad about yourself, that you are a failure, or have let yourself or your family down",
    "Trouble concentrating on things, such as reading the newspaper or watching television",
    "Moving or speaking so slowly that other people could have noticed, or being so fidgety or restless that you have been moving around a lot more than usual",
    "Thoughts that you would be better off dead, or of hurting yourself in some way",
  ]),
  screening("gad7", "GAD-7 anxiety screening", [
    "Feeling nervous, anxious, or on edge",
    "Not being able to stop or control worrying",
    "Worrying too much about different things",
    "Trouble relaxing",
    "Being so restless that it is hard to sit still",
    "Becoming easily annoyed or irritable",
    "Feeling afraid, as if something awful might happen",
  ]),
  {
    resourceType: "Questionnaire",
    id: "vitals",
    title: "Vital signs intake",
    status: "active",
    subjectType: ["Patient"],
    item: [
      {
        linkId: "blood-pressure",
        text: "Blood pressure",
        type: "group",
        item: [
          {
            linkId: "systolic",
            text: "Systolic (mmHg)",
            type: "integer",
            required: true,
          },
          {
            linkId: "diastolic",
            text: "Diastolic (mmHg)",
            type: "integer",
            required: true,
          },
        ],
      },
      {
        linkId: "heart-rate",
        text: "Heart rate (beats/minute)",
        type: "integer",
        required: true,
      },
      {
        linkId: "respiratory-rate",
        text: "Respiratory rate (breaths/minute)",
        type: "integer",
        required: true,
      },
      {
        linkId: "temperature",
        text: "Temperature (°C)",
        type: "decimal",
        required: true,
      },
      {
        linkId: "oxygen-saturation",
        text: "Oxygen saturation (%)",
        type: "decimal",
        required: true,
      },
      { linkId: "weight", text: "Weight (kg)", type: "decimal" },
      { linkId: "height", text: "Height (cm)", type: "decimal" },
      { linkId: "pain", text: "Pain score (0–10)", type: "integer" },
      { linkId: "notes", text: "Intake notes", type: "text" },
    ],
  },
];
