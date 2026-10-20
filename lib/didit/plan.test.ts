import { test } from "node:test";
import assert from "node:assert/strict";
import type { Field, FieldReview, FormDefinition, LocalizedText } from "../forms/definition.ts";
import { checksReading, isBackSide, planDiditTasks, textAnswer, type DiditTask } from "./plan.ts";

// Recorte del "FORMULARIO DE REGISTRO PARA EMPRESAS" real (importado de Google
// Forms): keys `q_…`, anverso/reverso distinguibles solo por la etiqueta y
// ramas por tipo de empresa. Mismo orden de secciones que el original.
const ID: FieldReview = { provider: "didit", feature: "id_verification" };
const POA: FieldReview = { provider: "didit", feature: "proof_of_address" };

const file = (key: string, label: LocalizedText, review?: FieldReview): Field => ({
  id: key,
  key,
  type: "file",
  label,
  required: false,
  file: { accept: [], multiple: false, maxSizeMB: 15 },
  ...(review ? { review } : {}),
});
const choice = (key: string, values: string[]): Field => ({
  id: key,
  key,
  type: "single_choice",
  label: key,
  required: true,
  options: values.map((v) => ({ value: v, label: v })),
});
const text = (key: string, review?: FieldReview): Field => ({
  id: key,
  key,
  type: "short_text",
  label: key,
  required: false,
  ...(review ? { review } : {}),
});
const front = (key: string) => file(key, "DOCUMENTO DE IDENTIDAD (ANVERSO)", ID);
const back = (key: string) => file(key, "DOCUMENTO DE IDENTIDAD (REVERSO)", ID);

const FORM: FormDefinition = {
  version: 1,
  title: "FORMULARIO DE REGISTRO PARA EMPRESAS",
  locales: ["es", "en"],
  defaultLocale: "es",
  sections: [
    {
      id: "section_inicio",
      title: "Inicio",
      fields: [text("q_2029245471")],
      defaultGoTo: "section_docs",
    },
    {
      id: "section_docs",
      title: "DOCUMENTACIÓN BÁSICA",
      fields: [
        choice("q_1834360375", ["Unipersonal", "Sociedad de responsabilidad limitada (S.R.L.)"]),
        file("q_871306237", "Comprobante de domicilio", POA),
      ],
      next: [
        { when: { field: "q_1834360375", op: "eq", value: "Unipersonal" }, goTo: "section_uni" },
      ],
      defaultGoTo: "section_socios",
    },
    {
      id: "section_uni",
      title: "EMPRESA UNIPERSONAL",
      fields: [front("q_1139987339"), back("q_303089462")],
      // En el original apunta a una sección que no existe: termina el formulario.
      defaultGoTo: "section_1327859224",
    },
    {
      id: "section_socios",
      title: "EMPRESA CON DOS SOCIOS",
      fields: [
        front("q_1453350424"),
        back("q_1124275386"),
        front("q_957664702"),
        back("q_1019901945"),
        choice("q_508440594", ["Si", "No"]),
      ],
      next: [
        { when: { field: "q_508440594", op: "eq", value: "Si" }, goTo: "section_complementaria" },
      ],
      defaultGoTo: "section_rep",
    },
    {
      id: "section_rep",
      title: "INFORMACIÓN DEL REPRESENTANTE LEGAL",
      fields: [front("q_1683166302"), back("q_1704898099")],
      defaultGoTo: "section_complementaria",
    },
    {
      id: "section_complementaria",
      title: "DOCUMENTACIÓN COMPLEMENTARIA",
      fields: [file("q_1837356140", "TESTIMONIO DE CONSTITUCIÓN")],
      defaultGoTo: "SUBMIT",
    },
  ],
};

const up = (name: string) => [{ path: `req-1/${name}`, filename: name }];
const idTasks = (tasks: DiditTask[]) =>
  tasks
    .filter((t) => t.feature === "id_verification")
    .map((t) => ({
      fieldKey: t.fieldKey,
      front: t.front.filename,
      back: t.back?.filename ?? null,
    }));

test("unipersonal (caso public:bc310017): solo su documento y el comprobante, nada de socios ni representante", () => {
  const { tasks, skipped } = planDiditTasks(FORM, {
    q_2029245471: "Pythas Holdings LLC",
    q_1834360375: "Unipersonal",
    q_871306237: up("poa.pdf"),
    q_1139987339: up("front.pdf"),
    q_303089462: up("back.pdf"),
  });

  assert.deepEqual(idTasks(tasks), [
    { fieldKey: "q_1139987339", front: "front.pdf", back: "back.pdf" },
  ]);
  assert.deepEqual(
    tasks.filter((t) => t.feature === "proof_of_address").map((t) => t.fieldKey),
    ["q_871306237"],
  );
  assert.equal(tasks.length, 2);
  assert.deepEqual(
    skipped.map((s) => [s.fieldKey, s.reason]),
    [
      ["q_1453350424", "not_reached"],
      ["q_1124275386", "not_reached"],
      ["q_957664702", "not_reached"],
      ["q_1019901945", "not_reached"],
      ["q_1683166302", "not_reached"],
      ["q_1704898099", "not_reached"],
    ],
  );
});

test("dos socios: un documento por persona, cada uno con su reverso", () => {
  const { tasks } = planDiditTasks(FORM, {
    q_1834360375: "Sociedad de responsabilidad limitada (S.R.L.)",
    q_871306237: up("poa.pdf"),
    q_1453350424: up("s1-front.pdf"),
    q_1124275386: up("s1-back.pdf"),
    q_957664702: up("s2-front.pdf"),
    q_1019901945: up("s2-back.pdf"),
    q_508440594: "Si",
  });

  assert.deepEqual(idTasks(tasks), [
    { fieldKey: "q_1453350424", front: "s1-front.pdf", back: "s1-back.pdf" },
    { fieldKey: "q_957664702", front: "s2-front.pdf", back: "s2-back.pdf" },
  ]);
});

test("documento opcional sin subir en una sección recorrida: sin tarea (no_input)", () => {
  const { tasks, skipped } = planDiditTasks(FORM, {
    q_1834360375: "Sociedad de responsabilidad limitada (S.R.L.)",
    q_871306237: up("poa.pdf"),
    q_1453350424: up("s1-front.pdf"),
    q_508440594: "No", // → sección del representante, que no sube documento
  });

  assert.deepEqual(idTasks(tasks), [
    { fieldKey: "q_1453350424", front: "s1-front.pdf", back: null },
  ]);
  const noInput = skipped.filter((s) => s.reason === "no_input").map((s) => s.fieldKey);
  assert.deepEqual(noInput, ["q_957664702", "q_1683166302"]);
});

test("respuestas sin podar (rama abandonada en un autosave): sus archivos nunca van a DIDIT", () => {
  // Llenó socios y representante, luego cambió a Unipersonal. El autosave
  // conserva esos archivos; una re-ejecución forzada no debe mandarlos.
  const { tasks } = planDiditTasks(FORM, {
    q_1834360375: "Unipersonal",
    q_871306237: up("poa.pdf"),
    q_1139987339: up("front.pdf"),
    q_1453350424: up("s1-front.pdf"),
    q_1124275386: up("s1-back.pdf"),
    q_957664702: up("s2-front.pdf"),
    q_508440594: "No",
    q_1683166302: up("rep-front.pdf"),
  });

  assert.deepEqual(idTasks(tasks), [
    { fieldKey: "q_1139987339", front: "front.pdf", back: null },
  ]);
});

test("sin respuestas a DIDIT no sale ninguna tarea", () => {
  const { tasks } = planDiditTasks(FORM, { q_1834360375: "Unipersonal" });
  assert.deepEqual(tasks, []);
});

test("database_validation sin número personal: sin tarea", () => {
  const def: FormDefinition = {
    version: 1,
    title: "t",
    locales: ["es"],
    defaultLocale: "es",
    sections: [
      {
        id: "s",
        title: "s",
        fields: [
          text("didit_db_first_name", { provider: "didit", feature: "database_validation" }),
          text("didit_db_personal_number"),
          text("didit_db_issuing_state"),
        ],
      },
    ],
  };

  const empty = planDiditTasks(def, { didit_db_first_name: "Boris" });
  assert.deepEqual(empty.tasks, []);
  assert.deepEqual(empty.skipped, [
    { feature: "database_validation", fieldKey: "didit_db_first_name", reason: "no_input" },
  ]);

  const full = planDiditTasks(def, {
    didit_db_first_name: "Boris",
    didit_db_personal_number: "1234567",
    didit_db_issuing_state: "BO",
  });
  assert.deepEqual(full.tasks, [
    {
      feature: "database_validation",
      fieldKey: "didit_db_first_name",
      body: { first_name: "Boris", personal_number: "1234567", issuing_state: "BO" },
    },
  ]);
});

test("reverso sin anverso previo en su sección: se omite (orphan_back)", () => {
  const def: FormDefinition = {
    ...FORM,
    sections: [{ id: "s", title: "s", fields: [back("q_b"), front("q_f")] }],
  };
  const { tasks, skipped } = planDiditTasks(def, { q_b: up("b.pdf"), q_f: up("f.pdf") });
  assert.deepEqual(idTasks(tasks), [{ fieldKey: "q_f", front: "f.pdf", back: null }]);
  assert.deepEqual(skipped, [
    { feature: "id_verification", fieldKey: "q_b", reason: "orphan_back" },
  ]);
});

test("isBackSide: key histórica o etiqueta; la mención al anverso gana", () => {
  assert.equal(isBackSide(back("q_303089462")), true);
  assert.equal(isBackSide(front("q_1139987339")), false);
  assert.equal(isBackSide(file("id_back", "Documento", ID)), true);
  assert.equal(isBackSide(file("q_1", "Parte posterior del documento", ID)), true);
  assert.equal(isBackSide(file("q_2", { es: "Reverso", en: "Back side" }, ID)), true);
  assert.equal(isBackSide(file("q_3", "Anverso (el reverso va en la siguiente pregunta)", ID)), false);
  assert.equal(isBackSide(file("q_4", "Feedback del cliente", ID)), false);
});

test("textAnswer lee números (campo `number` coaccionado por Zod)", () => {
  assert.equal(textAnswer({ m: 24000000439 }, "m"), "24000000439");
  assert.equal(textAnswer({ m: "  ABC-1 " }, "m"), "ABC-1");
  assert.equal(textAnswer({ m: Number.NaN }, "m"), "");
  assert.equal(textAnswer({}, "m"), "");
});

// ------------------------------------------------------------
// AML con datos explícitos (`review.aml`) y correcciones
// ------------------------------------------------------------
const country = (key: string): Field => ({ id: key, key, type: "country", label: key, required: false });
const date = (key: string): Field => ({ id: key, key, type: "date", label: key, required: false });

const AML_FORM: FormDefinition = {
  version: 1,
  title: "KYB",
  locales: ["es"],
  defaultLocale: "es",
  sections: [
    {
      id: "empresa",
      title: "Empresa",
      fields: [
        text("company_legal_name", {
          provider: "didit",
          feature: "kyb_registry",
          aml: { entityType: "company", dobKey: "company_incorporation_date" },
        }),
        date("company_incorporation_date"),
        country("company_country"),
      ],
    },
    {
      id: "socio_1",
      title: "Socio 1",
      fields: [
        text("p1_first_names", {
          provider: "didit",
          feature: "aml_screening",
          aml: {
            entityType: "person",
            nameKeys: ["p1_first_names", "p1_last_names"],
            dobKey: "p1_birth_date",
            nationalityKey: "p1_nationality",
            documentKey: "p1_doc_number",
          },
        }),
        text("p1_last_names"),
        date("p1_birth_date"),
        country("p1_nationality"),
        text("p1_doc_number"),
        front("p1_id_front"),
        back("p1_id_back"),
      ],
    },
  ],
};

const AML_ANSWERS = {
  company_legal_name: "Pythas Holdings S.R.L.",
  company_incorporation_date: "2019-03-01",
  company_country: "BOL",
  p1_first_names: "Juan  Carlos",
  p1_last_names: "Pérez Rojas",
  p1_birth_date: "1980-05-02",
  p1_nationality: "BOL",
  p1_doc_number: "1234567",
  p1_id_front: up("ci-front.jpg"),
  p1_id_back: up("ci-back.jpg"),
};

const amlBodies = (tasks: DiditTask[]) =>
  Object.fromEntries(
    tasks.flatMap((t) => (t.feature === "aml_screening" ? [[t.fieldKey, t.body]] : [])),
  );

test("review.aml de persona: nombre con nombres y apellidos, nacionalidad en alpha-2", () => {
  const { tasks } = planDiditTasks(AML_FORM, AML_ANSWERS);
  assert.deepEqual(amlBodies(tasks).p1_first_names, {
    full_name: "Juan Carlos Pérez Rojas",
    entity_type: "person",
    date_of_birth: "1980-05-02",
    nationality: "BO",
    document_number: "1234567",
  });
});

test("razón social con kyb_registry + aml: corre el AML de la empresa, sin datos de persona", () => {
  const { tasks } = planDiditTasks(AML_FORM, AML_ANSWERS);
  assert.deepEqual(amlBodies(tasks).company_legal_name, {
    full_name: "Pythas Holdings S.R.L.",
    entity_type: "company",
    date_of_birth: "2019-03-01",
  });
  // El registro mercantil sigue siendo manual: no sale como tarea.
  assert.equal(tasks.some((t) => (t.feature as string) === "kyb_registry"), false);
});

test("review.aml sin nombre: no_input; razón social no recorrida: not_reached", () => {
  const noName = planDiditTasks(AML_FORM, { ...AML_ANSWERS, p1_first_names: "", p1_last_names: "" });
  assert.ok(
    noName.skipped.some(
      (s) => s.feature === "aml_screening" && s.fieldKey === "p1_first_names" && s.reason === "no_input",
    ),
  );

  const hidden: FormDefinition = {
    ...AML_FORM,
    sections: [
      { ...AML_FORM.sections[0], visibleIf: { field: "nunca", op: "eq", value: "x" } },
      AML_FORM.sections[1],
    ],
  };
  const { tasks, skipped } = planDiditTasks(hidden, AML_ANSWERS);
  assert.equal(amlBodies(tasks).company_legal_name, undefined);
  assert.ok(
    skipped.some(
      (s) => s.feature === "aml_screening" && s.fieldKey === "company_legal_name" && s.reason === "not_reached",
    ),
  );
});

test("inputs: cada tarea dice qué preguntas leyó", () => {
  const { inputs } = planDiditTasks(AML_FORM, AML_ANSWERS);
  assert.deepEqual(inputs["id_verification:p1_id_front"], ["p1_id_front", "p1_id_back"]);
  assert.deepEqual(inputs["aml_screening:p1_first_names"].sort(), [
    "p1_birth_date",
    "p1_doc_number",
    "p1_first_names",
    "p1_last_names",
    "p1_nationality",
  ]);
  assert.deepEqual(inputs["aml_screening:company_legal_name"].sort(), [
    "company_incorporation_date",
    "company_legal_name",
  ]);
});

test("checksReading: corregir el apellido o el reverso deja viejos el AML y el CI", () => {
  const plan = planDiditTasks(AML_FORM, AML_ANSWERS);
  assert.deepEqual(checksReading(plan, ["p1_last_names"]), ["aml_screening:p1_first_names"]);
  assert.deepEqual(checksReading(plan, ["p1_id_back"]), ["id_verification:p1_id_front"]);
  assert.deepEqual(checksReading(plan, ["company_incorporation_date"]), [
    "aml_screening:company_legal_name",
  ]);
  assert.deepEqual(checksReading(plan, ["company_country"]), []);
});

test("AML por convención de key: inputs con las hermanas que leyó", () => {
  const def: FormDefinition = {
    version: 1,
    title: "t",
    locales: ["es"],
    defaultLocale: "es",
    sections: [
      {
        id: "s",
        title: "s",
        fields: [
          text("rep_full_name", { provider: "didit", feature: "aml_screening" }),
          text("rep_date_of_birth"),
          text("rep_nationality"),
        ],
      },
    ],
  };
  const plan = planDiditTasks(def, { rep_full_name: "Ana", rep_date_of_birth: "1990-01-01" });
  assert.deepEqual(amlBodies(plan.tasks).rep_full_name, { full_name: "Ana", date_of_birth: "1990-01-01" });
  assert.deepEqual(plan.inputs["aml_screening:rep_full_name"], ["rep_full_name", "rep_date_of_birth"]);
});
