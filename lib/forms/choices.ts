/**
 * Controles de las respuestas con opciones (elecciones, país y NAICS) que
 * comparten el navegador (DynamicForm) y el servidor (fieldZod, ./validation.ts).
 *
 * Liviano a propósito: el navegador lo importa entero. La existencia de un
 * código NAICS la controla el servidor contra el catálogo (./naics.ts), que en
 * el navegador se carga a demanda.
 *
 * Extensiones explícitas y sin alias `@/`: se prueba con `node --test`.
 */
import type { Field } from "./definition.ts";
import { COUNTRY_A2_TO_A3 } from "./countries.ts";

const COUNTRY_CODES = new Set(Object.values(COUNTRY_A2_TO_A3));

/** ¿Es un código de país que ofrece el selector (ISO alpha-3)? */
export function isCountryCode(v: unknown): boolean {
  return typeof v === "string" && COUNTRY_CODES.has(v);
}

/** Forma de un código NAICS de 6 dígitos (sin mirar si existe). */
export const NAICS_CODE_RE = /^\d{6}$/;

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
 * - naics: 6 dígitos (que exista lo controla el servidor).
 *
 * Una pregunta de elección sin opciones no se controla: no hay contra qué.
 */
export function choiceProblem(field: Field, value: unknown): ChoiceProblem | null {
  if (field.type === "country") return isCountryCode(value) ? null : "invalid_option";
  if (field.type === "naics") {
    return typeof value === "string" && NAICS_CODE_RE.test(value) ? null : "invalid_option";
  }
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
