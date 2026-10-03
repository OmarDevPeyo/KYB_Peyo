// Correo de renovación de documentos (ES/EN). Puro y sin dependencias: lo
// arma el servidor para enviarlo y el composer del panel para el preview, y lo
// prueba `node --test`. El estilo sigue las plantillas de supabase/templates.

export type RenewalEmailLocale = "es" | "en";

export interface RenewalEmailDoc {
  /** Nombre del documento, ya en el idioma del correo. */
  label: string;
  /** `YYYY-MM-DD`, o null si no hay fecha registrada. */
  expiresOn: string | null;
}

export interface RenewalEmailInput {
  locale: RenewalEmailLocale;
  orgName: string;
  /** URL pública del logo (el de la organización o el de Peyo). */
  logoUrl: string;
  /** Nombre de la empresa (título de la solicitud), si se conoce. */
  companyName: string | null;
  documents: RenewalEmailDoc[];
  renewalUrl: string;
  /** Vencimiento del link (ISO), si se conoce. */
  linkExpiresAt: string | null;
  /** Nota del analista: texto plano, se escapa. */
  note: string | null;
  /** Hoy en UTC (`YYYY-MM-DD`): decide «venció» o «vence». */
  today: string;
}

export interface RenewalEmail {
  subject: string;
  html: string;
  text: string;
}

const COPY = {
  es: {
    subject: (org: string) => `${org}: actualiza tus documentos`,
    heading: "Necesitamos que actualices tus documentos",
    introCompany: (company: string) =>
      `Algunos documentos de ${company} que tenemos registrados vencieron o están por vencer.`,
    intro: "Algunos documentos que tenemos registrados vencieron o están por vencer.",
    ask: "Sube la versión vigente de cada uno desde el siguiente enlace:",
    expired: (d: string) => `Venció el ${d}`,
    expires: (d: string) => `Vence el ${d}`,
    noDate: "Sin fecha registrada",
    note: (org: string) => `Mensaje de ${org}`,
    button: "Actualizar documentos",
    validUntil: (d: string) => `El enlace es personal y vale hasta el ${d}.`,
    fallback: "Si el botón no funciona, copia y pega este enlace en tu navegador:",
    footer: (org: string) =>
      `Recibes este correo por la verificación de tu empresa con ${org}. Si ya enviaste estos documentos, puedes ignorarlo.`,
  },
  en: {
    subject: (org: string) => `${org}: please update your documents`,
    heading: "Please update your documents",
    introCompany: (company: string) =>
      `Some of the documents we have on file for ${company} have expired or are about to expire.`,
    intro: "Some of the documents we have on file have expired or are about to expire.",
    ask: "Please upload the current version of each one using the link below:",
    expired: (d: string) => `Expired on ${d}`,
    expires: (d: string) => `Expires on ${d}`,
    noDate: "No date on file",
    note: (org: string) => `Message from ${org}`,
    button: "Update documents",
    validUntil: (d: string) => `This link is personal and valid until ${d}.`,
    fallback: "If the button doesn't work, copy and paste this link into your browser:",
    footer: (org: string) =>
      `You are receiving this email about your company's verification with ${org}. If you already sent these documents, you can ignore it.`,
  },
} as const;

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Fecha larga en UTC: `15 de septiembre de 2026` / `September 15, 2026`. */
function longDate(value: string, locale: RenewalEmailLocale): string {
  const d = /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T00:00:00Z`) : new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return new Intl.DateTimeFormat(locale, { dateStyle: "long", timeZone: "UTC" }).format(d);
}

export function buildRenewalEmail(input: RenewalEmailInput): RenewalEmail {
  const c = COPY[input.locale];
  const org = input.orgName.trim() || "Peyo";
  const company = input.companyName?.trim() || null;
  const note = input.note?.trim() || null;

  const status = (doc: RenewalEmailDoc) =>
    !doc.expiresOn
      ? c.noDate
      : doc.expiresOn < input.today
        ? c.expired(longDate(doc.expiresOn, input.locale))
        : c.expires(longDate(doc.expiresOn, input.locale));
  const intro = company ? c.introCompany(company) : c.intro;
  const until = input.linkExpiresAt ? c.validUntil(longDate(input.linkExpiresAt, input.locale)) : null;

  const e = escapeHtml;
  const url = e(input.renewalUrl);
  const docRows = input.documents
    .map(
      (doc) => `
                  <tr>
                    <td style="padding:10px 0;border-top:1px solid #e2e8f0;font-size:15px;line-height:1.4;color:#0f172a;">${e(doc.label)}</td>
                    <td align="right" style="padding:10px 0 10px 12px;border-top:1px solid #e2e8f0;font-size:13px;line-height:1.4;color:${doc.expiresOn && doc.expiresOn < input.today ? "#b91c1c" : "#64748b"};white-space:nowrap;">${e(status(doc))}</td>
                  </tr>`,
    )
    .join("");
  const noteBlock = note
    ? `
            <tr>
              <td style="padding:0 32px 16px;">
                <div style="border-left:3px solid #2463eb;background:#f8fafc;border-radius:8px;padding:12px 14px;">
                  <p style="margin:0 0 4px;font-size:12px;font-weight:600;color:#64748b;">${e(c.note(org))}</p>
                  <p style="margin:0;font-size:14px;line-height:1.6;color:#334155;">${e(note).replace(/\r?\n/g, "<br />")}</p>
                </div>
              </td>
            </tr>`
    : "";

  const html = `<!doctype html>
<html lang="${input.locale}">
  <body style="margin:0;padding:0;background:#f2f5f9;font-family:Inter,Segoe UI,Helvetica,Arial,sans-serif;color:#0f172a;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f2f5f9;padding:32px 16px;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border-radius:16px;border:1px solid #e2e8f0;">
            <tr>
              <td style="padding:28px 32px 8px;">
                <img src="${e(input.logoUrl)}" alt="${e(org)}" height="40" style="display:block;height:40px;width:auto;max-width:220px;" />
              </td>
            </tr>
            <tr>
              <td style="padding:8px 32px 0;">
                <h1 style="margin:0 0 12px;font-size:22px;line-height:1.3;">${e(c.heading)}</h1>
                <p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:#334155;">${e(intro)} ${e(c.ask)}</p>
              </td>
            </tr>
            <tr>
              <td style="padding:0 32px 16px;">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${docRows}
                </table>
              </td>
            </tr>${noteBlock}
            <tr>
              <td style="padding:8px 32px 24px;">
                <a href="${url}" style="display:inline-block;background:#2463eb;color:#ffffff;text-decoration:none;font-weight:600;font-size:15px;padding:12px 22px;border-radius:10px;">${e(c.button)}</a>
                ${until ? `<p style="margin:20px 0 0;font-size:13px;line-height:1.6;color:#64748b;">${e(until)}</p>` : ""}
                <p style="margin:12px 0 0;font-size:12px;line-height:1.6;color:#94a3b8;">${e(c.fallback)}<br /><a href="${url}" style="color:#2463eb;word-break:break-all;">${url}</a></p>
              </td>
            </tr>
            <tr>
              <td style="padding:16px 32px 24px;border-top:1px solid #e2e8f0;font-size:12px;line-height:1.5;color:#94a3b8;">${e(c.footer(org))}</td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>
`;

  const text = [
    c.heading,
    "",
    `${intro} ${c.ask}`,
    "",
    ...input.documents.map((doc) => `- ${doc.label}: ${status(doc)}`),
    ...(note ? ["", `${c.note(org)}:`, note] : []),
    "",
    `${c.button}: ${input.renewalUrl}`,
    ...(until ? [until] : []),
    "",
    c.footer(org),
  ].join("\n");

  return { subject: c.subject(org), html, text };
}
