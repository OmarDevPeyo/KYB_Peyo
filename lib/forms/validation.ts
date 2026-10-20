// Extensiones explícitas y sin alias `@/`: este módulo se prueba con
// `node --test --experimental-strip-types`, cuyo resolutor de ESM las exige.
import { z } from "zod";
import type { Field } from "./definition.ts";
import { NAICS_CODE_RE, choiceProblem } from "./choices.ts";
import { isNaicsCode } from "./naics.ts";

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
    case "naics": {
      // Forma (choiceRefine) y, además, que el código exista en NAICS 2022.
      const s = z.string();
      return (req ? s.min(1, m.required) : s.optional().or(z.literal(""))).superRefine(
        (x, ctx) => {
          choiceRefine(x, ctx);
          if (typeof x === "string" && NAICS_CODE_RE.test(x) && !isNaicsCode(x)) {
            ctx.addIssue({ code: "custom", message: m.option });
          }
        },
      );
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
