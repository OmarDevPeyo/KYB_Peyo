import { test } from "node:test";
import assert from "node:assert/strict";
import { formDefinitionSchema, type Field } from "../definition.ts";
import { reachableFields, reachableSections } from "../logic.ts";
import { buildZod } from "../validation.ts";
import { planDiditTasks, type DiditTask } from "../../didit/plan.ts";
import {
  GLOBALFLOW_KYB_FORM,
  GLOBALFLOW_KYB_KEY,
  GLOBALFLOW_KYB_VERSION,
  MAX_PARTNERS,
  partnerCountsFor,
} from "./globalflow-kyb.ts";
import { SYSTEM_FORMS, findSystemForm, planSystemFormSync, storedDefinition } from "./index.ts";

const FORM = GLOBALFLOW_KYB_FORM;
const ALL: Field[] = FORM.sections.flatMap((s) => s.fields);
const byKey = new Map(ALL.map((f) => [f.key, f]));

test("la definición pasa el schema y lleva su marca de sistema", () => {
  const parsed = formDefinitionSchema.safeParse(FORM);
  assert.ok(parsed.success, JSON.stringify(parsed.error?.issues.slice(0, 3)));
  assert.deepEqual(FORM.meta?.system, { key: GLOBALFLOW_KYB_KEY, version: GLOBALFLOW_KYB_VERSION });
  assert.deepEqual(findSystemForm(GLOBALFLOW_KYB_KEY)?.definition, FORM);
});

test("claves únicas, id = key, y secciones únicas", () => {
  const keys = ALL.map((f) => f.key);
  assert.equal(new Set(keys).size, keys.length);
  for (const f of ALL) assert.equal(f.id, f.key);
  const sections = FORM.sections.map((s) => s.id);
  assert.equal(new Set(sections).size, sections.length);
});

test("título y correo de contacto apuntan a preguntas que existen", () => {
  assert.equal(byKey.get(FORM.internalFields?.title ?? "")?.type, "short_text");
  assert.equal(byKey.get(FORM.internalFields?.contactEmail ?? "")?.type, "email");
});

test("cada persona tiene su AML con datos explícitos y su CI con anverso y reverso", () => {
  const people = ALL.filter((f) => f.review?.aml?.entityType === "person");
  // 5 socios + el representante legal.
  assert.equal(people.length, MAX_PARTNERS + 1);
  for (const f of people) {
    const prefix = f.key.replace(/_first_names$/, "");
    const aml = f.review!.aml!;
    assert.equal(f.review?.feature, "aml_screening");
    for (const k of [...(aml.nameKeys ?? []), aml.dobKey, aml.nationalityKey, aml.documentKey]) {
      assert.ok(k && byKey.has(k), `${f.key}: falta ${k}`);
    }
    assert.equal(byKey.get(`${prefix}_id_front`)?.review?.feature, "id_verification");
    assert.equal(byKey.get(`${prefix}_id_back`)?.review?.feature, "id_verification");
  }
});

test("la empresa y cada socio empresa tienen su AML de empresa", () => {
  const legal = byKey.get("company_legal_name")!;
  assert.equal(legal.review?.feature, "kyb_registry");
  assert.equal(legal.review?.aml?.entityType, "company");
  for (let n = 1; n <= MAX_PARTNERS; n++) {
    const f = byKey.get(`partner_${n}_company_name`)!;
    assert.equal(f.review?.feature, "aml_screening");
    assert.equal(f.review?.aml?.entityType, "company");
  }
});

test("los 62 bancos del Google Forms, más «Otro»", () => {
  const bank = byKey.get("bank_name")!;
  assert.equal(bank.options?.length, 63);
  assert.equal(bank.options?.at(-1)?.value, "other");
});

test("«Ninguna» es la única actividad excluyente", () => {
  const exclusive = byKey.get("regulated_activities")!.options!.filter((o) => o.exclusive);
  assert.deepEqual(exclusive.map((o) => o.value), ["none"]);
});

// ------------------------------------------------------------
// Recorridos
// ------------------------------------------------------------
const up = (name: string) => [{ path: `req-1/${name}`, filename: name }];

function person(p: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    [`${p}_first_names`]: "Ana María",
    [`${p}_last_names`]: "Pérez Rojas",
    [`${p}_birth_date`]: "1985-04-02",
    [`${p}_nationality`]: "BOL",
    [`${p}_doc_type`]: "ci",
    [`${p}_doc_number`]: `${p}-123`,
    [`${p}_doc_country`]: "BOL",
    [`${p}_id_front`]: up(`${p}-front.jpg`),
    [`${p}_id_back`]: up(`${p}-back.jpg`),
    [`${p}_phone`]: "+591 70000000",
    [`${p}_email`]: `${p}@acme.bo`,
    [`${p}_address`]: "Av. Arce 123, La Paz",
    ...overrides,
  };
}

const COMPANY: Record<string, unknown> = {
  company_legal_name: "ACME S.R.L.",
  company_tax_id: "1020304050",
  company_registration_number: "00123456",
  company_incorporation_country: "BOL",
  company_legal_form: "srl",
  company_incorporation_date: "2019-03-01",
  company_address_street: "Av. Arce 123",
  company_address_city: "La Paz",
  company_address_country: "BOL",
  company_phone: "+591 70000000",
  company_email: "ops@acme.bo",
  company_years_operating: 6,
  company_publicly_listed: "no",
  business_description: "Importación y venta de material de ferretería a constructoras.",
  business_industry: "423710",
  regulated_activities: ["none"],
  pep_declared: "no",
  us_bank_denied: "no",
  legal_actions: "no",
  expected_monthly_volume_usd: 20000,
  annual_revenue_range: "100000_999999",
  monthly_transactions: 12,
  account_purpose: "purchase_goods_and_services",
  third_party_operations: "no",
  operating_country_1: "BOL",
  source_of_funds: "sales_of_goods_and_services",
  source_of_funds_explanation: "Ventas a constructoras en La Paz y El Alto.",
  company_profitability: "covers_100",
  available_cash_usd: 15000,
  doc_tax_id: up("nit.pdf"),
  doc_commercial_registration: up("matricula.pdf"),
  doc_incorporation_deed: up("testimonio.pdf"),
  doc_bank_statements: up("extractos.pdf"),
  doc_invoices: up("facturas.pdf"),
  doc_proof_of_address: up("domicilio.pdf"),
  doc_financial_statements: up("eeff.pdf"),
  usd_account_number: "201-5012345-2-11",
  bank_name: "BANCO BISA",
  accept_terms: true,
};

/** 2 socios (una persona que no representa y una empresa) y un representante aparte. */
const TWO_PARTNERS_AND_REP: Record<string, unknown> = {
  ...COMPANY,
  partners_count: "2",
  partner_1_type: "person",
  partner_1_ownership_pct: 60,
  partner_1_is_legal_rep: "no",
  ...person("partner_1"),
  partner_2_type: "company",
  partner_2_ownership_pct: 40,
  partner_2_company_name: "Holding Andina S.A.",
  partner_2_company_country: "PER",
  partner_2_company_tax_id: "20123456789",
  partner_2_company_incorporation_doc: up("holding.pdf"),
  ...person("legal_rep"),
};

const amlBodies = (tasks: DiditTask[]) =>
  Object.fromEntries(
    tasks.flatMap((t) => (t.feature === "aml_screening" ? [[t.fieldKey, t.body]] : [])),
  );

test("2 socios (uno empresa) y un representante aparte: el envío valida", () => {
  const fields = reachableFields(FORM, TWO_PARTNERS_AND_REP);
  const parse = buildZod(fields).safeParse(TWO_PARTNERS_AND_REP);
  assert.ok(parse.success, JSON.stringify(parse.error?.issues.slice(0, 5)));
  const sections = reachableSections(FORM, TWO_PARTNERS_AND_REP).map((s) => s.id);
  assert.deepEqual(sections.filter((s) => s.startsWith("partner_") || s === "legal_rep"), [
    "partner_1",
    "partner_2",
    "legal_rep",
  ]);
});

test("2 socios (uno empresa) y un representante aparte: el plan de DIDIT sale completo", () => {
  const { tasks, skipped } = planDiditTasks(FORM, TWO_PARTNERS_AND_REP);
  assert.deepEqual(
    tasks.map((t) => `${t.feature}:${t.fieldKey}`).sort(),
    [
      "aml_screening:company_legal_name",
      "aml_screening:legal_rep_first_names",
      "aml_screening:partner_1_first_names",
      "aml_screening:partner_2_company_name",
      "id_verification:legal_rep_id_front",
      "id_verification:partner_1_id_front",
    ],
  );
  const ids = tasks.filter((t) => t.feature === "id_verification");
  for (const t of ids) assert.ok(t.feature === "id_verification" && t.back, `${t.fieldKey} sin reverso`);

  const aml = amlBodies(tasks);
  assert.deepEqual(aml.company_legal_name, {
    full_name: "ACME S.R.L.",
    entity_type: "company",
    date_of_birth: "2019-03-01",
  });
  assert.deepEqual(aml.partner_2_company_name, { full_name: "Holding Andina S.A.", entity_type: "company" });
  assert.deepEqual(aml.partner_1_first_names, {
    full_name: "Ana María Pérez Rojas",
    entity_type: "person",
    date_of_birth: "1985-04-02",
    nationality: "BO",
    document_number: "partner_1-123",
  });
  // Nada de lo recorrido quedó sin su dato.
  assert.deepEqual(skipped.filter((s) => s.reason !== "not_reached"), []);
});

test("un socio que es el representante: no se pide el representante aparte", () => {
  const answers = {
    ...TWO_PARTNERS_AND_REP,
    partner_1_is_legal_rep: "yes",
  };
  const sections = reachableSections(FORM, answers).map((s) => s.id);
  assert.equal(sections.includes("legal_rep"), false);
  const { tasks } = planDiditTasks(FORM, answers);
  assert.equal(tasks.some((t) => t.fieldKey.startsWith("legal_rep_")), false);
});

test("un socio que dejó de contarse no cuenta como representante", () => {
  // Llenó un tercer socio representante y después bajó a 2 socios.
  const answers = {
    ...TWO_PARTNERS_AND_REP,
    partner_3_type: "person",
    partner_3_is_legal_rep: "yes",
  };
  const sections = reachableSections(FORM, answers).map((s) => s.id);
  assert.ok(sections.includes("legal_rep"));
  assert.equal(sections.includes("partner_3"), false);
});

test("con pasaporte no se pide reverso", () => {
  const answers = { ...TWO_PARTNERS_AND_REP, ...person("legal_rep", { legal_rep_doc_type: "passport" }) };
  delete answers.legal_rep_id_back;
  const fields = reachableFields(FORM, answers).map((f) => f.key);
  assert.equal(fields.includes("legal_rep_id_back"), false);
  assert.ok(buildZod(reachableFields(FORM, answers)).safeParse(answers).success);
});

test("más de 5 socios: registro de accionistas y las 5 secciones de socios", () => {
  assert.deepEqual(partnerCountsFor(5), ["5", "more_than_5"]);
  assert.deepEqual(partnerCountsFor(1), ["1", "2", "3", "4", "5", "more_than_5"]);
  const answers = { ...COMPANY, partners_count: "more_than_5" };
  const keys = reachableFields(FORM, answers).map((f) => f.key);
  assert.ok(keys.includes("shareholder_registry"));
  const sections = reachableSections(FORM, answers).map((s) => s.id);
  for (let n = 1; n <= MAX_PARTNERS; n++) assert.ok(sections.includes(`partner_${n}`));
});

test("una actividad regulada exige el permiso; «Ninguna» no", () => {
  const withActivity = { ...TWO_PARTNERS_AND_REP, regulated_activities: ["gambling"] };
  const fields = reachableFields(FORM, withActivity);
  assert.ok(fields.some((f) => f.key === "regulated_license"));
  assert.equal(buildZod(fields).safeParse(withActivity).success, false);
  assert.equal(
    reachableFields(FORM, TWO_PARTNERS_AND_REP).some((f) => f.key === "regulated_license"),
    false,
  );
});

// ------------------------------------------------------------
// Sincronización
// ------------------------------------------------------------
const system = SYSTEM_FORMS[0];

test("sync: recién instalado no hay nada que cambiar", () => {
  const row = { definition: storedDefinition(system), version: 3, system_version: GLOBALFLOW_KYB_VERSION, status: "published" };
  assert.equal(planSystemFormSync(row, system), null);
  // jsonb reordena las claves: no cuenta como cambio.
  const reverseKeys = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(reverseKeys)
      : v && typeof v === "object"
        ? Object.fromEntries(Object.entries(v).reverse().map(([k, x]) => [k, reverseKeys(x)]))
        : v;
  assert.equal(planSystemFormSync({ ...row, definition: reverseKeys(row.definition) }, system), null);
});

test("sync: una definición distinta abre una revisión nueva", () => {
  const stale = { ...storedDefinition(system), title: { es: "Viejo", en: "Old" } };
  const patch = planSystemFormSync({ definition: stale, version: 3, system_version: 1, status: "published" }, system);
  assert.equal(patch?.version, 4);
  assert.equal(patch?.system_version, GLOBALFLOW_KYB_VERSION);
  assert.deepEqual(patch?.definition, storedDefinition(system));
});

test("sync: otra versión del sistema o una fila despublicada también se actualizan", () => {
  const def = storedDefinition(system);
  assert.ok(planSystemFormSync({ definition: def, version: 3, system_version: 0, status: "published" }, system));
  assert.equal(
    planSystemFormSync({ definition: def, version: 3, system_version: 1, status: "draft" }, system)?.status,
    "published",
  );
});
