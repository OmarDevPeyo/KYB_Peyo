import { z } from "zod";

// ============================================================
// Texto localizado (client-safe; no depende de server-only)
// ============================================================
export const localizedTextSchema = z.union([
  z.string(),
  z.record(z.string(), z.string()),
]);
export type LocalizedText = z.infer<typeof localizedTextSchema>;

export function resolveText(
  v: LocalizedText | null | undefined,
  locale = "es",
  fallbacks: string[] = ["es", "en"],
): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (v[locale]) return v[locale];
  for (const f of fallbacks) if (v[f]) return v[f];
  const first = Object.values(v)[0];
  return typeof first === "string" ? first : "";
}

/**
 * Texto de UN locale exacto, SIN fallback. A diferencia de `resolveText`, un
 * string plano se considera del locale por defecto del formulario: sirve para
 * distinguir "no traducido" de "traducido", que es lo que `resolveText` oculta.
 */
export function getLoc(
  v: LocalizedText | undefined,
  locale: string,
  plainLocale = "es",
): string {
  if (v == null) return "";
  if (typeof v === "string") return locale === plainLocale ? v : "";
  return v[locale] ?? "";
}

/** Escribe un locale preservando los demás; normaliza string plano a objeto. */
export function setLoc(
  v: LocalizedText | undefined,
  locale: string,
  val: string,
  plainLocale = "es",
): Record<string, string> {
  const base =
    typeof v === "string" ? { [plainLocale]: v } : v && typeof v === "object" ? { ...v } : {};
  base[locale] = val;
  return base;
}

// ============================================================
// Estado del formulario (client-safe: lo usan la lista y el builder)
// ============================================================
// `archived` es la salida REVERSIBLE: saca el formulario de la lista y de todo
// lo que filtra por `published` (ruta pública, formulario por defecto, selector
// del cliente) sin destruir nada. Eliminar es lo irreversible y va aparte.
export const FORM_STATUSES = ["draft", "published", "archived"] as const;
export type FormStatus = (typeof FORM_STATUSES)[number];

// ============================================================
// Tipos de campo
// ============================================================
export const FIELD_TYPES = [
  "short_text",
  "long_text",
  "email",
  "number",
  "date",
  "single_choice",
  "multiple_choice",
  "dropdown",
  "country",
  // Industria: un código NAICS 2022 de 6 dígitos (catálogo en ./naics.ts).
  "naics",
  "file",
  "selfie",
  "boolean",
  "note",
] as const;
export const fieldTypeSchema = z.enum(FIELD_TYPES);
export type FieldType = (typeof FIELD_TYPES)[number];

export function isChoiceType(t: FieldType): boolean {
  return t === "single_choice" || t === "multiple_choice" || t === "dropdown";
}

// ============================================================
// Revisión con DIDIT (metadata por-campo)
// ============================================================
export const DIDIT_FEATURES = [
  "aml_screening",
  "id_verification",
  "proof_of_address",
  "email_verification",
  "phone_verification",
  "database_validation",
  "age_estimation",
  "liveness",
  "face_match",
  "kyb_registry",
] as const;
export const diditFeatureSchema = z.enum(DIDIT_FEATURES);
export type DiditFeature = (typeof DIDIT_FEATURES)[number];

/** Tipos de campo compatibles con cada feature de DIDIT (subconjunto mapeable). */
export const DIDIT_FEATURE_COMPAT: Record<DiditFeature, FieldType[]> = {
  aml_screening: ["short_text", "long_text"],
  id_verification: ["file"],
  proof_of_address: ["file"],
  email_verification: ["email"],
  phone_verification: ["short_text"],
  database_validation: ["short_text"],
  age_estimation: ["selfie", "file"],
  liveness: ["selfie"],
  face_match: ["selfie"],
  // Se etiqueta sobre el campo de razón social; nº de registro y país se toman
  // de campos hermanos por convención de key (ver lib/didit/verify.ts).
  kyb_registry: ["short_text"],
};

/** ¿El tipo de campo satisface el input que requiere la feature de DIDIT? */
export function isDiditCompatible(feature: DiditFeature, type: FieldType): boolean {
  return DIDIT_FEATURE_COMPAT[feature].includes(type);
}

/**
 * AML con datos EXPLÍCITOS, en vez de buscarlos por convención de key en la
 * sección (ver `siblingText` en lib/didit/plan.ts). Va en una pregunta con
 * `aml_screening`, o en la razón social con `kyb_registry`, donde corre además
 * el AML de la empresa sobre esa misma respuesta.
 *
 * - `nameKeys`: el nombre completo se arma con estas respuestas, en orden
 *   (nombres + apellidos). Sin ellas, es la respuesta de la propia pregunta.
 * - `dobKey`: fecha de nacimiento; en una empresa, la de constitución.
 * - `nationalityKey`: una pregunta `country` (se manda en alpha-2). Solo personas.
 * - `documentKey`: número de documento. Solo personas.
 */
export const amlSubjectSchema = z.object({
  entityType: z.enum(["person", "company"]),
  nameKeys: z.array(z.string().min(1)).max(4).optional(),
  dobKey: z.string().min(1).optional(),
  nationalityKey: z.string().min(1).optional(),
  documentKey: z.string().min(1).optional(),
});
export type AmlSubject = z.infer<typeof amlSubjectSchema>;

export const reviewSchema = z.object({
  provider: z.literal("didit"),
  feature: diditFeatureSchema,
  aml: amlSubjectSchema.optional(),
  // Solo para face_match: keys del documento de referencia (frente + reverso opcional).
  refKeys: z.array(z.string()).max(2).optional(),
  // Solo para kyb_registry: binding explícito de las preguntas de soporte.
  // Sin binding se cae a la detección por convención de key (regexes de abajo).
  kybCountryKey: z.string().optional(),
  kybRegNumberKey: z.string().optional(),
});
export type FieldReview = z.infer<typeof reviewSchema>;

// ------------------------------------------------------------
// Control de vencimiento (metadata por-campo, solo preguntas `file`). La fecha
// sale del resultado de DIDIT id_verification o de una pregunta `date` del
// mismo formulario (por id: el key es editable). Sin refinamientos, por la
// misma razón que `internalFieldsSchema`: los invariantes los impone
// `normalizeExpiry` (./expiry.ts).
// ------------------------------------------------------------
export const expirySchema = z.discriminatedUnion("source", [
  z.object({ source: z.literal("didit") }),
  z.object({ source: z.literal("date_field"), dateFieldId: z.string().min(1) }),
]);
export type FieldExpiry = z.infer<typeof expirySchema>;

// ------------------------------------------------------------
// Convenciones de detección para kyb_registry (compartidas entre el builder
// y el dispatch server-side — única fuente de verdad, client-safe).
// ------------------------------------------------------------
// Nº de registro por key. NO matchea `identifying_information.*` (tax id tipo
// EIN/VAT — suele diferir del nº registral).
export const KYB_REG_NUMBER_RE = /registration_number|company_number|registry_number|reg_number/i;
export const KYB_REG_NUMBER_EXCLUDE_RE = /identifying_information/i;

// País del registro, por prioridad: incorporación explícita → dirección
// registrada → cualquier `country` que no sea de un emisor de documento.
export const KYB_COUNTRY_RES: { re: RegExp; exclude?: RegExp }[] = [
  { re: /incorporation_country|country_of_incorporation|registration_country/i },
  { re: /registered_address\.country/i },
  { re: /(^|[._])country$/i, exclude: /issuing/i },
];

/** ¿Alguna pregunta del form puede resolver el país (por tipo o convención de key)? */
export function hasKybCountryCandidate(def: FormDefinition): boolean {
  return def.sections.some((s) =>
    s.fields.some(
      (f) =>
        f.type === "country" ||
        KYB_COUNTRY_RES.some((spec) => spec.re.test(f.key) && !spec.exclude?.test(f.key)),
    ),
  );
}

// ============================================================
// Condiciones (lógica)
// ============================================================
export const CONDITION_OPS = [
  "eq",
  "neq",
  "in",
  "not_in",
  "answered",
  "gt",
  "lt",
] as const;
export type ConditionOp = (typeof CONDITION_OPS)[number];

export type Condition =
  | { field: string; op: ConditionOp; value?: unknown }
  | { all: Condition[] }
  | { any: Condition[] };

const conditionLeaf = z.object({
  field: z.string().min(1),
  op: z.enum(CONDITION_OPS),
  value: z.unknown().optional(),
});

export const conditionSchema: z.ZodType<Condition> = z.lazy(() =>
  z.union([
    conditionLeaf,
    z.object({ all: z.array(conditionSchema) }),
    z.object({ any: z.array(conditionSchema) }),
  ]),
);

// ============================================================
// Campo, sección, formulario
// ============================================================
export const optionSchema = z.object({
  value: z.string(),
  label: localizedTextSchema,
  image: z.string().optional(), // URL pública de imagen de ayuda (opcional)
  // Solo en `multiple_choice`: la opción no se combina con otras («Ninguna»).
  exclusive: z.boolean().optional(),
});
export type FormOption = z.infer<typeof optionSchema>;

export const fileConfigSchema = z.object({
  accept: z.array(z.string()).default([]),
  multiple: z.boolean().default(false),
  maxSizeMB: z.number().positive().default(15),
});

export const validationSchema = z
  .object({
    minLen: z.number().int().nonnegative().optional(),
    maxLen: z.number().int().positive().optional(),
    min: z.number().optional(),
    max: z.number().optional(),
    pattern: z.string().optional(),
    // Solo en `number`: exige un entero.
    integer: z.boolean().optional(),
  })
  .optional();

/** Presets de tamaño de la imagen de ayuda. Ausente = "md" (tamaño histórico). */
export const imageSizeSchema = z.enum(["sm", "md", "lg", "full"]);
export type ImageSize = z.infer<typeof imageSizeSchema>;

export const fieldSchema = z.object({
  id: z.string().min(1),
  key: z.string().min(1),
  type: fieldTypeSchema,
  label: localizedTextSchema,
  help: localizedTextSchema.optional(),
  image: z.string().optional(), // URL pública de imagen de ayuda (opcional)
  imageSize: imageSizeSchema.optional(), // ausente = "md"
  placeholder: localizedTextSchema.optional(),
  required: z.boolean().default(false),
  options: z.array(optionSchema).optional(),
  file: fileConfigSchema.optional(),
  validation: validationSchema,
  visibleIf: conditionSchema.optional(),
  review: reviewSchema.optional(),
  expiry: expirySchema.optional(),
});
export type Field = z.infer<typeof fieldSchema>;

export const SUBMIT = "SUBMIT" as const;

export const navRuleSchema = z.object({
  when: conditionSchema,
  goTo: z.string().min(1), // id de sección o "SUBMIT"
});
export type NavRule = z.infer<typeof navRuleSchema>;

export const sectionSchema = z.object({
  id: z.string().min(1),
  title: localizedTextSchema,
  description: localizedTextSchema.optional(),
  visibleIf: conditionSchema.optional(),
  fields: z.array(fieldSchema),
  next: z.array(navRuleSchema).optional(),
  defaultGoTo: z.string().optional(), // sección | "SUBMIT" si no matchea ninguna regla `next`
});
export type Section = z.infer<typeof sectionSchema>;

// ------------------------------------------------------------
// Procedencia de traducciones (i18n): distingue lo que escribió una persona de
// lo que generó la IA, por `path` estable (ver lib/i18n-ai/walk.ts) y locale.
// Vive dentro del `definition` (jsonb) — no requiere migración.
// ------------------------------------------------------------
export const i18nProvenanceSchema = z.object({
  source: z.enum(["ai", "human"]),
  model: z.string().optional(),
  at: z.string().optional(),
});
export type I18nProvenance = z.infer<typeof i18nProvenanceSchema>;

/** path -> locale -> procedencia */
export const i18nMetaSchema = z.record(
  z.string(),
  z.record(z.string(), i18nProvenanceSchema),
);
export type I18nMeta = z.infer<typeof i18nMetaSchema>;

/**
 * Identidad de un formulario del sistema (lib/forms/system/): su clave y la
 * versión de la definición en el código. Va dentro de la definición para que
 * quede congelada en cada solicitud y salga por la API (`form`), así quien la
 * consume sabe con qué contrato leer las respuestas.
 */
export const systemFormMetaSchema = z.object({
  key: z.string().min(1),
  version: z.number().int().positive(),
});
export type SystemFormMeta = z.infer<typeof systemFormMetaSchema>;

export const formMetaSchema = z.object({
  i18n: i18nMetaSchema.optional(),
  system: systemFormMetaSchema.optional(),
});

/** La misma definición sin la marca de formulario del sistema (para una copia). */
export function withoutSystemMeta(def: FormDefinition): FormDefinition {
  if (!def.meta?.system) return def;
  const meta = { ...def.meta };
  delete meta.system;
  return { ...def, meta };
}

// ------------------------------------------------------------
// Preguntas de uso interno: la respuesta de una da el título de la solicitud
// (informe, panel, API) y la de otra el email de contacto. Se guardan por `id`
// de pregunta (el `key` es editable en el builder). Es configuración INTERNA:
// el solicitante nunca la ve (ver `publicDefinition` en ./internalFields.ts).
// Sin refinamientos acá a propósito: una definición vieja que no los cumpla
// fallaría el parse, y una solicitud con esa copia congelada dejaría de abrirse
// (`resolveRequestDefinition` no la reemplaza: ver ./frozen.ts).
// Los invariantes los impone `normalizeInternalFields`.
// ------------------------------------------------------------
export const INTERNAL_ROLES = ["title", "contactEmail"] as const;
export type InternalRole = (typeof INTERNAL_ROLES)[number];

/** Tipos de pregunta que puede tener cada rol interno. */
export const INTERNAL_FIELD_TYPES: Record<InternalRole, FieldType[]> = {
  title: ["short_text"],
  contactEmail: ["email"],
};

export const internalFieldsSchema = z.object({
  title: z.string().optional(),
  contactEmail: z.string().optional(),
});
export type InternalFields = z.infer<typeof internalFieldsSchema>;

export const formDefinitionSchema = z.object({
  version: z.literal(1).default(1),
  title: localizedTextSchema,
  locales: z.array(z.string()).min(1).default(["es", "en"]),
  defaultLocale: z.string().default("es"),
  sections: z.array(sectionSchema),
  meta: formMetaSchema.optional(),
  internalFields: internalFieldsSchema.optional(),
});
export type FormDefinition = z.infer<typeof formDefinitionSchema>;

// ============================================================
// Helpers de construcción
// ============================================================
export function uid(): string {
  return globalThis.crypto.randomUUID();
}

export function newField(type: FieldType): Field {
  const base: Field = {
    id: uid(),
    key: `f_${uid().slice(0, 8)}`,
    type,
    label: { es: "", en: "" },
    required: false,
  };
  if (isChoiceType(type)) {
    base.options = [{ value: "opcion_1", label: { es: "Opción 1", en: "Option 1" } }];
  }
  if (type === "file") {
    base.file = { accept: [], multiple: false, maxSizeMB: 15 };
  }
  return base;
}

export function newSection(): Section {
  return { id: uid(), title: { es: "", en: "" }, fields: [] };
}

export function emptyForm(): FormDefinition {
  return {
    version: 1,
    title: { es: "Nuevo formulario", en: "New form" },
    locales: ["es", "en"],
    defaultLocale: "es",
    sections: [newSection()],
  };
}

export function countFields(def: FormDefinition): number {
  return def.sections.reduce((n, s) => n + s.fields.length, 0);
}
