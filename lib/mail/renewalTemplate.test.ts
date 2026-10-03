import { test } from "node:test";
import assert from "node:assert/strict";
import { buildRenewalEmail, escapeHtml, type RenewalEmailInput } from "./renewalTemplate.ts";

const base = (over: Partial<RenewalEmailInput> = {}): RenewalEmailInput => ({
  locale: "es",
  orgName: "Acme Pagos",
  logoUrl: "https://example.test/logo.png",
  companyName: "Pythas Holdings",
  documents: [
    { label: "Licencia de funcionamiento", expiresOn: "2026-09-15" },
    { label: "Carnet (anverso)", expiresOn: "2026-10-20" },
    { label: "Póliza", expiresOn: null },
  ],
  renewalUrl: "https://kyb.test/f/abc123",
  linkExpiresAt: "2026-10-16T12:00:00Z",
  note: null,
  today: "2026-10-02",
  ...over,
});

test("buildRenewalEmail en español: asunto, documentos, link y vigencia", () => {
  const mail = buildRenewalEmail(base());
  assert.equal(mail.subject, "Acme Pagos: actualiza tus documentos");
  assert.match(mail.html, /lang="es"/);
  assert.match(mail.html, /Pythas Holdings/);
  assert.match(mail.html, /Venció el 15 de septiembre de 2026/);
  assert.match(mail.html, /Vence el 20 de octubre de 2026/);
  assert.match(mail.html, /Sin fecha registrada/);
  assert.match(mail.html, /href="https:\/\/kyb\.test\/f\/abc123"/);
  assert.match(mail.html, /vale hasta el 16 de octubre de 2026/);
  assert.match(mail.html, /src="https:\/\/example\.test\/logo\.png"/);
});

test("buildRenewalEmail en inglés", () => {
  const mail = buildRenewalEmail(base({ locale: "en", companyName: null }));
  assert.equal(mail.subject, "Acme Pagos: please update your documents");
  assert.match(mail.html, /Expired on September 15, 2026/);
  assert.match(mail.html, /Some of the documents we have on file have expired/);
  assert.doesNotMatch(mail.html, /Pythas/);
});

test("la nota y los nombres se escapan; la nota respeta los saltos de línea", () => {
  const mail = buildRenewalEmail(
    base({
      note: '<script>alert("x")</script>\nSegunda línea',
      companyName: "A & B <Corp>",
      documents: [{ label: '<img src=x onerror="y">', expiresOn: null }],
    }),
  );
  assert.doesNotMatch(mail.html, /<script>/);
  assert.doesNotMatch(mail.html, /<img src=x/);
  assert.match(mail.html, /&lt;script&gt;alert\(&quot;x&quot;\)&lt;\/script&gt;<br \/>Segunda línea/);
  assert.match(mail.html, /A &amp; B &lt;Corp&gt;/);
  assert.match(mail.html, /Mensaje de Acme Pagos/);
});

test("la versión de texto trae el link, los documentos y la nota", () => {
  const mail = buildRenewalEmail(base({ note: "Gracias" }));
  assert.match(mail.text, /Actualizar documentos: https:\/\/kyb\.test\/f\/abc123/);
  assert.match(mail.text, /- Licencia de funcionamiento: Venció el 15 de septiembre de 2026/);
  assert.match(mail.text, /Mensaje de Acme Pagos:\nGracias/);
  assert.doesNotMatch(mail.text, /<\w+/);
});

test("sin vigencia del link ni nota, no se pintan esos bloques", () => {
  const mail = buildRenewalEmail(base({ linkExpiresAt: null, note: "   " }));
  assert.doesNotMatch(mail.html, /vale hasta/);
  assert.doesNotMatch(mail.html, /Mensaje de/);
});

test("escapeHtml", () => {
  assert.equal(escapeHtml(`<a href="x">'&'</a>`), "&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;");
});
