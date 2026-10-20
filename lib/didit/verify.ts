import "server-only";
import { randomUUID } from "crypto";
import { env } from "@/lib/env";
import { createServiceClient } from "@/lib/supabase/service";
import type { AmlStatus } from "@/lib/kyb/types";
import type { DiditFeature, Field, FormDefinition, Section } from "@/lib/forms/definition";
import {
  KYB_REG_NUMBER_RE,
  KYB_REG_NUMBER_EXCLUDE_RE,
  KYB_COUNTRY_RES,
} from "@/lib/forms/definition";
import { toAlpha2 } from "@/lib/forms/countries";
import { diditApiKey, diditBase } from "./http";
import { recordKybCharge } from "./costs";
import { planDiditTasks, textAnswer, type DiditTask, type SkipReason } from "./plan";

// Bucket privado donde viven los archivos/selfies (igual que lib/kyb/service.ts).
const DOCUMENTS_BUCKET = "kyb-documents";

export interface DiditCheckRow {
  feature: DiditFeature;
  fieldKey: string | null;
  externalRef: string | null;
  status: AmlStatus; // mapeado al enum de aml_checks
  score: number | null;
  result: Record<string, unknown>;
}

// ------------------------------------------------------------
// HTTP hacia DIDIT (host y key en lib/didit/http.ts)
// ------------------------------------------------------------
const base = diditBase;
const apiKey = diditApiKey;

// Log conciso por llamada. NO se vuelca el body (trae PII: nombre, documento,
// fecha de nacimiento, URLs firmadas); el detalle completo queda en aml_checks.result.
function logDiditCall(path: string, status: number, json: unknown): void {
  const node = json && typeof json === "object" ? (json as Record<string, unknown>) : {};
  console.log(`[DIDIT] POST ${path} -> ${status} request_id=${node.request_id ?? "-"}`);
}

// Corta una llamada DIDIT colgada para que no estire el trabajo en background.
const DIDIT_TIMEOUT_MS = 30_000;

async function postJson(
  path: string,
  body: unknown,
  timeoutMs = DIDIT_TIMEOUT_MS,
): Promise<Record<string, unknown>> {
  const res = await fetch(`${base()}${path}`, {
    method: "POST",
    headers: { "x-api-key": apiKey(), "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(body),
    cache: "no-store",
    signal: AbortSignal.timeout(timeoutMs),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  logDiditCall(path, res.status, json);
  if (!res.ok) throw new Error(`DIDIT ${path} ${res.status}: ${JSON.stringify(json).slice(0, 300)}`);
  return json;
}

async function postMultipart(path: string, form: FormData): Promise<Record<string, unknown>> {
  // Sin content-type manual: fetch fija el boundary de multipart/form-data.
  const res = await fetch(`${base()}${path}`, {
    method: "POST",
    headers: { "x-api-key": apiKey(), accept: "application/json" },
    body: form,
    cache: "no-store",
    signal: AbortSignal.timeout(DIDIT_TIMEOUT_MS),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  logDiditCall(path, res.status, json);
  if (!res.ok) throw new Error(`DIDIT ${path} ${res.status}: ${JSON.stringify(json).slice(0, 300)}`);
  return json;
}

/** Mapea el status de DIDIT (Approved/Declined/In Review) al enum de aml_checks. */
export function mapDiditStatus(raw: unknown): AmlStatus {
  switch (String(raw ?? "").toLowerCase()) {
    case "approved":
      return "passed";
    case "declined":
      return "flagged";
    case "in review":
      return "pending";
    default:
      return "pending";
  }
}

// ------------------------------------------------------------
// Archivos
// ------------------------------------------------------------
async function downloadBlob(path: string): Promise<Blob> {
  const supabase = createServiceClient();
  const { data, error } = await supabase.storage.from(DOCUMENTS_BUCKET).download(path);
  if (error || !data) throw new Error(`No se pudo leer el archivo ${path}: ${error?.message ?? "vacío"}`);
  return data;
}

// ------------------------------------------------------------
// KYB Registry (registro mercantil de empresas)
// ------------------------------------------------------------
// Search (POST /v3/kyb/search/) cuesta US$0.50 si DIDIT la resuelve con una
// fuente paga (vacías y fallidas no se cobran) y no crea registros en la
// consola DIDIT; select (POST /v3/kyb/select/) es FACTURABLE y crea una sesión
// empresarial (Manual Check). El ciclo es MANUAL (runKybRegistryCheck, botón
// del analista) con fases en result.phase: search → candidate_selection |
// select → completed. Auto-select SOLO con nº de registro declarado + match
// exacto único; nunca por nombre con un único resultado (NAME_ONLY_MATCH).
// El search se envía en modo async (webhook_url): DIDIT responde al instante y
// resuelve en ~90s llamando a /api/webhooks/didit/kyb-search. No hay polling:
// sin webhook la búsqueda es efímera del lado de DIDIT.
const KYB_SELECT_TIMEOUT_MS = 60_000;

// Convenciones de detección (KYB_REG_NUMBER_RE, KYB_COUNTRY_RES…) compartidas
// con el builder: viven en lib/forms/definition.ts. El binding explícito del
// review (kybCountryKey/kybRegNumberKey) tiene prioridad sobre la convención.

/** Como siblingText, pero busca primero en la sección del campo y luego en todo el form. */
function formText(
  sections: Section[],
  si: number,
  answers: Record<string, unknown>,
  re: RegExp,
  exclude?: RegExp,
): string | undefined {
  const scan = (fields: Field[]): string | undefined => {
    for (const f of fields) {
      if (!re.test(f.key) || exclude?.test(f.key)) continue;
      const v = textAnswer(answers, f.key);
      if (v) return v;
    }
    return undefined;
  };
  const own = scan(sections[si]?.fields ?? []);
  if (own) return own;
  for (let i = 0; i < sections.length; i++) {
    if (i === si) continue;
    const v = scan(sections[i].fields);
    if (v) return v;
  }
  return undefined;
}

function kybCountryAlpha2(
  sections: Section[],
  si: number,
  answers: Record<string, unknown>,
): string | undefined {
  for (const spec of KYB_COUNTRY_RES) {
    const v = formText(sections, si, answers, spec.re, spec.exclude);
    if (v) {
      const a2 = toAlpha2(v);
      if (a2) return a2;
    }
  }
  return undefined;
}

/** Normaliza números de registro para comparación exacta (sin espacios/guiones/puntos). */
function normalizeRegNumber(s: string): string {
  return s.toUpperCase().replace(/[\s.\-\/]+/g, "");
}

const KYB_ACTIVE_RE = /^(active|registered|live|(in\s?)?good\s?standing)/i;
const KYB_INACTIVE_RE =
  /^(dissolved|inactive|liquidat|struck|removed|cancel|revoked|terminated|closed|deregistered)/i;

/** Estado del perfil registral (nodo `kyb_registry` del select) → enum de aml_checks. */
export function mapKybRegistryStatus(node: Record<string, unknown>): AmlStatus {
  if (node.data_resolved === false) return "pending";
  const reg = String(node.registry_status ?? "").trim();
  if (KYB_ACTIVE_RE.test(reg)) return "passed";
  if (KYB_INACTIVE_RE.test(reg)) return "flagged";
  return mapDiditStatus(node.status);
}

/**
 * POST /v3/kyb/select/ — FACTURABLE: trae el perfil registral completo del
 * candidato y crea una sesión empresarial en la consola DIDIT. También lo usa
 * la server action del panel admin (selección manual de candidato).
 */
export async function kybSelect(
  kybResponseId: string,
  vendorData: string,
): Promise<{
  status: AmlStatus;
  externalRef: string | null;
  node: Record<string, unknown>;
  raw: Record<string, unknown>;
}> {
  const json = await postJson(
    "/v3/kyb/select/",
    { kyb_response_id: kybResponseId, vendor_data: vendorData },
    KYB_SELECT_TIMEOUT_MS,
  );
  const node = (json.kyb_registry ?? {}) as Record<string, unknown>;
  return {
    status: mapKybRegistryStatus(node),
    externalRef: (json.request_id as string) || null,
    node,
    raw: json,
  };
}

export type KybDeclared = {
  fieldKey: string;
  name: string;
  registrationNumber?: string;
  country?: string; // alpha-2
};

/** Localiza el campo etiquetado kyb_registry y arma los datos declarados del form. */
export function extractKybDeclared(
  definition: FormDefinition,
  answers: Record<string, unknown>,
): KybDeclared | null {
  const sections = definition.sections;
  for (let si = 0; si < sections.length; si++) {
    for (const f of sections[si].fields) {
      if (f.review?.provider !== "didit" || f.review.feature !== "kyb_registry") continue;
      const declared: KybDeclared = { fieldKey: f.key, name: textAnswer(answers, f.key) };
      // Binding explícito del builder primero; convención de keys como fallback.
      const explicitReg = f.review.kybRegNumberKey
        ? textAnswer(answers, f.review.kybRegNumberKey)
        : "";
      const reg =
        explicitReg ||
        formText(sections, si, answers, KYB_REG_NUMBER_RE, KYB_REG_NUMBER_EXCLUDE_RE);
      if (reg) declared.registrationNumber = reg;
      const explicitCountry = f.review.kybCountryKey
        ? toAlpha2(textAnswer(answers, f.review.kybCountryKey))
        : undefined;
      const country = explicitCountry ?? kybCountryAlpha2(sections, si, answers);
      if (country) declared.country = country;
      return declared;
    }
  }
  return null;
}

// fetch_status del candidato no indica indisponibilidad conocida.
function kybFetchable(c: Record<string, unknown>): boolean {
  return !/(unavailable|not_available|failed|error)/i.test(String(c.fetch_status ?? ""));
}

/**
 * Resuelve una búsqueda registral COMPLETADA (respuesta inmediata del search o
 * payload del callback `kyb.registry_search.resolved`): anota candidatos con su
 * match_reason, aplica las razones de bloqueo del auto-select estricto y, si
 * procede, ejecuta el select FACTURABLE con reserva atómica. Compartida entre
 * `runKybRegistryCheck` y el webhook /api/webhooks/didit/kyb-search.
 */
export async function resolveKybSearch(input: {
  checkId: string;
  declaredJson: Record<string, unknown>;
  /** Respuesta del search o body del callback (ambos traen `kyb_registry`). */
  search: Record<string, unknown>;
  searchRef: string | null;
  /** external_ref de la solicitud (vendor_data para el select). */
  vendorData: string;
}): Promise<void> {
  const supabase = createServiceClient();
  const { checkId, declaredJson, search, searchRef, vendorData } = input;
  const setRow = (patch: Record<string, unknown>) =>
    supabase.from("aml_checks").update(patch).eq("id", checkId);

  const regNode = (search.kyb_registry ?? {}) as Record<string, unknown>;
  const companies = (
    Array.isArray(regNode.companies) ? regNode.companies : []
  ) as Record<string, unknown>[];
  if (!companies.length) {
    await setRow({
      status: "flagged",
      external_ref: searchRef,
      result: { phase: "completed", declared: declaredJson, kyb_search: search, reason: "no_candidates" },
    });
    return;
  }
  // Resuelta con candidatos: la única búsqueda que DIDIT puede cobrar.
  await recordKybCharge({ checkId, kind: "kyb_search", sessionId: searchRef });

  // Candidatos anotados con el motivo de coincidencia (para el picker).
  const declaredReg =
    typeof declaredJson.registration_number === "string" ? declaredJson.registration_number : "";
  const target = declaredReg ? normalizeRegNumber(declaredReg) : null;
  const candidates: Record<string, unknown>[] = companies.slice(0, 25).map((c) => ({
    ...c,
    match_reason:
      target && normalizeRegNumber(String(c.registration_number ?? "")) === target
        ? "exact_registration_number"
        : "name_result",
  }));
  const exact = candidates.filter((c) => c.match_reason === "exact_registration_number");

  // Auto-select estricto. companies.length === 1 por nombre NO basta: un único
  // resultado por nombre puede ser la empresa equivocada.
  let blocked: string | null = null;
  if (!target) blocked = "NAME_ONLY_MATCH";
  else if (exact.length === 0) blocked = "NO_EXACT_REGISTRATION_MATCH";
  else if (exact.length > 1) blocked = "MULTIPLE_EXACT_MATCHES";
  else if (!kybFetchable(exact[0])) blocked = "CANDIDATE_NOT_FETCHABLE";

  const baseResult = { declared: declaredJson, kyb_search: search, candidates };
  if (blocked) {
    await setRow({
      external_ref: searchRef,
      result: { phase: "candidate_selection", ...baseResult, autoSelectBlockedReason: blocked },
    });
    return;
  }

  // --- reserva atómica ANTES del select facturable ---
  const chosen = exact[0];
  const kybResponseId = String(chosen.kyb_response_id ?? "");
  const selected = {
    kyb_response_id: kybResponseId,
    by: "auto",
    at: new Date().toISOString(),
    select_attempted: true,
    billing_state: "unknown",
  };
  const { data: reserved } = await supabase
    .from("aml_checks")
    .update({ external_ref: searchRef, result: { phase: "select", ...baseResult, selected } })
    .eq("id", checkId)
    .eq("status", "pending")
    .select("id");
  if (!reserved?.length) return; // otro proceso resolvió la fila

  try {
    const sel = await kybSelect(kybResponseId, vendorData);
    await setRow({
      status: sel.status,
      external_ref: sel.externalRef ?? searchRef,
      result: {
        phase: sel.status === "pending" ? "select" : "completed",
        ...baseResult,
        selected: { ...selected, billing_state: "charged" },
        kyb_registry: sel.node,
      },
    });
    await recordKybCharge({ checkId, kind: "kyb_select", sessionId: sel.externalRef });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/\s4\d\d:/.test(msg)) {
      // DIDIT rechazó el select (no facturó): el ciclo termina en error y un
      // nuevo run parte de cero con otra búsqueda.
      await setRow({ status: "error", result: { phase: "search", ...baseResult, error: msg } });
    } else {
      // Enviado sin confirmación: pudo facturarse. Queda pending/select/unknown
      // — sin reintentos automáticos ni manuales (verificar en consola DIDIT).
      await setRow({
        result: { phase: "select", ...baseResult, selected: { ...selected, error: msg } },
      });
      await recordKybCharge({ checkId, kind: "kyb_select", sessionId: null, unconfirmed: true });
    }
  }
}

/**
 * Ciclo MANUAL de validación registral (lo dispara el analista). Maneja su
 * propia fila en aml_checks con fases explícitas y reserva atómica antes del
 * select facturable:
 * - search sin candidatos → flagged/completed (reason no_candidates)
 * - candidatos sin auto-select → pending/candidate_selection (el analista elige)
 * - auto-select (nº exacto único) → reserva (select_attempted, billing unknown)
 *   → select → completed; fallo ambiguo queda pending/select SIN reintentos.
 * Un run nuevo con una fila pending en candidate_selection la cierra como
 * `superseded` (error, gratis); una fila pending con select_attempted bloquea.
 */
export async function runKybRegistryCheck(input: {
  requestId: string;
  externalRef: string;
  definition: FormDefinition;
  answers: Record<string, unknown>;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const supabase = createServiceClient();
  const declared = extractKybDeclared(input.definition, input.answers);
  if (!declared) return { ok: false, error: "no_tagged_field" };
  if (!declared.country) return { ok: false, error: "missing_country" };
  if (!declared.name && !declared.registrationNumber) return { ok: false, error: "missing_name" };

  // Ciclos en vuelo: select ya intentado → intocable; candidate_selection → se
  // supersede (cerrarla es gratis; el historial queda como evidencia).
  const { data: inflight } = await supabase
    .from("aml_checks")
    .select("id, result")
    .eq("request_id", input.requestId)
    .eq("provider", "didit")
    .eq("feature", "kyb_registry")
    .eq("status", "pending");
  for (const row of inflight ?? []) {
    const res = (row.result ?? {}) as Record<string, unknown>;
    const sel = res.selected as Record<string, unknown> | undefined;
    if (sel?.select_attempted) return { ok: false, error: "cycle_in_progress" };
    await supabase
      .from("aml_checks")
      .update({ status: "error", result: { ...res, phase: "completed", reason: "superseded" } })
      .eq("id", row.id)
      .eq("status", "pending");
  }

  const declaredJson = {
    name: declared.name,
    registration_number: declared.registrationNumber ?? null,
    country: declared.country,
  };

  // Fase search: la fila existe desde el inicio (la búsqueda tarda ~90s y así
  // el panel puede mostrar "Buscando empresa" si se refresca).
  const { data: inserted, error: insertError } = await supabase
    .from("aml_checks")
    .insert({
      request_id: input.requestId,
      provider: "didit",
      feature: "kyb_registry",
      field_key: declared.fieldKey,
      external_ref: null,
      status: "pending",
      score: null,
      result: { phase: "search", declared: declaredJson },
    })
    .select("id")
    .single();
  if (insertError || !inserted) {
    return { ok: false, error: insertError?.message ?? "insert_failed" };
  }
  const checkId = inserted.id as string;
  const setRow = (patch: Record<string, unknown>) =>
    supabase.from("aml_checks").update(patch).eq("id", checkId);

  // --- search async (se cobra solo si resuelve con candidatos): DIDIT responde al instante y resuelve en ~90s
  // llamando a nuestro webhook con el token por-búsqueda. Sin webhook_url la
  // búsqueda sería efímera (no hay polling).
  const searchToken = randomUUID();
  let search: Record<string, unknown>;
  try {
    const body: Record<string, unknown> = {
      country_code: declared.country,
      vendor_data: input.externalRef,
      webhook_url: `${env.appUrl().replace(/\/+$/, "")}/api/webhooks/didit/kyb-search?t=${searchToken}`,
    };
    if (declared.registrationNumber) body.registration_number = declared.registrationNumber;
    else body.name = declared.name;
    search = await postJson("/v3/kyb/search/", body);
  } catch (e) {
    await setRow({
      status: "error",
      result: {
        phase: "search",
        declared: declaredJson,
        error: e instanceof Error ? e.message : String(e),
      },
    });
    return { ok: true };
  }
  const regNode = (search.kyb_registry ?? {}) as Record<string, unknown>;
  const searchRef = (search.request_id as string) || null;

  if (search.search_resolved === true || regNode.search_resolved === true) {
    // Resolución inmediata (registro cacheado): mismo camino que el callback.
    await resolveKybSearch({
      checkId,
      declaredJson,
      search,
      searchRef,
      vendorData: input.externalRef,
    });
    return { ok: true };
  }

  // Pendiente: la fila espera el callback kyb.registry_search.resolved. El
  // token autentica el callback (viene sin firma de DIDIT).
  await setRow({
    external_ref: searchRef,
    result: {
      phase: "search",
      declared: declaredJson,
      kyb_search: search,
      search_token: searchToken,
    },
  });
  return { ok: true };
}

// ------------------------------------------------------------
// Dispatcher
// ------------------------------------------------------------
type TaskResult = {
  status: AmlStatus;
  score: number | null;
  externalRef: string | null;
  result: Record<string, unknown>;
};

/**
 * Ejecuta las verificaciones que decide `planDiditTasks` (lib/didit/plan.ts):
 * solo preguntas que la persona recorrió y cuyo insumo está presente. Lo que el
 * plan omite no genera fila ni llamada — DIDIT cobra cada sesión, incluso las
 * rechazadas. Devuelve una fila por verificación ejecutada; los errores por
 * tarea se capturan como fila `error` (no abortan las demás).
 *
 * kyb_registry NO se despacha aquí: es un ciclo manual del analista
 * (runKybRegistryCheck), disparado desde el panel de la solicitud.
 */
export async function dispatchDiditReviews(input: {
  requestId: string;
  externalRef: string;
  definition: FormDefinition;
  answers: Record<string, unknown>;
  /** Claves `feature:fieldKey` ya verificadas (se saltan; permite reanudar). */
  skip?: Set<string>;
  /**
   * Solo estas claves `feature:fieldKey` (la renovación de un documento vuelve
   * a verificar ese documento y nada más).
   */
  only?: Set<string>;
  /** Persiste cada verificación apenas completa (progreso parcial resiliente). */
  onRow?: (row: DiditCheckRow) => Promise<void> | void;
}): Promise<DiditCheckRow[]> {
  const rows: DiditCheckRow[] = [];
  const { tasks, skipped } = planDiditTasks(input.definition, input.answers);
  const count = (r: SkipReason) => skipped.filter((s) => s.reason === r).length;
  console.log(
    `[DIDIT] request=${input.requestId} apiKey=${env.diditApiKey() ? "set" : "MISSING"} ` +
      `plan: ${tasks.length} tareas [${tasks.map((t) => `${t.feature}:${t.fieldKey}`).join(",")}] ` +
      `omitidas: not_reached=${count("not_reached")} no_input=${count("no_input")} ` +
      `orphan_back=${count("orphan_back")}`,
  );
  // Las omisiones dentro del recorrido se detallan: son las que un analista
  // podría echar de menos (p. ej. un documento opcional que no se subió).
  for (const s of skipped) {
    if (s.reason !== "not_reached") {
      console.log(`[DIDIT] request=${input.requestId} omitida ${s.feature}:${s.fieldKey} (${s.reason})`);
    }
  }

  // Cada verificación corre en paralelo. La tarea aísla su propio error (empuja
  // una fila `error`), así que `Promise.all` nunca rechaza.
  const running: Promise<void>[] = [];
  for (const task of tasks) {
    const { feature, fieldKey } = task;
    // Saltar lo ya verificado con éxito en una corrida previa (reanudable).
    if (input.skip?.has(`${feature}:${fieldKey}`)) continue;
    if (input.only && !input.only.has(`${feature}:${fieldKey}`)) continue;
    running.push(
      (async () => {
        let row: DiditCheckRow;
        try {
          const res = await executeTask(task, input.externalRef);
          console.log(
            `[DIDIT] request=${input.requestId} feature=${feature} field=${fieldKey} status=${res.status} score=${res.score ?? "-"}`,
          );
          row = { feature, fieldKey, ...res };
        } catch (e) {
          console.error(
            `[DIDIT] request=${input.requestId} feature=${feature} field=${fieldKey} falló:`,
            e instanceof Error ? e.message : String(e),
          );
          row = {
            feature,
            fieldKey,
            externalRef: null,
            status: "error",
            score: null,
            result: { error: e instanceof Error ? e.message : String(e) },
          };
        }
        rows.push(row);
        // Persiste apenas completa: si el background se corta, no se pierde.
        if (input.onRow) await input.onRow(row);
      })(),
    );
  }

  await Promise.all(running);
  return rows;
}

/** Una llamada standalone a DIDIT. Los insumos ya vienen resueltos por el plan. */
async function executeTask(task: DiditTask, externalRef: string): Promise<TaskResult> {
  const fromNode = (json: Record<string, unknown>, node: Record<string, unknown>, score = false) => ({
    status: mapDiditStatus(node.status),
    score: score && typeof node.score === "number" ? node.score : null,
    externalRef: (json.request_id as string) || null,
    result: json,
  });

  switch (task.feature) {
    // Documento de identidad: anverso + reverso opcional.
    case "id_verification": {
      const fd = new FormData();
      fd.append("front_image", await downloadBlob(task.front.path), task.front.filename);
      if (task.back) fd.append("back_image", await downloadBlob(task.back.path), task.back.filename);
      fd.append("vendor_data", externalRef);
      const json = await postMultipart("/v3/id-verification/", fd);
      return fromNode(json, (json.id_verification ?? {}) as Record<string, unknown>);
    }
    // Selfie (user_image) + anverso del documento de referencia (ref_image).
    case "face_match": {
      const fd = new FormData();
      fd.append("user_image", await downloadBlob(task.selfie.path), task.selfie.filename);
      fd.append("ref_image", await downloadBlob(task.ref.path), task.ref.filename);
      fd.append("vendor_data", externalRef);
      const json = await postMultipart("/v3/face-match/", fd);
      return fromNode(json, (json.face_match ?? {}) as Record<string, unknown>, true);
    }
    case "aml_screening": {
      const json = await postJson("/v3/aml/", { ...task.body, vendor_data: externalRef });
      return fromNode(json, (json.aml ?? {}) as Record<string, unknown>, true);
    }
    case "proof_of_address": {
      const fd = new FormData();
      fd.append("document", await downloadBlob(task.document.path), task.document.filename);
      fd.append("vendor_data", externalRef);
      const json = await postMultipart("/v3/poa/", fd);
      return fromNode(json, (json.poa ?? json.proof_of_address ?? {}) as Record<string, unknown>);
    }
    // Selfie (user_image).
    case "age_estimation":
    case "liveness": {
      const path = task.feature === "liveness" ? "/v3/passive-liveness/" : "/v3/age-estimation/";
      const fd = new FormData();
      fd.append("user_image", await downloadBlob(task.image.path), task.image.filename);
      fd.append("vendor_data", externalRef);
      const json = await postMultipart(path, fd);
      return fromNode(json, (json[task.feature] ?? {}) as Record<string, unknown>, true);
    }
    case "database_validation": {
      const json = await postJson("/v3/database-validation/", {
        ...task.body,
        vendor_data: externalRef,
      });
      return fromNode(json, (json.database_validation ?? {}) as Record<string, unknown>);
    }
  }
}
