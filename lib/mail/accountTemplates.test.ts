import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildAccessEmail,
  buildEmailChangeEmail,
  buildEmailChangeNoticeEmail,
  buildPasswordChangedEmail,
  buildRecoveryEmail,
} from "./accountTemplates.ts";

const appUrl = "https://kyb.example.test";

test("acceso: contraseña, rol y login de su portal, en html y texto", () => {
  const mail = buildAccessEmail({
    appUrl,
    email: "ana@acme.test",
    password: "Kp7m-Qx3r-Tz9w",
    loginUrl: `${appUrl}/admin/login`,
    role: "admin",
    resent: false,
  });
  assert.equal(mail.subject, "Tu acceso al panel KYB de Peyo");
  for (const part of [mail.html, mail.text]) {
    assert.ok(part.includes("Kp7m-Qx3r-Tz9w"));
    assert.ok(part.includes(`${appUrl}/admin/login`));
    assert.ok(part.includes("de administración"));
  }
  assert.ok(mail.html.includes(`${appUrl}/peyo-logo.png`));
});

test("acceso reenviado: avisa que la anterior ya no sirve", () => {
  const mail = buildAccessEmail({
    appUrl,
    email: "bob@acme.test",
    password: "x",
    loginUrl: `${appUrl}/login`,
    role: "analyst",
    resent: true,
  });
  assert.equal(mail.subject, "Tu nuevo acceso al panel KYB de Peyo");
  assert.ok(mail.text.includes("La anterior ya no sirve"));
  assert.ok(!mail.text.includes("de administración"));
});

test("se escapa lo que viene de afuera", () => {
  const mail = buildAccessEmail({
    appUrl,
    email: "<b>x</b>@acme.test",
    password: `a"&<'`,
    loginUrl: `${appUrl}/login?x="1"`,
    role: "analyst",
    resent: false,
  });
  assert.ok(!mail.html.includes("<b>x</b>"));
  assert.ok(mail.html.includes("&lt;b&gt;x&lt;/b&gt;"));
  assert.ok(mail.html.includes("a&quot;&amp;&lt;&#39;"));
  assert.ok(mail.html.includes("x=&quot;1&quot;"));
});

test("restablecer y cambio de email llevan su link; el aviso, no", () => {
  const link = `${appUrl}/auth/confirm?token_hash=abc&type=recovery`;
  const recovery = buildRecoveryEmail({ appUrl, email: "ana@acme.test", link });
  assert.ok(recovery.html.includes(link.replace(/&/g, "&amp;")));
  assert.ok(recovery.text.includes(link));

  const changeLink = `${appUrl}/auth/confirm?token_hash=def&type=email_change`;
  const change = buildEmailChangeEmail({
    appUrl,
    oldEmail: "ana@acme.test",
    newEmail: "ana@nueva.test",
    link: changeLink,
  });
  assert.ok(change.text.includes(changeLink));
  assert.ok(change.text.includes("ana@nueva.test"));

  const notice = buildEmailChangeNoticeEmail({ appUrl, oldEmail: "ana@acme.test", newEmail: "ana@nueva.test" });
  assert.ok(notice.text.includes("ana@nueva.test"));
  assert.ok(!notice.html.includes("/auth/confirm"));
});

test("contraseña cambiada: apunta a Olvidé mi contraseña", () => {
  const mail = buildPasswordChangedEmail({ appUrl, email: "ana@acme.test", forgotUrl: `${appUrl}/auth/forgot` });
  assert.equal(mail.subject, "Tu contraseña del panel KYB cambió");
  assert.ok(mail.text.includes(`${appUrl}/auth/forgot`));
});
