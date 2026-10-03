"use server";

import { revalidatePath } from "next/cache";
import { requireAnalyst } from "@/lib/auth/admin";
import { loadOwnedExpiration } from "@/lib/auth/tenant";
import { createServiceClient } from "@/lib/supabase/service";
import { parseExpiryDate } from "@/lib/forms/expiry";
import { logAudit } from "@/lib/kyb/service";
import { syncRequestExpirations } from "@/lib/kyb/expirations";

/** `error` es una clave de i18n (el panel es bilingüe). */
type Result = { ok: true } | { ok: false; error: string };

/**
 * Corrige a mano la fecha de vencimiento de un documento (o quita la
 * corrección, con `null`). La corrección gana sobre la fecha de DIDIT o la
 * declarada, y vale mientras el documento sea el mismo: un documento nuevo la
 * descarta (ver computeExpirations).
 */
export async function setExpiryOverrideAction(
  expirationId: string,
  date: string | null,
): Promise<Result> {
  const analyst = await requireAnalyst();
  const row = await loadOwnedExpiration(
    analyst,
    expirationId,
    "id, field_key, expires_on, override_expires_on",
  );
  if (!row) return { ok: false, error: "expirations.errNotFound" };

  let value: string | null = null;
  if (date !== null) {
    value = parseExpiryDate(date);
    if (!value) return { ok: false, error: "expirations.errInvalidDate" };
  }

  const { error } = await createServiceClient()
    .from("document_expirations")
    .update(
      value
        ? {
            override_expires_on: value,
            override_by: analyst.userId,
            override_by_email: analyst.email,
            override_at: new Date().toISOString(),
          }
        : {
            override_expires_on: null,
            override_by: null,
            override_by_email: null,
            override_at: null,
          },
    )
    .eq("id", expirationId);
  if (error) return { ok: false, error: "expirations.errSave" };

  // `expires_on`, el origen y el aviso se recalculan con la corrección aplicada.
  const requestId = row.request_id as string;
  await syncRequestExpirations(requestId);
  await logAudit({
    requestId,
    actor: analyst.email,
    actorUserId: analyst.userId,
    action: value ? "expiry_overridden" : "expiry_override_cleared",
    metadata: { fieldKey: row.field_key, from: row.expires_on ?? null, to: value },
  });

  revalidatePath("/admin/expirations");
  revalidatePath(`/admin/requests/${requestId}`);
  return { ok: true };
}
