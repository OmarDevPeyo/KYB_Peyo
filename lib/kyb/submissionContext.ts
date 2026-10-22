/**
 * Desde dónde se envió la solicitud (`kyb_requests.submitted_ip*` y
 * `submitted_user_agent`, migraciones 0034 y 0036): país, IP, región y ciudad
 * de la IP, y el user agent del navegador.
 *
 * Los headers los pone Vercel y los lee lib/request/clientCountry.ts. Acá vive
 * lo que no depende del request: validar cada valor, armar las columnas y
 * serializarlo para la API y el webhook.
 *
 * Sin `import "server-only"` ni alias `@/` a propósito: así se puede probar con
 * `node --test --experimental-strip-types` sin arrastrar el runtime de Next.
 */
import { isIP } from "node:net";
import { normalizeIpCountry } from "./ipCountry.ts";

export type SubmissionContext = {
  /** ISO 3166-1 alpha-2. */
  ipCountry: string | null;
  /** IPv4 o IPv6. */
  ip: string | null;
  /** Código de la subdivisión (ISO 3166-2 sin el país), p. ej. `L`. */
  ipRegion: string | null;
  ipCity: string | null;
  userAgent: string | null;
};

export const EMPTY_SUBMISSION_CONTEXT: SubmissionContext = {
  ipCountry: null,
  ip: null,
  ipRegion: null,
  ipCity: null,
  userAgent: null,
};

/** Columnas de `kyb_requests` que guardan el contexto, para los `select`. */
export const SUBMISSION_CONTEXT_COLUMNS =
  "submitted_ip_country, submitted_ip, submitted_ip_region, submitted_ip_city, submitted_user_agent";

/** El texto de una IPv6 más larga (con IPv4 al final) tiene 45 caracteres. */
export const IP_MAX = 45;
export const IP_CITY_MAX = 120;
export const USER_AGENT_MAX = 512;

// Caracteres de control: un header no debería traerlos, y si los trae no se
// guardan ni se muestran.
const CONTROL = /[\u0000-\u001f\u007f]/g;

/**
 * Una IP válida (v4 o v6), o null. El tope de largo deja afuera una IPv6 con
 * zona (`fe80::1%eth0`), que no es una IP pública y no entra en la columna.
 */
export function normalizeIp(raw: string | null | undefined): string | null {
  const ip = raw?.trim() ?? "";
  return ip && ip.length <= IP_MAX && isIP(ip) ? ip : null;
}

/** El código de región tal como lo manda Vercel (`x-vercel-ip-country-region`), o null. */
export function normalizeIpRegion(raw: string | null | undefined): string | null {
  const code = raw?.trim().toUpperCase() ?? "";
  return /^[A-Z0-9]{1,3}$/.test(code) ? code : null;
}

/**
 * La ciudad de `x-vercel-ip-city`, que llega URL-encoded («S%C3%A3o%20Paulo»).
 * Si no se puede decodificar se queda el texto tal cual: sigue siendo la ciudad,
 * solo que mal escrita.
 */
export function normalizeIpCity(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let city = raw;
  try {
    city = decodeURIComponent(raw);
  } catch {
    // Secuencia `%` inválida: se usa el valor crudo.
  }
  const clean = city.replace(CONTROL, "").replace(/\s+/g, " ").trim().slice(0, IP_CITY_MAX).trim();
  return clean || null;
}

export function normalizeUserAgent(raw: string | null | undefined): string | null {
  const ua = raw?.replace(CONTROL, "").trim().slice(0, USER_AGENT_MAX).trim() ?? "";
  return ua || null;
}

/**
 * El contexto a partir de los headers de Vercel. Solo vale llamarlo en Vercel:
 * fuera de ahí cualquiera los pone (ver lib/request/clientCountry.ts).
 *
 * La IP sale de `x-real-ip` y, si no está, del primer valor de
 * `x-forwarded-for`: Vercel reescribe los dos, así que no los controla el cliente.
 */
export function submissionContextFromHeaders(h: {
  get(name: string): string | null;
}): SubmissionContext {
  const forwarded = h.get("x-forwarded-for")?.split(",")[0] ?? null;
  return {
    ipCountry: normalizeIpCountry(h.get("x-vercel-ip-country")),
    ip: normalizeIp(h.get("x-real-ip")) ?? normalizeIp(forwarded),
    ipRegion: normalizeIpRegion(h.get("x-vercel-ip-country-region")),
    ipCity: normalizeIpCity(h.get("x-vercel-ip-city")),
    userAgent: normalizeUserAgent(h.get("user-agent")),
  };
}

/** Las columnas de `kyb_requests` que se pisan en cada envío. */
export function submissionContextColumns(ctx: SubmissionContext) {
  return {
    submitted_ip_country: ctx.ipCountry,
    submitted_ip: ctx.ip,
    submitted_ip_region: ctx.ipRegion,
    submitted_ip_city: ctx.ipCity,
    submitted_user_agent: ctx.userAgent,
  };
}

/** Una fila de `kyb_requests` con {@link SUBMISSION_CONTEXT_COLUMNS}. */
export type SubmissionContextRow = {
  submitted_ip_country?: string | null;
  submitted_ip?: string | null;
  submitted_ip_region?: string | null;
  submitted_ip_city?: string | null;
  submitted_user_agent?: string | null;
};

/** El contexto de una fila, con null donde no hay dato. */
export function submissionContextOf(row: SubmissionContextRow): SubmissionContext {
  return {
    ipCountry: row.submitted_ip_country ?? null,
    ip: row.submitted_ip ?? null,
    ipRegion: row.submitted_ip_region ?? null,
    ipCity: row.submitted_ip_city ?? null,
    userAgent: row.submitted_user_agent ?? null,
  };
}

/** `submission_context` del webhook: el mismo dato en snake_case. */
export function webhookSubmissionContext(row: SubmissionContextRow) {
  const ctx = submissionContextOf(row);
  return {
    ip_country: ctx.ipCountry,
    ip: ctx.ip,
    ip_region: ctx.ipRegion,
    ip_city: ctx.ipCity,
    user_agent: ctx.userAgent,
  };
}
