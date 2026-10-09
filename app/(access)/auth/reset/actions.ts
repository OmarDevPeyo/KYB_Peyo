"use server";

import { getAuthState } from "@/lib/auth/admin";
import { authErrorKey } from "@/lib/auth/authErrors";
import { sendPasswordChangedMail } from "@/lib/auth/accountMail";
import { passwordIssues } from "@/lib/auth/passwordPolicy";
import { createServerSupabase } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";

/**
 * Nueva contraseña desde el link del correo (la sesión la dejó /auth/confirm).
 * Va por el server para mandar el aviso de "tu contraseña cambió" (lo manda la
 * app, no Supabase) y para dar por cumplido el cambio obligatorio del primer
 * ingreso si estaba pendiente. `error` es una clave "auth.*".
 */
export async function completePasswordResetAction(
  password: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const state = await getAuthState();
  if (!state.signedIn || !state.userId) return { ok: false, error: "auth.errSessionExpired" };
  // Con 2FA, el link solo da aal1: Supabase rechazaría el cambio igual.
  if (state.mfaPending) return { ok: false, error: "auth.errNeedsMfa" };
  if (passwordIssues(password).length > 0) return { ok: false, error: "auth.errWeakPassword" };

  const supabase = await createServerSupabase();
  const { data, error } = await supabase.auth.updateUser({ password });
  if (error) return { ok: false, error: `auth.${authErrorKey(error)}` };

  if (data.user?.app_metadata?.must_change_password === true) {
    const { error: flagError } = await createServiceClient().auth.admin.updateUserById(state.userId, {
      app_metadata: { must_change_password: false },
    });
    if (flagError) console.error("[reset] no se pudo limpiar must_change_password:", flagError.message);
  }
  if (state.email) await sendPasswordChangedMail(state.email);
  return { ok: true };
}
