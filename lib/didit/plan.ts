/**
 * Qué verificaciones DIDIT corresponden a una solicitud — client-safe.
 *
 * Separa la DECISIÓN (este módulo) de la EJECUCIÓN HTTP (lib/didit/verify.ts).
 * Cada llamada standalone a DIDIT crea una sesión y se cobra —también cuando
 * DIDIT la rechaza—, así que la regla es estricta: solo sale una tarea para una
 * pregunta que la persona RECORRIÓ (mismo criterio que la validación de envío y
 * el informe: `reachableSections` + `visibleFields`) y cuyo insumo (archivo,
 * nombre, número) está presente. Lo demás queda en `skipped` para el log: sin
 * fila en aml_checks y sin llamada.
 *
 * Importa aunque el envío ya pode las respuestas: el autosave NO poda (una rama
 * aún no alcanzada es legítima mientras se llena) y la re-ejecución forzada del
 * analista corre sobre lo guardado, en cualquier estado de la solicitud.
 *
 * Sin `import "server-only"` ni alias `@/` a propósito: así se puede probar con
 * `node --test --experimental-strip-types` sin arrastrar el runtime de Next.
 */
import type {
  AmlSubject,
  DiditFeature,
  Field,
  FormDefinition,
  LocalizedText,
} from "../forms/definition.ts";
import { reachableSections, visibleFields } from "../forms/logic.ts";
import { toAlpha2 } from "../forms/countries.ts";

export type FileRef = { path: string; filename: string };

/** Una llamada a DIDIT con sus insumos ya resueltos (verify.ts solo la ejecuta). */
export type DiditTask =
  | {
      feature: "id_verification";
      /** Key del anverso: identifica el documento (y la fila en aml_checks). */
      fieldKey: string;
      front: FileRef;
      back?: FileRef;
      backKey?: string;
    }
  | { feature: "face_match"; fieldKey: string; selfie: FileRef; ref: FileRef }
  | { feature: "proof_of_address"; fieldKey: string; document: FileRef }
  | { feature: "age_estimation" | "liveness"; fieldKey: string; image: FileRef }
  | { feature: "aml_screening" | "database_validation"; fieldKey: string; body: Record<string, string> };

/**
 * - `not_reached`: la pregunta está en una sección o rama que la persona no recorrió.
 * - `no_input`: la recorrió pero falta el archivo o dato que DIDIT necesita.
 * - `orphan_back`: un reverso sin anverso previo en su sección.
 */
export type SkipReason = "not_reached" | "no_input" | "orphan_back";
export type SkippedReview = { feature: DiditFeature; fieldKey: string; reason: SkipReason };
export type DiditPlan = {
  tasks: DiditTask[];
  skipped: SkippedReview[];
  /**
   * Preguntas que leyó cada tarea, por `feature:fieldKey` (la propia incluida).
   * Corregir cualquiera de ellas deja viejo el control (ver `checksReading`).
   */
  inputs: Record<string, string[]>;
};

/** Clave de una tarea y de su fila en aml_checks. */
export const taskId = (feature: DiditFeature, fieldKey: string) => `${feature}:${fieldKey}`;

// Lo que despacha `dispatchDiditReviews`. kyb_registry es un ciclo manual del
// analista; email/phone_verification no tienen despacho.
const DISPATCHED: ReadonlySet<DiditFeature> = new Set<DiditFeature>([
  "id_verification",
  "face_match",
  "aml_screening",
  "proof_of_address",
  "age_estimation",
  "liveness",
  "database_validation",
]);

// ------------------------------------------------------------
// Lectura de respuestas
// ------------------------------------------------------------
export function firstFileRef(answers: Record<string, unknown>, key: string): FileRef | null {
  const v = answers[key];
  if (Array.isArray(v) && v.length > 0) {
    const f = v[0] as Partial<FileRef>;
    if (f && typeof f.path === "string" && f.path) {
      return { path: f.path, filename: typeof f.filename === "string" ? f.filename : "file" };
    }
  }
  return null;
}

/**
 * Respuesta como texto. Los campos `number` se guardan como número (Zod los
 * coacciona al validar el envío): sin este caso, una matrícula enlazada a un
 * campo numérico se leía vacía y la búsqueda registral caía a "solo nombre".
 */
export function textAnswer(answers: Record<string, unknown>, key: string): string {
  const v = answers[key];
  if (typeof v === "string") return v.trim();
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return "";
}

/**
 * Datos de soporte (texto) de los campos hermanos de una sección, por
 * convención de key. `used` acumula las keys de las que se leyó algo.
 */
export function siblingText(
  fields: Field[],
  answers: Record<string, unknown>,
  used?: Set<string>,
) {
  const get = (re: RegExp): string | undefined => {
    for (const f of fields) {
      if (re.test(f.key)) {
        const v = textAnswer(answers, f.key);
        if (v) {
          used?.add(f.key);
          return v;
        }
      }
    }
    return undefined;
  };
  return {
    dob: get(/birth_date|date_of_birth|dob/i),
    nationality: get(/nationality|nacionalidad/i),
    documentNumber: get(/document_number|doc_number/i),
    entityType: get(/entity_type/i),
    firstName: get(/first_name/i),
    lastName: get(/last_name/i),
    personalNumber: get(/personal_number|curp/i),
    issuingState: get(/issuing_state|issuing/i),
  };
}

// ------------------------------------------------------------
// Anverso / reverso
// ------------------------------------------------------------
// El key manda si lo dice (convención histórica); si no, la etiqueta. Los
// formularios importados de Google traen keys `q_…`, así que "DOCUMENTO DE
// IDENTIDAD (REVERSO)" solo se reconoce por la etiqueta.
const BACK_KEY_RE = /back|reverso/i;
const BACK_LABEL_RE = /\b(back|reverso|dorso|posterior)\b/i;
const FRONT_LABEL_RE = /\b(front|anverso|frente|frontal|delantera)\b/i;

function labelTexts(v: LocalizedText | undefined): string[] {
  if (v == null) return [];
  return typeof v === "string" ? [v] : Object.values(v);
}

export function isBackSide(field: Field): boolean {
  if (BACK_KEY_RE.test(field.key)) return true;
  const texts = labelTexts(field.label);
  return (
    texts.some((t) => BACK_LABEL_RE.test(t)) && !texts.some((t) => FRONT_LABEL_RE.test(t))
  );
}

function diditFeature(f: Field): DiditFeature | undefined {
  return f.review?.provider === "didit" ? f.review.feature : undefined;
}

function compact(o: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(o)) if (v) out[k] = v;
  return out;
}

// ------------------------------------------------------------
// Plan
// ------------------------------------------------------------
type Reached = { field: Field; si: number };

export function planDiditTasks(
  definition: FormDefinition,
  answers: Record<string, unknown>,
): DiditPlan {
  // Campos visibles de las secciones recorridas; `si` indexa `reached`.
  const reached = reachableSections(definition, answers).map((s) => visibleFields(s, answers));
  const reachedByKey = new Map<string, Reached>();
  reached.forEach((fields, si) => fields.forEach((field) => reachedByKey.set(field.key, { field, si })));
  const reachedList = [...reachedByKey.values()]; // orden del formulario
  const allByKey = new Map<string, Field>();
  definition.sections.forEach((s) => s.fields.forEach((f) => allByKey.set(f.key, f)));

  const tasks: DiditTask[] = [];
  const skipped: SkippedReview[] = [];
  const inputs: Record<string, string[]> = {};
  const skip = (feature: DiditFeature, fieldKey: string, reason: SkipReason) =>
    skipped.push({ feature, fieldKey, reason });
  const push = (task: DiditTask, read: (string | undefined)[]) => {
    tasks.push(task);
    inputs[taskId(task.feature, task.fieldKey)] = [
      ...new Set([task.fieldKey, ...read.filter((k): k is string => !!k)]),
    ];
  };

  for (const [key, f] of allByKey) {
    const feat = diditFeature(f);
    if (feat && DISPATCHED.has(feat) && !reachedByKey.has(key)) skip(feat, key, "not_reached");
    // La razón social con `kyb_registry` + `aml` corre además el AML de la empresa.
    if (feat === "kyb_registry" && f.review?.aml && !reachedByKey.has(key)) {
      skip("aml_screening", key, "not_reached");
    }
  }

  const tagged = (feat: DiditFeature) => reachedList.filter((t) => diditFeature(t.field) === feat);
  const isIdDoc = (key: string) => {
    const t = reachedByKey.get(key);
    return !!t && diditFeature(t.field) === "id_verification";
  };
  // Documento (anverso/reverso) a partir de los refKeys de un face_match.
  const docSides = (refKeys: string[] | undefined): { frontKey?: string; backKey?: string } => {
    if (!refKeys?.length) return {};
    const isBack = (k: string) => {
      const f = allByKey.get(k);
      return f ? isBackSide(f) : BACK_KEY_RE.test(k);
    };
    const backKey = refKeys.find(isBack);
    const frontKey = refKeys.find((k) => k !== backKey) ?? refKeys[0];
    return { frontKey, backKey };
  };

  // --- id_verification: una tarea POR documento (anverso + reverso opcional) ---
  const pushIdDoc = (frontKey: string, backKey?: string) => {
    const front = firstFileRef(answers, frontKey);
    if (!front) return skip("id_verification", frontKey, "no_input");
    const back = backKey ? firstFileRef(answers, backKey) : null;
    push(
      {
        feature: "id_verification",
        fieldKey: frontKey,
        front,
        ...(back && backKey ? { back, backKey } : {}),
      },
      [backKey],
    );
  };
  const consumed = new Set<string>();
  // (a) Documento enlazado a un face_match cuyo anverso esté etiquetado id_verification.
  for (const t of tagged("face_match")) {
    const { frontKey, backKey } = docSides(t.field.review?.refKeys);
    if (!frontKey || consumed.has(frontKey) || !isIdDoc(frontKey)) continue;
    consumed.add(frontKey);
    if (backKey) consumed.add(backKey);
    pushIdDoc(frontKey, backKey && reachedByKey.has(backKey) ? backKey : undefined);
  }
  // (b) El resto, por sección y en orden: cada anverso abre un documento y el
  // siguiente reverso lo cierra. Así una sección con varios socios produce un
  // documento por persona, no uno solo para toda la sección.
  for (const fields of reached) {
    const docs: { frontKey: string; backKey?: string }[] = [];
    let open: { frontKey: string; backKey?: string } | null = null;
    for (const f of fields) {
      if (diditFeature(f) !== "id_verification" || consumed.has(f.key)) continue;
      if (!isBackSide(f)) {
        open = { frontKey: f.key };
        docs.push(open);
      } else if (open && !open.backKey) {
        open.backKey = f.key;
      } else {
        skip("id_verification", f.key, "orphan_back");
      }
    }
    for (const d of docs) pushIdDoc(d.frontKey, d.backKey);
  }

  // --- face_match: selfie + anverso del documento de referencia ---
  const imageFields = reachedList.filter(
    (t) => t.field.type === "file" || t.field.type === "selfie",
  );
  for (const t of tagged("face_match")) {
    const selfie = firstFileRef(answers, t.field.key);
    if (!selfie) {
      skip("face_match", t.field.key, "no_input");
      continue;
    }
    // Referencia = anverso enlazado (refKeys). Sin binding → heurística de
    // respaldo: imagen sin etiqueta o id_verification, misma sección primero.
    let ref: FileRef | null = null;
    let refKey: string | undefined;
    const { frontKey } = docSides(t.field.review?.refKeys);
    if (frontKey) {
      ref = reachedByKey.has(frontKey) ? firstFileRef(answers, frontKey) : null;
      refKey = frontKey;
    } else {
      const score = (c: Reached) =>
        (c.si === t.si ? 0 : 2) + (diditFeature(c.field) === "id_verification" ? 0 : 1);
      const candidates = imageFields
        .filter((c) => c.field.key !== t.field.key)
        .filter((c) => {
          const feat = diditFeature(c.field);
          return !feat || feat === "id_verification";
        })
        .filter((c) => !isBackSide(c.field))
        .sort((a, b) => score(a) - score(b));
      for (const c of candidates) {
        ref = firstFileRef(answers, c.field.key);
        if (ref) {
          refKey = c.field.key;
          break;
        }
      }
    }
    if (!ref) {
      skip("face_match", t.field.key, "no_input");
      continue;
    }
    push({ feature: "face_match", fieldKey: t.field.key, selfie, ref }, [refKey]);
  }

  // --- aml_screening ---
  // Con `review.aml` los datos salen de las preguntas que nombra; sin él, del
  // nombre de la propia pregunta y de sus hermanas por convención de key. La
  // razón social con `kyb_registry` + `aml` corre también el de la empresa.
  const amlFields = [
    ...tagged("aml_screening"),
    ...tagged("kyb_registry").filter((t) => t.field.review?.aml),
  ];
  for (const t of amlFields) {
    const spec = t.field.review?.aml;
    if (spec) {
      const built = explicitAmlBody(spec, t.field.key, answers, (k) => reachedByKey.has(k));
      if (!built) skip("aml_screening", t.field.key, "no_input");
      else push({ feature: "aml_screening", fieldKey: t.field.key, body: built.body }, built.read);
      continue;
    }
    const fullName = textAnswer(answers, t.field.key);
    if (!fullName) {
      skip("aml_screening", t.field.key, "no_input");
      continue;
    }
    const used = new Set<string>();
    const sib = siblingText(reached[t.si], answers, used);
    push(
      {
        feature: "aml_screening",
        fieldKey: t.field.key,
        body: compact({
          full_name: fullName,
          date_of_birth: sib.dob,
          nationality: sib.nationality,
          document_number: sib.documentNumber,
          entity_type: sib.entityType,
        }),
      },
      [...used],
    );
  }

  // --- proof_of_address: documento ---
  for (const t of tagged("proof_of_address")) {
    const document = firstFileRef(answers, t.field.key);
    if (!document) skip("proof_of_address", t.field.key, "no_input");
    else push({ feature: "proof_of_address", fieldKey: t.field.key, document }, []);
  }

  // --- age_estimation / liveness: selfie ---
  for (const feature of ["age_estimation", "liveness"] as const) {
    for (const t of tagged(feature)) {
      const image = firstFileRef(answers, t.field.key);
      if (!image) skip(feature, t.field.key, "no_input");
      else push({ feature, fieldKey: t.field.key, image }, []);
    }
  }

  // --- database_validation: sin número personal no hay nada que consultar ---
  for (const t of tagged("database_validation")) {
    const used = new Set<string>();
    const sib = siblingText(reached[t.si], answers, used);
    if (!sib.personalNumber) {
      skip("database_validation", t.field.key, "no_input");
      continue;
    }
    push(
      {
        feature: "database_validation",
        fieldKey: t.field.key,
        body: compact({
          first_name: sib.firstName,
          last_name: sib.lastName,
          date_of_birth: sib.dob,
          personal_number: sib.personalNumber,
          issuing_state: sib.issuingState,
        }),
      },
      [...used],
    );
  }

  return { tasks, skipped, inputs };
}

/**
 * Cuerpo del AML a partir de `review.aml`, o `null` si no queda nombre. Solo se
 * leen preguntas que la persona recorrió (`reached`). La nacionalidad viaja en
 * alpha-2, como la pide DIDIT; las preguntas `country` la guardan en alpha-3.
 * Una empresa manda solo nombre y fecha de constitución: nacionalidad y
 * documento son datos de persona.
 */
export function explicitAmlBody(
  spec: AmlSubject,
  ownKey: string,
  answers: Record<string, unknown>,
  reached: (key: string) => boolean,
): { body: Record<string, string>; read: string[] } | null {
  const read: string[] = [];
  const get = (key: string | undefined): string | undefined => {
    if (!key || !reached(key)) return undefined;
    read.push(key);
    return textAnswer(answers, key) || undefined;
  };
  const nameKeys = spec.nameKeys?.length ? spec.nameKeys : [ownKey];
  const fullName = nameKeys
    .map(get)
    .filter((v): v is string => !!v)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  if (!fullName) return null;
  const person = spec.entityType === "person";
  const nationality = person ? get(spec.nationalityKey) : undefined;
  return {
    body: compact({
      full_name: fullName,
      entity_type: spec.entityType,
      date_of_birth: get(spec.dobKey),
      nationality: nationality ? toAlpha2(nationality) : undefined,
      document_number: person ? get(spec.documentKey) : undefined,
    }),
    read,
  };
}

/**
 * Tareas (`feature:fieldKey`) que leyeron alguna de `keys`. Al pedir que se
 * corrija una pregunta, todos estos controles quedan viejos: corregir el
 * apellido rehace el AML que vive en la pregunta de los nombres, y corregir el
 * reverso rehace la verificación que vive en el anverso.
 */
export function checksReading(plan: DiditPlan, keys: Iterable<string>): string[] {
  const wanted = new Set(keys);
  return Object.entries(plan.inputs)
    .filter(([, read]) => read.some((k) => wanted.has(k)))
    .map(([id]) => id);
}
