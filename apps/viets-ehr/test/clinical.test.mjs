import assert from "node:assert/strict";
import test from "node:test";
import {
  createResource,
  patientQuery,
  questionnaireFields,
  questionnaireResponse,
  sampleQuestionnaires,
  summarize,
  validatePatientResource,
  VIEWS,
} from "../public/js/clinical.js";

const context = {
  patientId: "patient-a",
  encounterId: "visit-a",
  now: "2026-11-05T12:00:00.000Z",
};

test("patient queries always constrain the requested patient and retain view filters", () => {
  assert.deepEqual(
    patientQuery(
      VIEWS.find((view) => view.id === "vitals"),
      context.patientId,
    ),
    {
      patient: "Patient/patient-a",
      category: "vital-signs",
      _count: "50",
    },
  );
  assert.throws(
    () => patientQuery(VIEWS[0], "../patient-b"),
    /Invalid Patient/,
  );
});

test("medication, service request, communication and coverage writes use release-specific shapes", () => {
  const medicationValues = {
    display: "Example medication",
    dosage: "Example dosage",
    status: "draft",
  };
  const r4 = createResource("MedicationRequest", medicationValues, context);
  const r5 = createResource("MedicationRequest", medicationValues, {
    ...context,
    fhirVersion: "R5",
  });
  assert.deepEqual(r4.medicationCodeableConcept, {
    text: "Example medication",
  });
  assert.equal(r4.medication, undefined);
  assert.deepEqual(r5.medication, { concept: { text: "Example medication" } });
  assert.equal(r5.medicationCodeableConcept, undefined);
  const serviceValues = {
    display: "Referral",
    category: "referral",
    priority: "routine",
  };
  assert.deepEqual(
    createResource("ServiceRequest", serviceValues, context).code,
    { text: "Referral" },
  );
  assert.deepEqual(
    createResource("ServiceRequest", serviceValues, {
      ...context,
      fhirVersion: "R5",
    }).code,
    { concept: { text: "Referral" } },
  );
  assert.deepEqual(
    createResource("Communication", { text: "message" }, context).payload,
    [{ contentString: "message" }],
  );
  assert.deepEqual(
    createResource(
      "Communication",
      { text: "message" },
      { ...context, fhirVersion: "R5" },
    ).payload,
    [{ contentCodeableConcept: { text: "message" } }],
  );
  const coverageValues = {
    display: "Plan",
    payer: "Organization/payer-a",
    subscriberId: "member-a",
  };
  assert.deepEqual(createResource("Coverage", coverageValues, context).payor, [
    { reference: "Organization/payer-a" },
  ]);
  const coverage5 = createResource("Coverage", coverageValues, {
    ...context,
    fhirVersion: "R5",
  });
  assert.deepEqual(coverage5.insurer, { reference: "Organization/payer-a" });
  assert.deepEqual(coverage5.subscriberId, [{ value: "member-a" }]);
  assert.equal(coverage5.kind, "insurance");
});

test("notes preserve Unicode as a plain-text attachment and visits use release-specific completion status", () => {
  const note = createResource(
    "DocumentReference",
    { description: "Visit note", text: "Viet’s EHR — đã xem" },
    context,
  );
  const bytes = Buffer.from(note.content[0].attachment.data, "base64");
  assert.equal(bytes.toString("utf8"), "Viet’s EHR — đã xem");
  assert.equal(summarize(note).detail, "Viet’s EHR — đã xem");
  assert.deepEqual(note.context, {
    encounter: [{ reference: "Encounter/visit-a" }],
  });
  const values = { display: "Visit", class: "AMB", status: "completed" };
  assert.equal(createResource("Encounter", values, context).status, "finished");
  const r5 = createResource("Encounter", values, {
    ...context,
    fhirVersion: "R5",
  });
  assert.equal(r5.status, "completed");
  assert.ok(Array.isArray(r5.class));
});

test("writes reject cross-patient edits, invalid dates, forged options and missing required inputs", () => {
  assert.throws(
    () =>
      validatePatientResource(
        {
          resourceType: "Observation",
          subject: { reference: "Patient/patient-b" },
        },
        context.patientId,
      ),
    /launch patient/,
  );
  assert.throws(
    () =>
      validatePatientResource(
        { resourceType: "Patient", id: "patient-b" },
        context.patientId,
      ),
    /launch patient/,
  );
  assert.throws(
    () =>
      validatePatientResource(
        {
          resourceType: "Appointment",
          participant: [
            { actor: { reference: "Patient/patient-a" } },
            { actor: { reference: "Patient/patient-b" } },
          ],
        },
        context.patientId,
      ),
    /launch patient/,
  );
  assert.throws(
    () =>
      createResource(
        "Appointment",
        {
          description: "Test",
          start: "2026-11-05T13:00",
          end: "2026-11-05T12:00",
        },
        context,
      ),
    /end must be after/,
  );
  assert.throws(
    () =>
      createResource(
        "MedicationRequest",
        { display: "Test", dosage: "Test", status: "forged" },
        context,
      ),
    /Invalid Status/,
  );
  assert.throws(
    () =>
      createResource(
        "Observation",
        { display: "Test", value: "NaN", unit: "mg", category: "laboratory" },
        context,
      ),
    /finite number/,
  );
  assert.throws(
    () =>
      createResource(
        "Coverage",
        {
          display: "Plan",
          subscriberId: "a",
          payer: "https://external.example/Organization/a",
        },
        context,
      ),
    /existing Organization/,
  );
  assert.throws(() => createResource("Condition", {}, context), /required/);
});

test("absolute patient references are accepted only for the exact trusted sandbox issuer", () => {
  const issuer = "https://studio.example/api/sandboxes/sandbox-a/fhir/R4";
  validatePatientResource(
    {
      resourceType: "Observation",
      subject: { reference: `${issuer}/Patient/patient-a` },
    },
    "patient-a",
    issuer,
  );
  assert.throws(
    () =>
      validatePatientResource(
        {
          resourceType: "Observation",
          subject: { reference: `${issuer}/Patient/patient-a` },
        },
        "patient-a",
      ),
    /launch patient/,
  );
  for (const reference of [
    "https://evil.example/api/sandboxes/sandbox-a/fhir/R4/Patient/patient-a",
    "https://studio.example/api/sandboxes/sandbox-b/fhir/R4/Patient/patient-a",
    `${issuer}/Patient/patient-a?token=forged`,
    `${issuer}/Patient/patient-b`,
  ]) {
    assert.throws(
      () =>
        validatePatientResource(
          { resourceType: "Observation", subject: { reference } },
          "patient-a",
          issuer,
        ),
      /launch patient/,
    );
    assert.throws(
      () =>
        validatePatientResource(
          {
            resourceType: "Observation",
            patient: { reference: "Patient/patient-a" },
            subject: { reference },
          },
          "patient-a",
          issuer,
        ),
      /launch patient/,
    );
  }
});

test("all original basic forms are complete and need no seeded Questionnaire", () => {
  assert.equal(
    questionnaireFields(sampleQuestionnaires[0]).filter(
      (field) => field.type === "choice",
    ).length,
    9,
  );
  assert.equal(
    questionnaireFields(sampleQuestionnaires[1]).filter(
      (field) => field.type === "choice",
    ).length,
    7,
  );
  const answers = Object.fromEntries(
    Array.from({ length: 9 }, (_, index) => [`q${index + 1}`, "2"]),
  );
  const response = questionnaireResponse(sampleQuestionnaires[0], answers, {
    ...context,
    fhirVersion: "R5",
  });
  assert.deepEqual(response.subject, { reference: "Patient/patient-a" });
  assert.equal(response.questionnaire, "#questionnaire");
  assert.equal(response.contained[0].id, "questionnaire");
  assert.equal(response.contained[0].item[1].type, "coding");
  assert.equal(response.item.length, 9);
  assert.deepEqual(response.item[0].answer, [
    { valueCoding: { code: "2", display: "More than half the days" } },
  ]);
  assert.equal(sampleQuestionnaires[0].item[1].type, "choice");
  assert.throws(
    () => questionnaireResponse(sampleQuestionnaires[0], {}, context),
    /required/,
  );
  assert.throws(
    () =>
      questionnaireResponse(
        sampleQuestionnaires[0],
        { ...answers, q1: "99" },
        context,
      ),
    /valid answer/,
  );
});

test("QuestionnaireResponse preserves nested groups, typed values and child answers", () => {
  const questionnaire = {
    resourceType: "Questionnaire",
    status: "active",
    item: [
      {
        linkId: "group",
        type: "group",
        item: [
          { linkId: "number", type: "integer", required: true },
          {
            linkId: "parent",
            type: "boolean",
            item: [{ linkId: "child", type: "text" }],
          },
        ],
      },
    ],
  };
  const response = questionnaireResponse(
    questionnaire,
    { number: "4", parent: "false", child: "Detail" },
    context,
  );
  assert.equal(response.item[0].item[0].answer[0].valueInteger, 4);
  assert.equal(response.item[0].item[1].answer[0].valueBoolean, false);
  assert.equal(
    response.item[0].item[1].answer[0].item[0].answer[0].valueString,
    "Detail",
  );
  assert.equal(response.item[0].item[1].item, undefined);
  assert.throws(
    () => questionnaireResponse(questionnaire, { number: "1.5" }, context),
    /valid integer/,
  );
  assert.throws(
    () =>
      questionnaireFields({
        resourceType: "Questionnaire",
        item: [{ linkId: "a", type: "string", enableWhen: [{}] }],
      }),
    /basic forms only/,
  );
});

test("read-only initial values and selected choices are visible and survive saving", () => {
  const questionnaire = {
    resourceType: "Questionnaire",
    status: "active",
    item: [
      {
        linkId: "zero",
        text: "Initial number",
        type: "integer",
        required: true,
        readOnly: true,
        initial: [{ valueInteger: 0 }],
      },
      {
        linkId: "false",
        text: "Initial boolean",
        type: "boolean",
        required: true,
        readOnly: true,
        initial: [{ valueBoolean: false }],
      },
      {
        linkId: "choice",
        text: "Initial choice",
        type: "choice",
        required: true,
        readOnly: true,
        answerOption: [
          {
            valueCoding: { code: "a", display: "Alpha" },
            initialSelected: true,
          },
          { valueCoding: { code: "b", display: "Beta" } },
        ],
      },
    ],
  };
  const fields = questionnaireFields(questionnaire);
  assert.deepEqual(
    fields.map((field) => field.initial),
    ["0", "false", "0"],
  );
  const response = questionnaireResponse(questionnaire, {}, context);
  assert.deepEqual(
    response.item.map((item) => item.answer),
    [
      [{ valueInteger: 0 }],
      [{ valueBoolean: false }],
      [{ valueCoding: { code: "a", display: "Alpha" } }],
    ],
  );
  assert.throws(
    () =>
      questionnaireFields({
        resourceType: "Questionnaire",
        item: [
          {
            linkId: "calculated",
            type: "integer",
            required: true,
            readOnly: true,
          },
        ],
      }),
    /calculated answer/,
  );
  assert.throws(
    () =>
      questionnaireFields({
        resourceType: "Questionnaire",
        item: [
          {
            linkId: "unsupported",
            type: "string",
            readOnly: true,
            initial: [{ valueQuantity: { value: 1 } }],
          },
        ],
      }),
    /Unsupported initial answer/,
  );
  assert.throws(
    () =>
      questionnaireFields({
        resourceType: "Questionnaire",
        item: [
          {
            linkId: "unsupported",
            type: "integer",
            readOnly: true,
            initial: [{ valueInteger: "hidden string" }],
          },
        ],
      }),
    /Invalid initial number/,
  );
});

test("presentation returns FHIR data as text without synthesizing findings", () => {
  assert.equal(
    summarize({ resourceType: "Condition", code: { text: "<img src=x>" } })
      .title,
    "<img src=x>",
  );
  assert.equal(
    summarize({
      resourceType: "Observation",
      code: { text: "Temperature" },
      valueQuantity: { value: 36.8, unit: "°C" },
    }).detail,
    "36.8 °C",
  );
  assert.equal(summarize({ resourceType: "Observation" }).detail, "");
});
