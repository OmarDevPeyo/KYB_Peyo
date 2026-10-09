import { test } from "node:test";
import assert from "node:assert/strict";
import {
  accountState,
  canManageAccount,
  canSuspendOrg,
  isEmail,
  loginPath,
  normalizeEmail,
  normalizeOrgName,
  parsePortal,
  portalFor,
  postLoginOutcome,
  removesLastAdmin,
  slugify,
  uniqueSlug,
  type AccountTarget,
} from "./accountRules.ts";

test("portales: cada rol tiene su login", () => {
  assert.equal(portalFor("admin"), "admin");
  assert.equal(portalFor("analyst"), "user");
  assert.equal(loginPath("admin"), "/admin/login");
  assert.equal(loginPath("user"), "/login");
  assert.equal(parsePortal("admin"), "admin");
  assert.equal(parsePortal("ADMIN"), "user");
  assert.equal(parsePortal(undefined), "user");
});

test("accountState: el 2FA va antes que la suspensión", () => {
  const base = { signedIn: true, mfaPending: false, orgUsable: true, mustChangePassword: false };
  assert.deepEqual(accountState({ ...base, signedIn: false, row: null }), { kind: "signed_out" });
  assert.deepEqual(accountState({ ...base, row: null }), { kind: "no_account" });
  // Suspendido y con 2FA pendiente: primero el código.
  assert.deepEqual(
    accountState({ ...base, mfaPending: true, row: { role: "analyst", disabled: true } }),
    { kind: "mfa_pending", role: "analyst" },
  );
  assert.deepEqual(accountState({ ...base, row: { role: "analyst", disabled: true } }), {
    kind: "suspended",
    scope: "user",
    role: "analyst",
  });
  assert.deepEqual(
    accountState({ ...base, orgUsable: false, row: { role: "analyst", disabled: false } }),
    { kind: "suspended", scope: "org", role: "analyst" },
  );
  assert.deepEqual(accountState({ ...base, row: { role: "admin", disabled: false } }), {
    kind: "active",
    role: "admin",
  });
});

test("accountState: la contraseña propia se elige al final", () => {
  const base = { signedIn: true, mfaPending: false, orgUsable: true, mustChangePassword: true };
  assert.deepEqual(accountState({ ...base, row: { role: "analyst", disabled: false } }), {
    kind: "password_setup",
    role: "analyst",
  });
  // Primero el 2FA y la suspensión.
  assert.equal(accountState({ ...base, mfaPending: true, row: { role: "admin", disabled: false } }).kind, "mfa_pending");
  assert.equal(accountState({ ...base, row: { role: "analyst", disabled: true } }).kind, "suspended");
  assert.equal(accountState({ ...base, orgUsable: false, row: { role: "analyst", disabled: false } }).kind, "suspended");
});

test("postLoginOutcome: el portal equivocado se rechaza antes del 2FA", () => {
  assert.deepEqual(postLoginOutcome({ kind: "mfa_pending", role: "admin" }, "user"), {
    error: "wrongPortal",
  });
  assert.deepEqual(postLoginOutcome({ kind: "active", role: "analyst" }, "admin"), {
    error: "wrongPortal",
  });
  assert.deepEqual(postLoginOutcome({ kind: "mfa_pending", role: "admin" }, "admin"), {
    next: "/auth/mfa",
  });
  assert.deepEqual(postLoginOutcome({ kind: "suspended", scope: "org", role: "analyst" }, "user"), {
    next: "/auth/suspended",
  });
  assert.deepEqual(postLoginOutcome({ kind: "active", role: "analyst" }, "user"), {
    next: "/admin",
  });
  assert.deepEqual(postLoginOutcome({ kind: "password_setup", role: "admin" }, "admin"), {
    next: "/auth/welcome",
  });
  assert.deepEqual(postLoginOutcome({ kind: "password_setup", role: "admin" }, "user"), {
    error: "wrongPortal",
  });
  assert.deepEqual(postLoginOutcome({ kind: "no_account" }, "user"), { error: "forbidden" });
});

test("canManageAccount: nada sobre uno mismo", () => {
  const me: AccountTarget = { userId: "a", role: "admin", suspended: false, pending: false };
  for (const action of ["name", "email", "role", "org", "suspend", "resetLink", "resendAccess"] as const) {
    assert.equal(canManageAccount("a", me, action), "self");
  }
});

test("canManageAccount: a otro admin solo se le manda el link", () => {
  const other: AccountTarget = { userId: "b", role: "admin", suspended: false, pending: false };
  assert.equal(canManageAccount("a", other, "email"), "otherAdmin");
  assert.equal(canManageAccount("a", other, "resetLink"), null);
  assert.equal(canManageAccount("a", other, "resendAccess"), "notPending");
  // Un admin que nunca entró: se le reenvía el acceso.
  assert.equal(canManageAccount("a", { ...other, pending: true }, "resendAccess"), null);
  assert.equal(canManageAccount("a", other, "suspend"), null);
  assert.equal(canManageAccount("a", other, "role"), null);
});

test("canManageAccount: suspendidos y cuentas que nunca entraron", () => {
  const user: AccountTarget = { userId: "u", role: "analyst", suspended: false, pending: false };
  assert.equal(canManageAccount("a", user, "email"), null);
  assert.equal(canManageAccount("a", user, "resetLink"), null);
  assert.equal(canManageAccount("a", user, "reactivate"), "notSuspended");
  assert.equal(canManageAccount("a", user, "cancelPending"), "notPending");

  const suspended = { ...user, suspended: true };
  assert.equal(canManageAccount("a", suspended, "resetLink"), "suspended");
  assert.equal(canManageAccount("a", suspended, "suspend"), "alreadySuspended");
  assert.equal(canManageAccount("a", suspended, "reactivate"), null);

  const pending = { ...user, pending: true };
  assert.equal(canManageAccount("a", pending, "resetLink"), "pending");
  assert.equal(canManageAccount("a", pending, "resendAccess"), null);
  assert.equal(canManageAccount("a", pending, "cancelPending"), null);
});

test("removesLastAdmin y canSuspendOrg", () => {
  assert.equal(removesLastAdmin({ targetIsActiveAdmin: true, activeAdmins: 1 }), true);
  assert.equal(removesLastAdmin({ targetIsActiveAdmin: true, activeAdmins: 2 }), false);
  assert.equal(removesLastAdmin({ targetIsActiveAdmin: false, activeAdmins: 1 }), false);
  assert.equal(canSuspendOrg({ activeAdminsInOrg: 1, suspended: false }), "orgHasAdmins");
  assert.equal(canSuspendOrg({ activeAdminsInOrg: 0, suspended: false }), null);
  assert.equal(canSuspendOrg({ activeAdminsInOrg: 0, suspended: true }), "alreadySuspended");
});

test("slugify cumple el CHECK de organizations.slug", () => {
  const re = /^[a-z0-9][a-z0-9-]{1,62}$/;
  assert.equal(slugify("Acmé  S.A."), "acme-s-a");
  assert.equal(slugify("  Peyo  "), "peyo");
  assert.equal(slugify("Ñandú & Cía"), "nandu-cia");
  assert.equal(slugify("X"), "org-x");
  assert.equal(slugify("!!!"), "org");
  const long = slugify("a".repeat(100));
  assert.equal(long.length, 63);
  for (const name of ["Acmé  S.A.", "X", "!!!", "a".repeat(100), "-guion-"]) {
    assert.match(slugify(name), re, name);
  }
});

test("uniqueSlug agrega sufijo sin pasarse de 63", () => {
  assert.equal(uniqueSlug("acme", new Set()), "acme");
  assert.equal(uniqueSlug("acme", new Set(["acme"])), "acme-2");
  assert.equal(uniqueSlug("acme", new Set(["acme", "acme-2"])), "acme-3");
  const long = "a".repeat(63);
  const out = uniqueSlug(long, new Set([long]));
  assert.equal(out.length, 63);
  assert.ok(out.endsWith("-2"));
});

test("normalizeOrgName, normalizeEmail e isEmail", () => {
  assert.equal(normalizeOrgName("  Acme   Corp  "), "Acme Corp");
  assert.equal(normalizeEmail("  Ana@Peyo.COM "), "ana@peyo.com");
  assert.equal(isEmail("ana@peyo.com"), true);
  assert.equal(isEmail("ana@peyo"), false);
  assert.equal(isEmail("ana peyo@x.com"), false);
});
