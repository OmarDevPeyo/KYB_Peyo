/**
 * País de la IP con que se envía la solicitud (`kyb_requests.submitted_ip_country`).
 *
 * Lo pone Vercel en el header `x-vercel-ip-country` (lo lee
 * lib/request/clientCountry.ts). Acá vive lo que no depende del request: validar
 * el código y compararlo con los países que declaró el solicitante.
 *
 * Sin `import "server-only"` ni alias `@/` a propósito: así se puede probar con
 * `node --test --experimental-strip-types` sin arrastrar el runtime de Next.
 */
import { COUNTRY_A2_TO_A3, alpha3ToAlpha2 } from "../forms/countries.ts";
import type { FormDefinition } from "../forms/definition.ts";
import { reachableFields, type Answers } from "../forms/logic.ts";

/**
 * Código ISO alpha-2 en mayúsculas, o null. Solo pasa un país que exista en el
 * catálogo: un header vacío o un código especial del proveedor (p. ej. `XX`)
 * no se guarda como si fuera un país.
 */
export function normalizeIpCountry(raw: string | null | undefined): string | null {
  const code = raw?.trim().toUpperCase() ?? "";
  return /^[A-Z]{2}$/.test(code) && code in COUNTRY_A2_TO_A3 ? code : null;
}

/**
 * Países (alpha-2, sin repetir) que el solicitante respondió en preguntas de
 * tipo país. Solo cuentan las que llegó a ver: una respuesta que quedó en una
 * rama no tomada no es algo que haya declarado. Los campos país guardan alpha-3.
 */
export function declaredCountries(def: FormDefinition, answers: Answers): string[] {
  const found = new Set<string>();
  for (const field of reachableFields(def, answers)) {
    if (field.type !== "country") continue;
    const value = answers[field.key];
    if (typeof value !== "string") continue;
    const a2 = alpha3ToAlpha2(value);
    if (a2) found.add(a2);
  }
  return [...found];
}

/**
 * ¿Hay que avisarle al analista? Solo si se conoce el país de la IP, el
 * solicitante declaró al menos un país y ninguno coincide. Sin uno de los dos
 * datos no hay nada que comparar.
 */
export function ipCountryMismatch(ipCountry: string | null, declared: string[]): boolean {
  return ipCountry != null && declared.length > 0 && !declared.includes(ipCountry);
}
