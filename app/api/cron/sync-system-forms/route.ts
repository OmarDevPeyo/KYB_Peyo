import { NextRequest, NextResponse } from "next/server";
import { cronGuard } from "@/lib/auth/cronGuard";
import { syncSystemForms } from "@/lib/forms/system/sync";

export const runtime = "nodejs";

/**
 * GET /api/cron/sync-system-forms — deja al día las instalaciones de los
 * formularios del sistema (lib/forms/system/) con la definición del código
 * desplegado. Sube la revisión solo si algo cambió, con compare-and-set.
 *
 * Corre en la app ya desplegada a propósito, no en el release: ahí correría el
 * código viejo. Autorizado por `Authorization: Bearer $CRON_SECRET`.
 */
export async function GET(req: NextRequest) {
  const denied = cronGuard(req);
  if (denied) return denied;
  const report = await syncSystemForms();
  if (report.updated.length || report.conflicts.length) {
    console.log(
      `[system-forms] actualizados=${report.updated.join(",") || "-"} conflictos=${report.conflicts.join(",") || "-"}`,
    );
  }
  return NextResponse.json(report);
}
