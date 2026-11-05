// @ts-check
import { startSmart, FhirClient } from "./smart.js";
import {
  VIEWS,
  CREATE_FIELDS,
  patientName,
  summarize,
  patientQuery,
  createResource,
  validatePatientResource,
  questionnaireFields,
  questionnaireResponse,
  sampleQuestionnaires,
  object,
  array,
  string,
  concept,
} from "./clinical.js";

/** @typedef {import('../../types.js').FhirResource} FhirResource */
/** @typedef {import('../../types.js').FhirBundle} FhirBundle */
/** @typedef {import('../../types.js').SmartSession} SmartSession */
/** @typedef {import('../../types.js').ViewDefinition} ViewDefinition */

/** @template {keyof HTMLElementTagNameMap} K
 * @param {K} tag @param {string} [className] @param {string} [text]
 * @returns {HTMLElementTagNameMap[K]} */
function element(tag, className = "", text = "") {
  const result = document.createElement(tag);
  result.className = className;
  if (text) result.textContent = text;
  return result;
}
/** @param {string} id @returns {HTMLElement} */
function requiredElement(id) {
  const result = document.getElementById(id);
  if (!result) throw Error(`Missing application element: ${id}`);
  return result;
}
/** @param {unknown} error */
function errorMessage(error) {
  return error instanceof Error
    ? error.message
    : "The request could not be completed.";
}
/** @param {string} text @param {() => void} action @param {string} [className] */
function button(text, action, className = "") {
  const result = element("button", className, text);
  result.type = "button";
  result.addEventListener("click", action);
  return result;
}
/** @param {FhirBundle} bundle @returns {FhirResource[]} */
function resources(bundle) {
  return (bundle.entry || []).flatMap((entry) =>
    entry.resource ? [entry.resource] : [],
  );
}
/** @param {string} title @param {string} [description] */
function heading(title, description = "") {
  const result = element("div", "page-heading");
  const copy = element("div");
  copy.append(element("h2", "", title));
  if (description) copy.append(element("p", "", description));
  result.append(copy);
  return result;
}
/** @param {string} title */
function card(title) {
  const result = element("section", "card");
  const header = element("div", "card-heading");
  header.append(element("h3", "", title));
  result.append(header);
  return result;
}

try {
  const session = await startSmart();
  if (session) await runApplication(session);
  else
    requiredElement("launch-message").textContent =
      "Launch from a sandbox in FHIR Studio to select a patient and authorize this app.";
} catch (error) {
  requiredElement("launch-message").textContent = errorMessage(error);
  requiredElement("launch-message").setAttribute("role", "alert");
  requiredElement("launch-message").classList.add("error");
}

/** @param {SmartSession} session */
async function runApplication(session) {
  const client = new FhirClient(session);
  if (!session.patient)
    throw Error(
      "No launch patient was provided. Launch again from FHIR Studio with a patient selected.",
    );
  let patient = await client.read("Patient", session.patient);
  const patientId = session.patient;
  const context = {
    patientId,
    encounterId: session.encounter,
    fhirVersion: client.fhirVersion,
  };
  let activeView = "summary";
  let generation = 0;
  /** @type {{message:string,time:Date}[]} */
  const activity = [];
  /** @type {(() => Promise<void>) | null} */
  let submitDialog = null;
  const content = requiredElement("content");
  const notice = requiredElement("notice");
  const dialog = /** @type {HTMLDialogElement} */ (
    requiredElement("editor-dialog")
  );
  const dialogForm = /** @type {HTMLFormElement} */ (
    requiredElement("editor-form")
  );
  const editorFields = requiredElement("editor-fields");
  const editorError = requiredElement("editor-error");
  const saveButton = /** @type {HTMLButtonElement} */ (
    requiredElement("save-resource")
  );
  const studioLink = /** @type {HTMLAnchorElement} */ (
    requiredElement("studio-link")
  );
  studioLink.href = session.studioOrigin;
  requiredElement("launch-screen").hidden = true;
  requiredElement("application").hidden = false;
  requiredElement("connection-label").textContent =
    `${client.fhirVersion} · SMART connected`;
  function refreshPatientBanner() {
    requiredElement("patient-name").textContent = patientName(patient);
    requiredElement("patient-initials").textContent = patientName(patient)
      .split(/[\s,]+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0])
      .join("")
      .toUpperCase();
    const identifier = object(array(patient.identifier)[0]);
    requiredElement("patient-details").textContent = [
      string(patient.birthDate),
      string(patient.gender),
      string(identifier.value)
        ? `Identifier ${string(identifier.value)}`
        : `Patient/${patientId}`,
    ]
      .filter(Boolean)
      .join(" · ");
  }
  refreshPatientBanner();
  requiredElement("encounter-context").textContent = session.encounter
    ? `Encounter/${session.encounter}`
    : "No encounter supplied";
  requiredElement("end-session").addEventListener("click", () => {
    session.accessToken = "";
    generation++;
    dialog.close();
    requiredElement("application").hidden = true;
    requiredElement("launch-screen").hidden = false;
    requiredElement("launch-message").textContent =
      "App session ended. Launch again from FHIR Studio to continue.";
    content.replaceChildren();
  });
  if (session.encounter)
    void client
      .read("Encounter", session.encounter)
      .then((encounter) => {
        requiredElement("encounter-context").textContent =
          `Encounter: ${summarize(encounter).title} · ${string(encounter.status)}`;
      })
      .catch(() => {
        /* Launch context remains visible when encounter access is denied. */
      });

  /** @param {string} message */
  function record(message) {
    activity.unshift({ message, time: new Date() });
    if (activity.length > 100) activity.pop();
  }
  /** @param {string} message */
  function notify(message) {
    notice.replaceChildren(
      element("span", "", message),
      button(
        "Dismiss",
        () => {
          notice.hidden = true;
        },
        "quiet",
      ),
    );
    notice.hidden = false;
  }
  /** @param {string} title @param {string} description @param {(() => Promise<void>) | null} submit */
  function openDialog(title, description, submit) {
    requiredElement("editor-title").textContent = title;
    requiredElement("editor-description").textContent = description;
    editorFields.replaceChildren();
    editorError.hidden = true;
    editorError.textContent = "";
    submitDialog = submit;
    saveButton.hidden = !submit;
    saveButton.disabled = false;
    dialog.showModal();
  }
  requiredElement("close-dialog").addEventListener("click", () =>
    dialog.close(),
  );
  requiredElement("cancel-dialog").addEventListener("click", () =>
    dialog.close(),
  );
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) dialog.close();
  });
  dialogForm.addEventListener("submit", (event) => {
    event.preventDefault();
    if (!submitDialog || saveButton.disabled) return;
    saveButton.disabled = true;
    editorError.hidden = true;
    void submitDialog()
      .then(() => {
        dialog.close();
        void navigate(activeView);
      })
      .catch((error) => {
        editorError.textContent = errorMessage(error);
        editorError.hidden = false;
      })
      .finally(() => {
        saveButton.disabled = false;
      });
  });

  /** @param {FhirResource} resource @param {boolean} [editable] */
  function inspect(resource, editable = false) {
    const textarea = element("textarea");
    textarea.value = JSON.stringify(resource, null, 2);
    textarea.readOnly = !editable;
    textarea.spellcheck = false;
    textarea.setAttribute("aria-label", "FHIR resource JSON");
    openDialog(
      `${editable ? "Edit" : "Inspect"} ${resource.resourceType}`,
      editable
        ? "Changes update this resource in the selected sandbox. Keep its resource type, ID, and launch-patient references unchanged."
        : "FHIR JSON from the selected sandbox. Narrative HTML is displayed as text.",
      editable
        ? async () => {
            const parsed = /** @type {unknown} */ (JSON.parse(textarea.value));
            const candidate = object(parsed);
            if (
              candidate.resourceType !== resource.resourceType ||
              candidate.id !== resource.id
            )
              throw Error("Resource type and ID must remain unchanged.");
            const updated = /** @type {FhirResource} */ (candidate);
            // Retain the version that was actually read, even if edited JSON removes it.
            updated.meta = {
              ...object(updated.meta),
              versionId: object(resource.meta).versionId,
            };
            validatePatientResource(updated, patientId, session.issuer);
            const saved = await client.update(updated);
            if (resource.resourceType === "Patient") {
              patient = saved;
              refreshPatientBanner();
            }
            record(`Updated ${resource.resourceType}/${resource.id}`);
            notify(`${resource.resourceType} saved to the sandbox.`);
          }
        : null,
    );
    if (resource.resourceType === "DocumentReference") {
      for (const entry of array(resource.content)) {
        const attachment = object(object(entry).attachment);
        if (
          string(attachment.contentType).split(";")[0].trim().toLowerCase() !==
            "text/plain" ||
          typeof attachment.data !== "string"
        )
          continue;
        try {
          const bytes = Uint8Array.from(atob(attachment.data), (character) =>
            character.charCodeAt(0),
          );
          editorFields.append(
            element("h3", "", string(attachment.title) || "Clinical note"),
            element(
              "pre",
              "",
              new TextDecoder("utf-8", { fatal: true }).decode(bytes),
            ),
          );
        } catch {
          editorFields.append(
            element(
              "p",
              "error",
              "This note attachment could not be decoded as UTF-8 text.",
            ),
          );
        }
      }
    }
    const label = element("label", "field json-field", "FHIR resource JSON");
    label.append(textarea);
    editorFields.append(label);
  }

  /** @param {ViewDefinition} view */
  function create(view) {
    const fields = CREATE_FIELDS[view.resourceType];
    if (!fields) return;
    /** @type {Map<string,HTMLInputElement|HTMLSelectElement|HTMLTextAreaElement>} */
    const controls = new Map();
    openDialog(
      `New ${view.resourceType}`,
      `This record will belong to ${patientName(patient)} in the selected sandbox. Review the details before saving.`,
      async () => {
        const values = Object.fromEntries(
          [...controls].map(([key, control]) => [key, control.value]),
        );
        const resource = createResource(view.resourceType, values, context);
        validatePatientResource(resource, patientId);
        await client.create(resource);
        record(`Created ${view.resourceType}`);
        notify(`${view.resourceType} saved to the sandbox.`);
      },
    );
    const grid = element("div", "form-grid");
    for (const field of fields) {
      const label = element(
        "label",
        "field",
        `${field.label}${field.required ? " *" : ""}`,
      );
      let input;
      if (field.type === "textarea") input = element("textarea");
      else if (field.type === "select") {
        input = element("select");
        for (const option of field.options || [])
          input.append(new Option(option.replaceAll("-", " "), option));
      } else {
        input = element("input");
        input.type = field.type;
        if (field.type === "number") input.step = "any";
      }
      if (
        field.name === "category" &&
        view.filters?.category &&
        field.options?.includes(view.filters.category)
      )
        input.value = view.filters.category;
      input.name = field.name;
      input.required = field.required || false;
      controls.set(field.name, input);
      label.append(input);
      grid.append(label);
    }
    editorFields.append(grid);
  }

  /** @param {FhirResource} questionnaire */
  function openQuestionnaire(questionnaire) {
    let fields;
    try {
      fields = questionnaireFields(questionnaire);
    } catch (error) {
      notify(errorMessage(error));
      inspect(questionnaire);
      return;
    }
    /** @type {Map<string,HTMLInputElement|HTMLSelectElement|HTMLTextAreaElement>} */
    const controls = new Map();
    openDialog(
      string(questionnaire.title) || "Questionnaire",
      string(questionnaire.description) ||
        "Answers are saved as a QuestionnaireResponse. This example does not calculate scores or make clinical recommendations.",
      async () => {
        const answers = Object.fromEntries(
          [...controls].map(([key, control]) => [key, control.value]),
        );
        const response = questionnaireResponse(questionnaire, answers, context);
        validatePatientResource(response, patientId);
        await client.create(response);
        record("Saved QuestionnaireResponse");
        notify("Questionnaire response saved to the selected sandbox.");
      },
    );
    for (const field of fields) {
      if (field.type === "display" || field.type === "group") {
        editorFields.append(
          element(
            field.type === "group" ? "h3" : "p",
            "form-intro",
            field.text,
          ),
        );
        continue;
      }
      const label = element(
        "label",
        "field",
        `${field.text}${field.required ? " *" : ""}`,
      );
      let input;
      if (field.options || field.type === "boolean") {
        input = element("select");
        input.append(new Option("Select an answer", ""));
        if (field.type === "boolean")
          input.append(new Option("Yes", "true"), new Option("No", "false"));
        else
          for (const option of field.options || [])
            input.append(new Option(option.label, option.value));
      } else if (field.type === "text") input = element("textarea");
      else {
        input = element("input");
        input.type =
          field.type === "integer" || field.type === "decimal"
            ? "number"
            : field.type === "date"
              ? "date"
              : field.type === "dateTime"
                ? "datetime-local"
                : field.type === "time"
                  ? "time"
                  : field.type === "url"
                    ? "url"
                    : "text";
        if (input.type === "number")
          input.step = field.type === "integer" ? "1" : "any";
      }
      input.value = field.initial ?? "";
      input.name = field.linkId;
      input.required = field.required;
      input.disabled = field.readOnly;
      controls.set(field.linkId, input);
      label.append(input);
      editorFields.append(label);
    }
    if (!client.can("QuestionnaireResponse", "c")) {
      saveButton.disabled = true;
      editorFields.prepend(
        element(
          "p",
          "info",
          "This SMART grant does not allow creating QuestionnaireResponse resources. Relaunch with write permission to save answers.",
        ),
      );
    }
  }

  const groups = [
    { title: "Workspace", ids: ["dashboard", "summary"] },
    { title: "Clinical workflows", ids: VIEWS.map((view) => view.id) },
    {
      title: "Review & forms",
      ids: ["cds", "population", "forms", "studio", "fhir"],
    },
  ];
  /** @type {Record<string,{label:string,description:string}>} */
  const customViews = {
    dashboard: {
      label: "Dashboard",
      description: "A live overview of the launch patient’s chart.",
    },
    summary: {
      label: "Patient summary",
      description:
        "Patient demographics and clinical records from the selected sandbox.",
    },
    cds: {
      label: "Clinical decision support",
      description:
        "Review the launch patient’s allergies, conditions, medications, and clinical impressions.",
    },
    population: {
      label: "Population health",
      description:
        "Review available care plans and quality reports for the current launch patient.",
    },
    forms: {
      label: "Forms & questionnaires",
      description:
        "Complete a bundled example form or a supported Questionnaire from the sandbox.",
    },
    studio: {
      label: "SMART app launcher",
      description:
        "Launch other registered SMART apps or select a different patient through FHIR Studio.",
    },
    fhir: {
      label: "FHIR & request history",
      description: "Inspect this app’s SMART connection and recent operations.",
    },
  };
  const navigation = requiredElement("navigation");
  const seenIds = new Set();
  for (const group of groups) {
    const section = element("div");
    section.append(element("p", "nav-group-title", group.title));
    for (const id of group.ids) {
      if (seenIds.has(id)) continue;
      seenIds.add(id);
      const definition = VIEWS.find((view) => view.id === id);
      const label = customViews[id]?.label || definition?.label || id;
      const item = button(
        label,
        () => {
          void navigate(id);
        },
        "nav-button",
      );
      item.dataset.view = id;
      const icon = element(
        "span",
        "nav-icon",
        id === "summary" ? "◉" : id === "forms" ? "▤" : "◇",
      );
      icon.setAttribute("aria-hidden", "true");
      item.prepend(icon);
      section.append(item);
    }
    navigation.append(section);
  }
  requiredElement("nav-filter").addEventListener("input", (event) => {
    const query = /** @type {HTMLInputElement} */ (
      event.target
    ).value.toLowerCase();
    for (const item of navigation.querySelectorAll("button"))
      item.hidden = !item.textContent?.toLowerCase().includes(query);
  });

  /** @param {string} id */
  async function navigate(id) {
    activeView = id;
    const current = ++generation;
    for (const item of navigation.querySelectorAll("button")) {
      const active = item.dataset.view === id;
      item.classList.toggle("active", active);
      if (active) item.setAttribute("aria-current", "page");
      else item.removeAttribute("aria-current");
    }
    content.replaceChildren();
    const custom = customViews[id];
    const view = VIEWS.find((definition) => definition.id === id);
    content.append(
      heading(
        custom?.label || view?.label || id,
        custom?.description || view?.description || "",
      ),
    );
    if (custom) {
      if (id === "summary") {
        renderDemographics();
        await sections(
          ["Condition", "AllergyIntolerance", "MedicationRequest", "Encounter"],
          current,
        );
      } else if (id === "dashboard") {
        content.append(
          element(
            "p",
            "info",
            "This app uses the SMART launch patient. Counts and lists describe that patient only; no whole-sandbox or provider-panel totals are inferred.",
          ),
        );
        await sections(
          ["Appointment", "Task", "Communication", "ServiceRequest"],
          current,
        );
      } else if (id === "cds") {
        content.append(
          element(
            "p",
            "info",
            "This static example does not run a CDS Hooks service or calculate treatment recommendations. Clinical impressions and chart review remain available below. Configure and test CDS services in FHIR Studio.",
          ),
        );
        await sections(
          [
            "ClinicalImpression",
            "AllergyIntolerance",
            "Condition",
            "MedicationRequest",
          ],
          current,
        );
      } else if (id === "population") {
        content.append(
          element(
            "p",
            "info",
            "SMART authorization is limited to the launch patient. Population-wide dashboards require a separately registered application with appropriate user-level scopes. Available patient-level plans and quality reports appear here.",
          ),
        );
        await sections(["CarePlan", "MeasureReport"], current);
      } else if (id === "forms") await renderForms(current);
      else if (id === "studio") renderStudio();
      else if (id === "fhir") renderConnection();
    } else if (view) await renderResourceSection(view, content, current);
  }

  function renderDemographics() {
    const section = card("Demographics & registration");
    const list = element("dl", "data-list");
    const address = object(array(patient.address)[0]);
    const telecom = array(patient.telecom)
      .map((value) => {
        const contact = object(value);
        return [string(contact.system), string(contact.value)]
          .filter(Boolean)
          .join(": ");
      })
      .join(" · ");
    const rows = [
      ["Name", patientName(patient)],
      ["Date of birth", string(patient.birthDate)],
      ["Administrative gender", string(patient.gender)],
      [
        "Identifiers",
        array(patient.identifier)
          .map((value) => {
            const identifier = object(value);
            return [string(identifier.system), string(identifier.value)]
              .filter(Boolean)
              .join(" · ");
          })
          .join("\n"),
      ],
      ["Contact", telecom],
      [
        "Address",
        [
          ...array(address.line).map(string),
          string(address.city),
          string(address.state),
          string(address.postalCode),
          string(address.country),
        ]
          .filter(Boolean)
          .join(", "),
      ],
      ["Patient resource", `Patient/${patientId}`],
    ];
    for (const [label, value] of rows)
      list.append(
        element("dt", "", label),
        element("dd", "", value || "Not recorded"),
      );
    section.append(list);
    const actions = element("div", "action-list");
    actions.append(button("Inspect Patient", () => inspect(patient)));
    if (client.can("Patient", "u"))
      actions.append(
        button("Edit demographics JSON", () => inspect(patient, true)),
      );
    section.append(actions);
    content.append(section);
  }

  /** @param {string[]} types @param {number} current */
  async function sections(types, current) {
    await Promise.all(
      types.map(async (type) => {
        const definition = VIEWS.find((view) => view.resourceType === type);
        if (!definition) return;
        const wrapper = element("div");
        content.append(wrapper);
        await renderResourceSection(definition, wrapper, current);
      }),
    );
  }

  /** @param {ViewDefinition} view @param {HTMLElement} parent @param {number} current */
  async function renderResourceSection(view, parent, current) {
    const section = card(view.label);
    const header = section.querySelector(".card-heading");
    if (
      header &&
      view.editable &&
      CREATE_FIELDS[view.resourceType] &&
      client.can(view.resourceType, "c")
    )
      header.append(
        button(`New ${view.resourceType}`, () => create(view), "primary"),
      );
    const body = element("div");
    section.append(body);
    parent.append(section);
    if (!client.can(view.resourceType, "s")) {
      body.append(
        element(
          "p",
          "empty",
          `The current SMART grant does not include ${view.resourceType} search. Relaunch with the required permission to use this workflow.`,
        ),
      );
      return;
    }
    body.append(element("p", "loading", `Loading ${view.resourceType}…`));
    /** @type {FhirResource[]} */
    let loaded = [];
    /** @type {string | undefined} */
    let nextUrl;
    /** @type {number | undefined} */
    let total;
    async function load(append = false) {
      try {
        const bundle =
          append && nextUrl
            ? /** @type {FhirBundle} */ (await client.request(nextUrl))
            : await client.search(
                view.resourceType,
                patientQuery(view, patientId),
              );
        if (current !== generation) return;
        const entries = resources(bundle).filter(
          (resource) => resource.resourceType === view.resourceType,
        );
        loaded = append ? [...loaded, ...entries] : entries;
        nextUrl = bundle.link?.find((link) => link.relation === "next")?.url;
        total = bundle.total ?? total;
        record(`Read ${view.resourceType} search (${entries.length} records)`);
        render();
      } catch (error) {
        if (current !== generation) return;
        body.replaceChildren(element("p", "error", errorMessage(error)));
        body.append(
          button("Retry", () => {
            void load(append);
          }),
        );
      }
    }
    function render() {
      body.replaceChildren();
      if (!loaded.length) {
        body.append(
          element(
            "p",
            "empty",
            `No ${view.resourceType} records were returned for this launch patient.`,
          ),
        );
        return;
      }
      const wrap = element("div", "table-wrap");
      const table = element("table");
      const thead = element("thead");
      const tr = element("tr");
      for (const label of ["Record", "Status", "Date", "Details", "Actions"])
        tr.append(element("th", "", label));
      thead.append(tr);
      table.append(thead);
      const tbody = element("tbody");
      for (const resource of loaded) {
        const data = summarize(resource);
        const row = element("tr");
        const title = element("td");
        title.append(
          element("div", "record-title", data.title),
          element("div", "resource-id", resource.id || "No ID"),
        );
        const status = element("td");
        status.append(element("span", "badge", data.status || "Not recorded"));
        const actions = element("td");
        const buttons = element("div", "table-actions");
        buttons.append(button("Inspect", () => inspect(resource)));
        if (resource.id && client.can(resource.resourceType, "u"))
          buttons.append(button("Edit", () => inspect(resource, true)));
        actions.append(buttons);
        row.append(
          title,
          status,
          element("td", "", data.date || "—"),
          element("td", "", data.detail || "—"),
          actions,
        );
        tbody.append(row);
      }
      table.append(tbody);
      wrap.append(table);
      body.append(wrap);
      const pagination = element("div", "pagination");
      pagination.append(
        element(
          "span",
          "",
          `${loaded.length} ${loaded.length === 1 ? "record" : "records"} shown${typeof total === "number" ? ` · ${total} matching ${total === 1 ? "record" : "records"}` : ""}`,
        ),
      );
      if (nextUrl) {
        const more = button("Load more", () => {
          more.disabled = true;
          void load(true);
        });
        pagination.append(more);
      }
      body.append(pagination);
    }
    await load();
  }

  /** @param {number} current */
  async function renderForms(current) {
    content.append(
      element(
        "p",
        "info",
        "Bundled forms are local examples; opening a form does not seed the sandbox. Saving creates a QuestionnaireResponse for the launch patient. These forms do not calculate scores, generate Observations, or provide clinical advice.",
      ),
    );
    const grid = element("div", "cards-grid");
    content.append(grid);
    const renderQuestionnaire = /** @param {FhirResource} questionnaire */ (
      questionnaire,
    ) => {
      const section = card(
        string(questionnaire.title) ||
          string(questionnaire.name) ||
          questionnaire.id ||
          "Questionnaire",
      );
      section.classList.add("questionnaire-card");
      section.append(
        element(
          "p",
          "",
          string(questionnaire.description) ||
            "Questionnaire from the FHIR server’s available catalog.",
        ),
      );
      section.append(
        button("Open form", () => openQuestionnaire(questionnaire), "primary"),
      );
      grid.append(section);
    };
    for (const questionnaire of sampleQuestionnaires)
      renderQuestionnaire({
        ...questionnaire,
        description:
          string(questionnaire.description) ||
          "Bundled example form. Saving creates a patient-linked QuestionnaireResponse in the selected sandbox.",
      });
    const external = card("Available Questionnaires");
    content.append(external);
    if (client.can("Questionnaire", "s")) {
      external.append(
        element(
          "p",
          "loading",
          "Loading the FHIR server’s Questionnaire catalog…",
        ),
      );
      try {
        const bundle = await client.search("Questionnaire", {
          status: "active",
          _count: "30",
        });
        if (current !== generation) return;
        external.querySelector(".loading")?.remove();
        const questionnaires = resources(bundle).filter(
          (resource) => resource.resourceType === "Questionnaire",
        );
        if (!questionnaires.length)
          external.append(
            element("p", "empty", "No active Questionnaires were returned."),
          );
        for (const questionnaire of questionnaires)
          external.append(
            button(
              string(questionnaire.title) ||
                questionnaire.id ||
                "Questionnaire",
              () => openQuestionnaire(questionnaire),
            ),
          );
        if (bundle.link?.some((link) => link.relation === "next"))
          external.append(
            element(
              "p",
              "muted",
              "Showing the first 30 active Questionnaires. Use FHIR Studio to browse the full catalog.",
            ),
          );
      } catch (error) {
        if (current !== generation) return;
        external.replaceChildren(
          element("h3", "", "Available Questionnaires"),
          element("p", "error", errorMessage(error)),
        );
      }
    } else
      external.append(
        element(
          "p",
          "empty",
          "Reading the FHIR server’s Questionnaire catalog requires user/Questionnaire.rs. Bundled examples remain available.",
        ),
      );
    if (current !== generation) return;
    await sections(["QuestionnaireResponse"], current);
  }

  function renderStudio() {
    const section = card("Use FHIR Studio");
    section.append(
      element(
        "p",
        "",
        "Launch other registered SMART applications, select a different patient, and configure CDS Hooks services in FHIR Studio. Each application receives its own standard SMART launch and authorization.",
      ),
    );
    const link = element("a", "", "Open FHIR Studio ↗");
    link.href = session.studioOrigin;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    section.append(link);
    content.append(section);
  }

  function renderConnection() {
    const section = card("SMART connection");
    const list = element("dl", "data-list");
    for (const [label, value] of [
      ["FHIR base", session.issuer],
      ["FHIR version", client.fhirVersion],
      ["Client ID", session.clientId],
      ["Patient context", `Patient/${patientId}`],
      ["Encounter context", session.encounter || "Not supplied"],
      ["Granted scopes", session.scope],
      ["Token expires", new Date(session.expiresAt).toLocaleString()],
    ])
      list.append(element("dt", "", label), element("dd", "", value));
    section.append(list);
    section.append(
      element(
        "p",
        "muted",
        "The access token is kept in browser memory. FHIR requests omit browser credentials and use the SMART bearer token.",
      ),
    );
    content.append(section);
    const history = card("App request history");
    history.append(
      element(
        "p",
        "muted",
        "Recent operations in this browser tab only. This history is temporary and is not the sandbox’s authoritative audit log. No token or patient payload is included.",
      ),
    );
    if (!activity.length)
      history.append(element("p", "empty", "No operations recorded yet."));
    const listHistory = element("ul", "activity");
    for (const entry of activity) {
      const item = element("li", "", entry.message);
      const time = element("time", "", entry.time.toLocaleString());
      time.dateTime = entry.time.toISOString();
      item.append(time);
      listHistory.append(item);
    }
    history.append(listHistory);
    content.append(history);
  }
  record("Opened the authorized launch patient");
  await navigate("summary");
}
