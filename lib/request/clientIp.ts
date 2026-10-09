import "server-only";
import { headers } from "next/headers";

/** IP de quien hace el pedido según el proxy. En Vercel la pone la plataforma. */
export async function clientIp(): Promise<string> {
  const h = await headers();
  const forwarded = h.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0]!.trim();
  return h.get("x-real-ip") ?? "desconocida";
}
