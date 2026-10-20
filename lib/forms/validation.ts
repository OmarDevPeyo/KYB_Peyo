// Extensiones explícitas y sin alias `@/`: este módulo se prueba con
// `node --test --experimental-strip-types`, cuyo resolutor de ESM las exige.
import { z } from "zod";
import type { Field } from "./definition.ts";
import { COUNTRY_A2_TO_A3 } from "./countries.ts";

const MSG: Record<
  string,
  { required: string; email: string; option: string; exclusive: string; integer: string }
> = {
  es: {
    required: "Requerido",
    email: "Email inválido",
    option: "Elige una de las opciones",
    exclusive: "Esa opción no se combina con otras",
    integer: "Ingresa un número entero",
  },
  en: {
    required: "Required",
    email: "Invalid email",
    option: "Choose one of the options",
    exclusive: "That option can't be combined with others",
    integer: "Enter a whole number",
  },
};

function msg(locale: string) {
  return MSG[locale] ?? MSG.es;
}

const COUNTRY_CODES = new Set(Object.values(COUNTRY_A2_TO_A3));

/** ¿Es un código de país que ofrece el selector (ISO alpha-3)? */
export function isCountryCode(v: unknown): boolean {
  return typeof v === "string" && COUNTRY_CODES.has(v);
}

export type ChoiceProblem = "invalid_option" | "exclusive";

/**
 * Qué tiene de malo una respuesta NO vacía de elección o de país, o `null` si
 * está bien. Antes cualquier texto pasaba: un POST armado a mano guardaba un
 * valor que el formulario nunca ofreció, y lo leían el informe, la API y la
 * calificación de quien consume las respuestas.
 *
 * - single_choice / dropdown: el valor tiene que ser una de las opciones.
 * - multiple_choice: cada valor también, sin repetidos, y una opción
 *   `exclusive` («Ninguna») va sola.
 * - country: un alpha-3 del selector.
 *
 * Una pregunta de elección sin opciones no se controla: no hay contra qué.
 * Lo comparten el navegador (DynamicForm) y el servidor (fieldZod).
 */
export function choiceProblem(field: Field, value: unknown): ChoiceProblem | null {
  if (field.type === "country") return isCountryCode(value) ? null : "invalid_option";
  const options = field.options ?? [];
  if (options.length === 0) return null;
  const allowed = new Set(options.map((o) => o.value));
  switch (field.type) {
    case "single_choice":
    case "dropdown":
      return typeof value === "string" && allowed.has(value) ? null : "invalid_option";
    case "multiple_choice": {
      if (!Array.isArray(value)) return "invalid_option";
      if (value.some((v) => typeof v !== "string" || !allowed.has(v))) return "invalid_option";
      if (new Set(value).size !== value.length) return "invalid_option";
      const exclusive = new Set(options.filter((o) => o.exclusive).map((o) => o.value));
      if (value.length > 1 && value.some((v) => exclusive.has(v as string))) return "exclusive";
      return null;
    }
    default:
      return null;
  }
}

/**
 * Selección de `multiple_choice` tras marcar o desmarcar `option`: marcar una
 * opción excluyente deja solo esa, y marcar otra quita las excluyentes.
 */
export function toggleChoice(
  field: Field,
  current: string[],
  option: string,
  checked: boolean,
): string[] {
  if (!checked) return current.filter((v) => v !== option);
  const exclusive = new Set((field.options ?? []).filter((o) => o.exclusive).map((o) => o.value));
  if (exclusive.has(option)) return [option];
  return [...current.filter((v) => v !== option && !exclusive.has(v)), option];
}

/** Construye el Zod de un campo según su tipo, requerido y validaciones. */
export function fieldZod(field: Field, locale = "es"): z.ZodTypeAny {
  const m = msg(locale);
  const v = field.validation ?? {};
  const req = field.required;
  const choiceRefine = (x: unknown, ctx: z.RefinementCtx) => {
    const empty = x == null || x === "" || (Array.isArray(x) && x.length === 0);
    if (empty) return;
    const problem = choiceProblem(field, x);
    if (problem) {
      ctx.addIssue({ code: "custom", message: problem === "exclusive" ? m.exclusive : m.option });
    }
  };

  switch (field.type) {
    case "email": {
      const s = z.string().email(m.email);
      if (!req) return s.optional().or(z.literal(""));
      return s.min(1, m.required);
    }
    case "short_text":
    case "long_text": {
      let s = z.string();
      if (v.minLen != null) s = s.min(v.minLen);
      if (v.maxLen != null) s = s.max(v.maxLen);
      if (v.pattern) s = s.regex(new RegExp(v.pattern));
      if (!req) return s.optional().or(z.literal(""));
      return s.min(1, m.required);
    }
    case "number": {
      let n = z.coerce.number();
      if (v.min != null) n = n.min(v.min);
      if (v.max != null) n = n.max(v.max);
      if (v.integer) n = n.int(m.integer);
      // Un campo que se llenó y después se borró llega como "" o null, no como
      // `undefined`, y `z.coerce.number()` los convierte en 0. Sin este
      // pre-tratamiento el 0 se cuela por los dos lados: un opcional vacío
      // fallaría contra cualquier `min` mayor que 0, y un requerido vacío
      // PASARÍA haciéndose pasar por un 0 legítimo.
      const blank = (x: unknown) => (x === "" || x === null ? undefined : x);
      return req ? z.preprocess(blank, n) : z.preprocess(blank, n.optional());
    }
    case "date": {
      const s = z.string();
      return req ? s.min(1, m.required) : s.optional().or(z.literal(""));
    }
    case "single_choice":
    case "dropdown":
    case "country": {
      const s = z.string();
      return (req ? s.min(1, m.required) : s.optional().or(z.literal(""))).superRefine(
        choiceRefine,
      );
    }
    case "multiple_choice": {
      const a = z.array(z.string());
      return (req ? a.min(1, m.required) : a.optional()).superRefine(choiceRefine);
    }
    case "selfie":
    case "file": {
      // Las respuestas de archivo/selfie son arrays de referencias { path, filename }.
      const a = z.array(z.any());
      return req ? a.min(1, m.required) : a.optional();
    }
    case "boolean": {
      const b = z.boolean();
      return req ? b.refine((x) => x === true, { message: m.required }) : b.optional();
    }
    default:
      return z.any().optional();
  }
}

/** Objeto Zod para un conjunto de campos (clave = field.key). */
export function buildZod(
  fields: Field[],
  locale = "es",
): z.ZodObject<Record<string, z.ZodTypeAny>> {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const f of fields) {
    if (f.type === "note") continue; // display-only, sin respuesta
    shape[f.key] = fieldZod(f, locale);
  }
  return z.object(shape);
}
