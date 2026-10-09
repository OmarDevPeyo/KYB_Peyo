"use server";

import { getAuthState } from "@/lib/auth/admin";
import { authErrorKey } from "@/lib/auth/authErrors";
import { passwordIssues } from "@/lib/auth/passwordPolicy";
import { checkCurrentPassword } from "@/lib/auth/stepUp";
import { createServerSupabase } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";

/**
 * Primer ingreso: la persona entró con la contraseña temporal del correo y
 * elige la suya.
 *
 * La contraseña se cambia con SU sesión (`updateUser`): el update de admin
 * cierra todas las sesiones de la cuenta, también esta, y la mandaría de nuevo
 * al login. La marca `must_change_password` vive en app_metadata (la persona
 * no la puede tocar), así que esa sí se limpia con service role. Después se
 * cierran las otras sesiones: si alguien más leyó el correo y entró con la
 * temporal, queda afuera.
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

  const supabase = await createServerSupabase();
  const { error } = await supabase.auth.updateUser({ password });
  if (error) return { ok: false, error: `auth.${authErrorKey(error)}` };

  const { error: flagError } = await createServiceClient().auth.admin.updateUserById(s.userId, {
    app_metadata: { must_change_password: false },
  });
  if (flagError) {
    console.error("[welcome] no se pudo limpiar must_change_password:", flagError.message);
    return { ok: false, error: "auth.errGeneric" };
  }
  const { error: signOutError } = await supabase.auth.signOut({ scope: "others" });
  if (signOutError) console.error("[welcome] no se cerraron las otras sesiones:", signOutError.message);
  return { ok: true };
}
