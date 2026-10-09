import { test } from "node:test";
import assert from "node:assert/strict";
import { authErrorKey } from "./authErrors.ts";
import { MIN_PASSWORD_LENGTH, passwordIssues } from "./passwordPolicy.ts";
import { confirmDestination, parseConfirmLink } from "./confirmLink.ts";
import { mfaGate } from "./mfaGate.ts";
import { generateTempPassword } from "./tempPassword.ts";

test("mfaGate: sin factores no pide nada; con factores exige aal2", () => {
  assert.equal(mfaGate({ currentLevel: "aal1", verifiedFactors: 0 }), "ok");
  assert.equal(mfaGate({ currentLevel: null, verifiedFactors: 0 }), "ok");
  assert.equal(mfaGate({ currentLevel: "aal1", verifiedFactors: 1 }), "pending");
  assert.equal(mfaGate({ currentLevel: undefined, verifiedFactors: 2 }), "pending");
  assert.equal(mfaGate({ currentLevel: "aal2", verifiedFactors: 1 }), "ok");
});

test("authErrorKey decide por código, no por mensaje", () => {
  assert.equal(authErrorKey({ code: "invalid_credentials" }), "errInvalidCredentials");
  assert.equal(authErrorKey({ code: "captcha_failed" }), "errCaptcha");
  assert.equal(authErrorKey({ code: "user_banned" }), "errBanned");
  assert.equal(authErrorKey({ code: "insufficient_aal" }), "errNeedsMfa");
  assert.equal(authErrorKey({ status: 429 }), "errRateLimit");
  assert.equal(authErrorKey({ code: "algo_nuevo", status: 500 }), "errGeneric");
  assert.equal(authErrorKey(null), "errGeneric");
});

test("passwordIssues exige largo, letra y dígito", () => {
  assert.equal(MIN_PASSWORD_LENGTH, 10);
  assert.deepEqual(passwordIssues("corta1"), ["length"]);
  assert.deepEqual(passwordIssues("soloLetrasLargas"), ["digit"]);
  assert.deepEqual(passwordIssues("1234567890"), ["letter"]);
  assert.deepEqual(passwordIssues("contraseña123"), []);
  assert.deepEqual(passwordIssues(""), ["length", "letter", "digit"]);
});

test("parseConfirmLink acepta solo los tipos de nuestras plantillas", () => {
  const hash = "a1b2c3d4e5f6a7b8c9d0e1f2";
  assert.deepEqual(parseConfirmLink({ token_hash: hash, type: "recovery" }), {
    tokenHash: hash,
    type: "recovery",
  });
  assert.equal(parseConfirmLink({ token_hash: hash, type: "email_change" })?.type, "email_change");
  // Tipos que no mandamos (signup, magiclink) o inventados.
  assert.equal(parseConfirmLink({ token_hash: hash, type: "signup" }), null);
  assert.equal(parseConfirmLink({ token_hash: hash, type: "magiclink" }), null);
  assert.equal(parseConfirmLink({ token_hash: hash, type: undefined }), null);
  // Hash ausente, corto o con caracteres raros.
  assert.equal(parseConfirmLink({ token_hash: "", type: "recovery" }), null);
  assert.equal(parseConfirmLink({ token_hash: "abc", type: "recovery" }), null);
  assert.equal(parseConfirmLink({ token_hash: `${hash}"><script>`, type: "recovery" }), null);
  assert.equal(parseConfirmLink({ token_hash: [hash], type: "recovery" }), null);
});

test("confirmDestination: el destino lo decide el tipo (sin redirección abierta)", () => {
  assert.equal(confirmDestination("recovery"), "/auth/reset");
  assert.equal(confirmDestination("invite"), "/auth/reset?invite=1");
  assert.equal(confirmDestination("email_change"), "/admin/security?email=changed");
});

test("generateTempPassword cumple la política y no se repite", () => {
  const seen = new Set<string>();
  for (let i = 0; i < 200; i++) {
    const pw = generateTempPassword();
    assert.match(pw, /^[A-Za-z2-9]{4}-[A-Za-z2-9]{4}-[A-Za-z2-9]{4}$/);
    assert.deepEqual(passwordIssues(pw), []);
    assert.doesNotMatch(pw, /[01OlI]/);
    seen.add(pw);
  }
  assert.equal(seen.size, 200);
});
