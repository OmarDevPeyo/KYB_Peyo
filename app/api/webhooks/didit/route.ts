import { NextRequest, NextResponse } from "next/server";
import { createHmac, timingSafeEqual } from "crypto";
import { env } from "@/lib/env";
import { createServiceClient } from "@/lib/supabase/service";
import { logAudit } from "@/lib/kyb/service";
import { syncRequestExpirations } from "@/lib/kyb/expirations";
import { alreadySeen, markSeen } from "@/lib/kyb/replayGuard";
import type { AmlStatus } from "@/lib/kyb/types";

export const runtime = "nodejs";

/** Verifica la firma HMAC-SHA256 del webhook (esquema por confirmar con DIDIT). */
function verifySignature(rawBody: string, signature: string | null): boolean {
  const secret = env.diditWebhookSecret();
  if (!secret) return false;
  if (!signature) return false;
  const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Normaliza el estado de DIDIT a nuestro enum (mapa por definir). */
function mapStatus(raw: string | undefined): AmlStatus {
  switch ((raw ?? "").toLowerCase()) {
    case "clear":
    case "passed":
    case "approved":
      return "passed";
    case "hit":
    case "flagged":
    case "match":
      return "flagged";
    case "error":
    case "failed":
      return "error";
    default:
      return "pending";
  }
}

/**
 * POST /api/webhooks/didit
 * Recibe el resultado asíncrono del check AML y actualiza aml_checks.
 * TODO(DIDIT): ajustar nombre del header de firma y forma del payload.
 */
export async function POST(req: NextRequest) {
  const raw = await req.text();
  const signature = req.headers.get("x-didit-signature");

  if (!verifySignature(raw, signature)) {
    return NextResponse.json({ error: "invalid_signature" }, { status: 401 });
  }

  // La firma valida el origen, no la frescura: sin esto, una entrega capturada
  // se podía reenviar cuando quisiera y volvía a escribir aml_checks, pisando
  // un resultado más nuevo con uno viejo.
  if (await alreadySeen("didit", raw)) {
    console.warn("[DIDIT] webhook repetido, ignorado");
    return NextResponse.json({ ok: true, ignored: "replay" });
  }

  let payload: { reference?: string; id?: string; status?: string };
  try {
    payload = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const externalRef = payload.id ?? payload.reference;
  if (!externalRef) {
    return NextResponse.json({ error: "missing_reference" }, { status: 422 });
  }

  const supabase = createServiceClient();
  const status = mapStatus(payload.status);

  const { data: check } = await supabase
    .from("aml_checks")
    .update({ status, result: payload })
    .eq("external_ref", externalRef)
    .select("request_id")
    .maybeSingle();

  if (check?.request_id) {
    await logAudit({
      requestId: check.request_id,
      actor: "system",
      action: "aml_webhook",
      metadata: { status, externalRef },
    });
    // El payload reemplaza el resultado: el vencimiento de un carnet sale de ahí.
    await syncRequestExpirations(check.request_id);
  }

  await markSeen("didit", raw);
  return NextResponse.json({ ok: true });
}
