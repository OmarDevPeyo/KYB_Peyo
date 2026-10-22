import "server-only";
import { headers } from "next/headers";
import { env } from "@/lib/env";
import { normalizeIpCountry } from "@/lib/kyb/ipCountry";
import {
  EMPTY_SUBMISSION_CONTEXT,
  submissionContextFromHeaders,
  type SubmissionContext,
} from "@/lib/kyb/submissionContext";

/**
 * Desde dónde hace el pedido el solicitante: país, IP, región y ciudad de la IP,
 * y el user agent (ver lib/kyb/submissionContext.ts).
 *
 * Lo calcula Vercel y lo manda en sus headers. Fuera de Vercel esos headers los
 * puede poner cualquiera, así que no se leen: en desarrollo se usa
 * `KYB_DEV_IP_COUNTRY` para poder probar el país, y en cualquier otro caso no
 * hay dato.
 */
export async function clientSubmissionContext(): Promise<SubmissionContext> {
  if (env.onVercel()) return submissionContextFromHeaders(await headers());
  if (process.env.NODE_ENV !== "production") {
    return { ...EMPTY_SUBMISSION_CONTEXT, ipCountry: normalizeIpCountry(env.devIpCountry()) };
  }
  return EMPTY_SUBMISSION_CONTEXT;
}
