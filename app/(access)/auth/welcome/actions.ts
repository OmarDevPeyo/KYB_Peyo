"use server";

import { getAuthState } from "@/lib/auth/admin";
import { passwordIssues } from "@/lib/auth/passwordPolicy";
import { checkCurrentPassword } from "@/lib/auth/stepUp";
import { createServerSupabase } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";

/**
 * Primer ingreso: la persona entró con la contraseña temporal del correo y
 * elige la suya. Va con service role porque la marca `must_change_password`
 * vive en app_metadata (la persona no la puede tocar) y se limpia en el mismo
 * update que la contraseña. Después se cierran las otras sesiones: si alguien
 * más leyó el correo y entró con la temporal, queda afuera.
 *
 * `error` es una clave "auth.*".
 */
export async function setFirstPasswordAction(
  password: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const s = await getAuthState();
  if (s.state.kind !== "password_setup" || !s.userId) return { ok: false, error: "auth.errSessionExpired" };
  if (passwordIssues(password).length > 0) return { ok: false, error: "auth.errWeakPassword" };

  // La del correo no vale: tiene que ser otra. (Con rate limit por usuario.)
  const same = await checkCurrentPassword(s.userId, password);
  if (same === "limited") return { ok: false, error: "auth.errRateLimit" };
  if (same === "ok") return { ok: false, error: "auth.errSamePassword" };

  const { error } = await createServiceClient().auth.admin.updateUserById(s.userId, {
    password,
    app_metadata: { must_change_password: false },
  });
  if (error) {
    return { ok: false, error: error.code === "weak_password" ? "auth.errWeakPassword" : "auth.errGeneric" };
  }
  const { error: signOutError } = await (await createServerSupabase()).auth.signOut({ scope: "others" });
  if (signOutError) console.error("[welcome] no se cerraron las otras sesiones:", signOutError.message);
  return { ok: true };
}
