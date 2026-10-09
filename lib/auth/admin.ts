import "server-only";
import { cache } from "react";
import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { createServerSupabase } from "@/lib/supabase/server";
import type { Role } from "./tenantRules";
import { mfaGate } from "./mfaGate";
import {
  PORTAL_COOKIE,
  accountState,
  loginPath,
  parsePortal,
  type AccountState,
} from "./accountRules";

export interface Analyst {
  userId: string;
  email: string;
  role: Role;
  /** Organización a la que pertenece (ver 0025_organizations.sql). */
  orgId: string;
  orgName: string;
  fullName: string | null;
  /** Tiene 2FA (TOTP) verificado. Gestionar cuentas lo exige. */
  mfaEnabled: boolean;
}

/**
 * Estado de la sesión. `state` es la fuente de verdad (ver accountState); los
 * demás campos son atajos para las pantallas de acceso.
 */
export type AuthState = {
  state: AccountState;
  signedIn: boolean;
  mfaPending: boolean;
  suspended: "user" | "org" | null;
  /** Usuario de Auth y su email, aunque no sea analista o esté suspendido. */
  userId: string | null;
  email: string | null;
  /** Rol de su fila de analista, si tiene (también con 2FA pendiente). */
  role: Role | null;
  /** Solo con la cuenta activa. */
  analyst: Analyst | null;
};

const SIGNED_OUT: AuthState = {
  state: { kind: "signed_out" },
  signedIn: false,
  mfaPending: false,
  suspended: null,
  userId: null,
  email: null,
  role: null,
  analyst: null,
};

/**
 * `cache()`: el layout, la página y cada `isAdmin()` lo piden en el mismo
 * render, y sin memo cada llamada era un `getUser()` de red.
 *
 * Orden (accountState): fila propia de `analysts` → 2FA → suspensión del
 * usuario → org. La fila propia se lee aun a aal1 o suspendido (la política de
 * `analysts` deja leer siempre la propia), así el rol se conoce desde el login.
 * La org, en cambio, pasa por la RLS (auth_org_ids / is_platform_admin): si no
 * se puede leer o está deshabilitada, la org está suspendida.
 */
const resolveAnalyst = cache(async (): Promise<AuthState> => {
  const supabase = await createServerSupabase();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return SIGNED_OUT;

  const { data: row } = await supabase
    .from("analysts")
    .select("user_id, email, role, org_id, full_name, disabled_at")
    .eq("user_id", user.id)
    .maybeSingle();

  // 2FA: los factores salen de getUser() (servidor de Auth), no de la cookie.
  const verifiedFactors = (user.factors ?? []).filter((f) => f.status === "verified").length;
  let mfaPending = false;
  if (verifiedFactors > 0) {
    const { data: aal } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
    mfaPending = mfaGate({ currentLevel: aal?.currentLevel, verifiedFactors }) === "pending";
  }

  type OrgRow = { name: string; disabled_at: string | null };
  let org: OrgRow | null = null;
  if (row && !mfaPending && !row.disabled_at) {
    const { data } = await supabase
      .from("organizations")
      .select("name, disabled_at")
      .eq("id", row.org_id as string)
      .maybeSingle();
    org = (data as OrgRow | null) ?? null;
  }

  const role = (row?.role as Role | undefined) ?? null;
  const state = accountState({
    signedIn: true,
    row: row && role ? { role, disabled: Boolean(row.disabled_at) } : null,
    mfaPending,
    orgUsable: Boolean(org && !org.disabled_at),
    // app_metadata solo lo escribe el service role (la persona no puede
    // sacárselo); viene de getUser(), no de la cookie.
    mustChangePassword: user.app_metadata?.must_change_password === true,
  });

  return {
    state,
    signedIn: true,
    mfaPending: state.kind === "mfa_pending",
    suspended: state.kind === "suspended" ? state.scope : null,
    userId: user.id,
    email: user.email ?? null,
    role,
    analyst:
      state.kind === "active" && row && org
        ? {
            userId: row.user_id as string,
            // El email de Auth es la fuente de verdad (el usuario lo puede
            // cambiar); `analysts.email` es una copia.
            email: user.email ?? (row.email as string),
            role: row.role as Role,
            orgId: row.org_id as string,
            orgName: org.name,
            fullName: (row.full_name as string | null) ?? null,
            mfaEnabled: verifiedFactors > 0,
          }
        : null,
  };
});

/** Estado completo de la sesión (para las pantallas de acceso). */
export async function getAuthState(): Promise<AuthState> {
  return resolveAnalyst();
}

/**
 * Analista autenticado y ACTIVO, o `null` (también con el 2FA pendiente o
 * suspendido). Variante sin redirect para Route Handlers, que deben responder
 * 401 JSON a un `fetch` en vez de mandar un redirect.
 */
export async function getAnalyst(): Promise<Analyst | null> {
  return (await resolveAnalyst()).analyst;
}

/** Login al que volver: el del rol si se conoce, si no el de la última visita. */
export async function loginPathFor(role: Role | null): Promise<string> {
  if (role) return loginPath(role === "admin" ? "admin" : "user");
  return loginPath(parsePortal((await cookies()).get(PORTAL_COOKIE)?.value));
}

/**
 * Exige un analista activo. Si no: al login, al paso del código (2FA), a la
 * pantalla de cuenta suspendida, a elegir su contraseña (primer ingreso) o al
 * login con "sin acceso".
 */
export async function requireAnalyst(): Promise<Analyst> {
  const s = await resolveAnalyst();
  switch (s.state.kind) {
    case "signed_out":
      redirect(await loginPathFor(null));
    case "mfa_pending":
      redirect("/auth/mfa");
    case "suspended":
      redirect("/auth/suspended");
    case "password_setup":
      redirect("/auth/welcome");
    case "no_account":
      redirect(`${await loginPathFor(null)}?error=forbidden`);
    case "active":
      return s.analyst!;
  }
}

/**
 * Exige rol `admin` (de plataforma), no solo ser analista. Para cualquier otro
 * la página o la acción "no existe" (404): no se anuncia qué hay detrás.
 *
 * Ojo: `analysts.role` tiene default `'analyst'` (0001_init.sql), así que un
 * panel sin ninguna fila con `role='admin'` deja estas acciones inaccesibles
 * para todos.
 */
export async function requireAdmin(): Promise<Analyst> {
  const analyst = await requireAnalyst();
  if (analyst.role !== "admin") notFound();
  return analyst;
}

/** Variante sin redirect, para Server Actions que responden un `Result`. */
export async function isAdmin(): Promise<boolean> {
  return (await getAnalyst())?.role === "admin";
}
