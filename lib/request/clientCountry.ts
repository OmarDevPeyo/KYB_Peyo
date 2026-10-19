import "server-only";
import { headers } from "next/headers";
import { env } from "@/lib/env";
import { normalizeIpCountry } from "@/lib/kyb/ipCountry";

/**
 * País (ISO alpha-2) de la IP de quien hace el pedido, o null.
 *
 * Lo calcula Vercel y lo manda en `x-vercel-ip-country`. Fuera de Vercel ese
 * header lo puede poner cualquiera, así que no se lee: en desarrollo se usa
 * `KYB_DEV_IP_COUNTRY` para poder probar, y en cualquier otro caso no hay dato.
 */
export async function clientCountry(): Promise<string | null> {
  if (env.onVercel()) {
    const h = await headers();
    return normalizeIpCountry(h.get("x-vercel-ip-country"));
  }
  if (process.env.NODE_ENV !== "production") return normalizeIpCountry(env.devIpCountry());
  return null;
}
