/**
 * Consultas sobre el catálogo NAICS 2022 de 6 dígitos (./naics-2022.ts, que
 * genera scripts/naics/build-naics.mjs). Lo usan el tipo de pregunta `naics`
 * (validación en el servidor, respuesta legible) y su selector.
 *
 * Client-safe, pero pesado: el navegador lo carga a demanda (`import()` en
 * NaicsField) para no sumarlo al formulario. Por eso el control de FORMATO que
 * comparte con el navegador vive aparte, en ./choices.ts.
 *
 * Extensiones explícitas y sin alias `@/`: se prueba con `node --test`.
 */
import { NAICS_2022, type NaicsEntry } from "./naics-2022.ts";

export type { NaicsEntry };

const BY_CODE: ReadonlyMap<string, NaicsEntry> = new Map(NAICS_2022.map((e) => [e[0], e]));

/** ¿Es un código de 6 dígitos que existe en NAICS 2022? */
export function isNaicsCode(v: unknown): boolean {
  return typeof v === "string" && BY_CODE.has(v);
}

/** Título del código en el idioma pedido (español o, si no, inglés). */
export function naicsTitle(code: string, locale: string): string | undefined {
  const e = BY_CODE.get(code);
  if (!e) return undefined;
  return locale === "es" ? e[2] : e[1];
}

/** «541511 · Servicios de programación…», o el código solo si no se conoce. */
export function formatNaics(code: string, locale: string): string {
  const title = naicsTitle(code, locale);
  return title ? `${code} · ${title}` : code;
}

/** Minúsculas y sin tildes, para buscar «programacion» y encontrar «programación». */
function fold(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

const FOLDED: readonly { entry: NaicsEntry; text: string }[] = NAICS_2022.map((entry) => ({
  entry,
  text: fold(`${entry[1]} ${entry[2]}`),
}));

/**
 * Búsqueda del selector. Con dígitos busca por prefijo del código («5415»
 * trae todo el grupo); con palabras exige todas, en cualquier orden y en
 * cualquiera de los dos idiomas. Sin consulta no devuelve nada: 1.012 opciones
 * no se recorren a ojo.
 */
export function searchNaics(query: string, limit = 50): NaicsEntry[] {
  const q = query.trim();
  if (!q) return [];
  if (/^\d+$/.test(q)) return NAICS_2022.filter((e) => e[0].startsWith(q)).slice(0, limit);
  const words = fold(q).split(/\s+/).filter(Boolean);
  const out: NaicsEntry[] = [];
  for (const { entry, text } of FOLDED) {
    if (words.every((w) => text.includes(w))) {
      out.push(entry);
      if (out.length >= limit) break;
    }
  }
  return out;
}
