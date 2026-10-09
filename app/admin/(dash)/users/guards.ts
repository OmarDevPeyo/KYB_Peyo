import "server-only";
import { revalidatePath } from "next/cache";
import { requireAdmin, type Analyst } from "@/lib/auth/admin";
import { getAccount, listActiveAdmins, type AccountRow } from "@/lib/auth/accounts";
import { canManageAccount, type AccountAction } from "@/lib/auth/accountRules";
import { isUuid } from "@/lib/auth/tenantRules";
import { checkCurrentPassword } from "@/lib/auth/stepUp";
import { consumeRate } from "@/lib/auth/rateLimit";

/**
 * Helpers de las acciones de cuentas. Viven FUERA del archivo "use server" a
 * propósito: todo lo que exporta un módulo de Server Actions se puede invocar
 * desde el navegador, y `stepUp` recibe al actor por parámetro (sería un
 * oráculo para probar contraseñas ajenas).
 */

export type AccountResult = { ok: true } | { ok: false; error: string };

type Gate = { ok: true; actor: Analyst } | { ok: false; error: string };

/** Admin (404 si no) con 2FA activo: sin 2FA no se gestionan cuentas. */
export async function accountAdmin(): Promise<Gate> {
  const actor = await requireAdmin();
  if (!actor.mfaEnabled) return { ok: false, error: "accounts.errNeeds2fa" };
  return { ok: true, actor };
}

/** Vuelve a pedir la contraseña del admin (acciones sensibles). */
export async function stepUp(actor: Analyst, password: string | undefined): Promise<string | null> {
  const check = await checkCurrentPassword(actor.userId, password ?? "");
  if (check === "ok") return null;
  return check === "limited" ? "auth.errRateLimit" : "accounts.errStepUp";
}

/** Correos de cuentas (accesos y links) por admin y minuto. */
const ACCOUNT_MAILS_PER_MIN = 5;

/** Frena a un admin (o una sesión robada) que dispara correos en serie. */
export async function mailRate(actor: Analyst): Promise<string | null> {
  const rate = await consumeRate(`acctmail:${actor.userId}`, ACCOUNT_MAILS_PER_MIN);
  return rate.allowed ? null : "auth.errRateLimit";
}

/** Traduce los errores de los triggers y constraints de 0028. */
export function dbErrorKey(error: { message?: string; code?: string } | null): string {
  const msg = error?.message ?? "";
  if (msg.includes("last_admin")) return "accounts.errLastAdmin";
  if (msg.includes("org_has_admins")) return "accounts.errOrgHasAdmins";
  if (msg.includes("admin_org_suspended")) return "accounts.errAdminOrgSuspended";
  if (error?.code === "23505") return "accounts.errOrgNameTaken";
  return "auth.errGeneric";
}

const GUARD_ERRORS: Record<string, string> = {
  self: "accounts.errSelf",
  otherAdmin: "accounts.errOtherAdmin",
  suspended: "accounts.errTargetSuspended",
  notSuspended: "accounts.errNotSuspended",
  alreadySuspended: "accounts.errAlreadySuspended",
  pending: "accounts.errPending",
  notPending: "accounts.errNotPending",
};

/** Carga la cuenta destino y aplica la regla de la acción. */
export async function loadTarget(
  actor: Analyst,
  userId: string,
  action: AccountAction,
): Promise<{ ok: true; target: AccountRow } | { ok: false; error: string }> {
  if (!isUuid(userId)) return { ok: false, error: "accounts.errNotFound" };
  const target = await getAccount(userId);
  if (!target) return { ok: false, error: "accounts.errNotFound" };
  const guard = canManageAccount(
    actor.userId,
    {
      userId: target.userId,
      role: target.role,
      suspended: target.status === "suspended",
      pending: target.pending,
    },
    action,
  );
  return guard ? { ok: false, error: GUARD_ERRORS[guard] } : { ok: true, target };
}

export function revalidateAccounts(userId?: string) {
  revalidatePath("/admin/users");
  if (userId) revalidatePath(`/admin/users/${userId}`);
}

/** ¿Es un admin activo que puede figurar como contacto de una suspensión? */
export async function isActiveAdmin(userId: string): Promise<boolean> {
  return (await listActiveAdmins()).some((a) => a.userId === userId);
}
