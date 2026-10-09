import "server-only";
import type { User } from "@supabase/supabase-js";
import { createServiceClient } from "@/lib/supabase/service";
import type { Role } from "./tenantRules";

/**
 * Lectura de cuentas para la página Usuarios (solo admin). Junta la fila de
 * `analysts`, su org y los datos de Supabase Auth (si ya entró, último
 * ingreso, 2FA). Todo con service role: quien llama ya pasó
 * requireAdmin.
 */

export type AccountStatus = "active" | "invited" | "suspended" | "orgSuspended";

export interface AccountRow {
  userId: string;
  email: string;
  fullName: string | null;
  role: Role;
  orgId: string;
  orgName: string;
  orgSuspended: boolean;
  suspendedAt: string | null;
  contactId: string | null;
  contactEmail: string | null;
  /** Nunca entró: todavía no usó la contraseña temporal (o la invitación vieja). */
  pending: boolean;
  lastSignInAt: string | null;
  /** Cuándo se le mandó el acceso por última vez (o la invitación vieja). */
  accessSentAt: string | null;
  mfa: boolean;
  status: AccountStatus;
}

export interface OrgSummary {
  id: string;
  slug: string;
  name: string;
  suspendedAt: string | null;
  contactEmail: string | null;
  users: number;
  activeAdmins: number;
  apiKeys: number;
}

type AnalystRow = {
  user_id: string;
  email: string;
  full_name: string | null;
  role: Role;
  org_id: string;
  disabled_at: string | null;
  suspension_contact_id: string | null;
};

/** Todos los usuarios de Auth (listUsers devuelve de a páginas). */
async function allAuthUsers(): Promise<User[]> {
  const supabase = createServiceClient();
  const users: User[] = [];
  for (let page = 1; ; page++) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw new Error(error.message);
    users.push(...data.users);
    if (data.users.length < 200) return users;
  }
}

/**
 * ¿Nunca entró? Cubre las altas con contraseña temporal (email ya confirmado)
 * y las invitaciones por link de antes.
 */
export function isPendingAccess(user: Pick<User, "last_sign_in_at"> | undefined): boolean {
  return Boolean(user && !user.last_sign_in_at);
}

/** Lo que se guarda en app_metadata al mandar el acceso (ver credentialActions). */
export function accessMetadata(): { must_change_password: true; access_sent_at: string } {
  return { must_change_password: true, access_sent_at: new Date().toISOString() };
}

function statusOf(row: AnalystRow, orgSuspended: boolean, pending: boolean): AccountStatus {
  if (row.disabled_at) return "suspended";
  if (orgSuspended) return "orgSuspended";
  if (pending) return "invited";
  return "active";
}

async function loadAll() {
  const supabase = createServiceClient();
  const [{ data: analysts }, { data: orgs }, { data: mfaIds }, authUsers] = await Promise.all([
    supabase
      .from("analysts")
      .select("user_id, email, full_name, role, org_id, disabled_at, suspension_contact_id"),
    supabase
      .from("organizations")
      .select("id, slug, name, disabled_at, suspension_contact_id")
      .order("name"),
    supabase.rpc("admin_mfa_user_ids"),
    allAuthUsers(),
  ]);
  return {
    analysts: (analysts ?? []) as AnalystRow[],
    orgs: (orgs ?? []) as {
      id: string;
      slug: string;
      name: string;
      disabled_at: string | null;
      suspension_contact_id: string | null;
    }[],
    authById: new Map(authUsers.map((u) => [u.id, u])),
    mfaIds: new Set((mfaIds ?? []) as string[]),
  };
}

function toAccounts(
  analysts: AnalystRow[],
  orgs: { id: string; name: string; disabled_at: string | null }[],
  authById: Map<string, User>,
  mfaIds: Set<string>,
): AccountRow[] {
  const orgById = new Map(orgs.map((o) => [o.id, o]));
  const emailById = new Map(analysts.map((a) => [a.user_id, a.email]));
  return analysts.map((a) => {
    const org = orgById.get(a.org_id);
    const user = authById.get(a.user_id);
    const pending = isPendingAccess(user);
    const orgSuspended = Boolean(org?.disabled_at);
    return {
      userId: a.user_id,
      email: user?.email ?? a.email,
      fullName: a.full_name,
      role: a.role,
      orgId: a.org_id,
      orgName: org?.name ?? "—",
      orgSuspended,
      suspendedAt: a.disabled_at,
      contactId: a.suspension_contact_id,
      contactEmail: a.suspension_contact_id ? (emailById.get(a.suspension_contact_id) ?? null) : null,
      pending,
      lastSignInAt: user?.last_sign_in_at ?? null,
      accessSentAt: (user?.app_metadata?.access_sent_at as string | undefined) ?? user?.invited_at ?? null,
      mfa: mfaIds.has(a.user_id),
      status: statusOf(a, orgSuspended, pending),
    };
  });
}

/** Cuentas, ordenadas por nombre de org y email. */
export async function listAccounts(): Promise<AccountRow[]> {
  const { analysts, orgs, authById, mfaIds } = await loadAll();
  return toAccounts(analysts, orgs, authById, mfaIds).sort(
    (x, y) => x.orgName.localeCompare(y.orgName) || x.email.localeCompare(y.email),
  );
}

export async function getAccount(userId: string): Promise<AccountRow | null> {
  const { analysts, orgs, authById, mfaIds } = await loadAll();
  return toAccounts(analysts, orgs, authById, mfaIds).find((a) => a.userId === userId) ?? null;
}

/**
 * Admins activos (ni suspendidos, ni de una org suspendida, ni con la
 * invitación pendiente): los contactos posibles de una suspensión.
 */
export async function listActiveAdmins(): Promise<{ userId: string; email: string; fullName: string | null }[]> {
  return (await listAccounts())
    .filter((a) => a.role === "admin" && a.status === "active")
    .map((a) => ({ userId: a.userId, email: a.email, fullName: a.fullName }));
}

/** Usuario de Auth por email (tenga o no fila en `analysts`). */
export async function findAuthUserByEmail(email: string): Promise<User | null> {
  const wanted = email.toLowerCase();
  return (await allAuthUsers()).find((u) => u.email?.toLowerCase() === wanted) ?? null;
}

export async function listOrgSummaries(): Promise<OrgSummary[]> {
  const supabase = createServiceClient();
  const [{ analysts, orgs }, { data: keys }] = await Promise.all([
    loadAll(),
    supabase.from("api_keys").select("org_id").is("revoked_at", null),
  ]);
  const emailById = new Map(analysts.map((a) => [a.user_id, a.email]));
  return orgs.map((o) => {
    const members = analysts.filter((a) => a.org_id === o.id);
    return {
      id: o.id,
      slug: o.slug,
      name: o.name,
      suspendedAt: o.disabled_at,
      contactEmail: o.suspension_contact_id ? (emailById.get(o.suspension_contact_id) ?? null) : null,
      users: members.length,
      activeAdmins: members.filter((a) => a.role === "admin" && !a.disabled_at).length,
      apiKeys: (keys ?? []).filter((k) => k.org_id === o.id).length,
    };
  });
}
