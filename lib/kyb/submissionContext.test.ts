import { test } from "node:test";
import assert from "node:assert/strict";
import {
  EMPTY_SUBMISSION_CONTEXT,
  IP_CITY_MAX,
  USER_AGENT_MAX,
  normalizeIp,
  normalizeIpCity,
  normalizeIpRegion,
  normalizeUserAgent,
  submissionContextColumns,
  submissionContextFromHeaders,
  submissionContextOf,
  webhookSubmissionContext,
} from "./submissionContext.ts";

/** Se ejecuta con `npm test` (node --test --experimental-strip-types). */

const headers = (map: Record<string, string>) => ({
  get: (name: string) => map[name] ?? null,
});

test("normalizeIp acepta IPv4 e IPv6 y descarta lo demás", () => {
  assert.equal(normalizeIp("181.115.172.17"), "181.115.172.17");
  assert.equal(normalizeIp(" 2800:cd0:1::1 "), "2800:cd0:1::1");
  assert.equal(normalizeIp("999.1.1.1"), null);
  assert.equal(normalizeIp("desconocida"), null);
  assert.equal(normalizeIp("181.115.172.17:443"), null);
  assert.equal(normalizeIp("::ffff:181.115.172.17"), "::ffff:181.115.172.17");
  assert.equal(normalizeIp(`fe80::1%${"x".repeat(60)}`), null);
  assert.equal(normalizeIp(""), null);
  assert.equal(normalizeIp(null), null);
});

test("normalizeIpRegion acepta hasta tres letras o dígitos", () => {
  assert.equal(normalizeIpRegion("L"), "L");
  assert.equal(normalizeIpRegion(" sp "), "SP");
  assert.equal(normalizeIpRegion("13"), "13");
  assert.equal(normalizeIpRegion("ABCD"), null);
  assert.equal(normalizeIpRegion("L-1"), null);
  assert.equal(normalizeIpRegion(undefined), null);
});

test("normalizeIpCity decodifica, limpia y recorta", () => {
  assert.equal(normalizeIpCity("S%C3%A3o%20Paulo"), "São Paulo");
  assert.equal(normalizeIpCity("La Paz"), "La Paz");
  // Un `%` suelto no se puede decodificar: queda el texto tal cual.
  assert.equal(normalizeIpCity("100%25 Oruro%"), "100%25 Oruro%");
  assert.equal(normalizeIpCity("%20%20"), null);
  assert.equal(normalizeIpCity("Or\u0000uro"), "Oruro");
  assert.equal(normalizeIpCity("x".repeat(200))?.length, IP_CITY_MAX);
  assert.equal(normalizeIpCity(null), null);
});

test("normalizeUserAgent recorta a 512 y descarta el vacío", () => {
  assert.equal(normalizeUserAgent(" Mozilla/5.0 "), "Mozilla/5.0");
  assert.equal(normalizeUserAgent("a".repeat(600))?.length, USER_AGENT_MAX);
  assert.equal(normalizeUserAgent("   "), null);
  assert.equal(normalizeUserAgent(null), null);
});

test("submissionContextFromHeaders lee los headers de Vercel", () => {
  assert.deepEqual(
    submissionContextFromHeaders(
      headers({
        "x-vercel-ip-country": "bo",
        "x-real-ip": "181.115.172.17",
        "x-forwarded-for": "10.0.0.1, 181.115.172.17",
        "x-vercel-ip-country-region": "O",
        "x-vercel-ip-city": "Oruro",
        "user-agent": "Mozilla/5.0 (Linux; Android 14)",
      }),
    ),
    {
      ipCountry: "BO",
      ip: "181.115.172.17",
      ipRegion: "O",
      ipCity: "Oruro",
      userAgent: "Mozilla/5.0 (Linux; Android 14)",
    },
  );
});

test("sin x-real-ip la IP sale del primer valor de x-forwarded-for", () => {
  const ctx = submissionContextFromHeaders(
    headers({ "x-forwarded-for": " 181.115.172.17 , 10.0.0.1" }),
  );
  assert.equal(ctx.ip, "181.115.172.17");
});

test("sin headers todo es null", () => {
  assert.deepEqual(submissionContextFromHeaders(headers({})), EMPTY_SUBMISSION_CONTEXT);
});

test("columnas, fila, API y webhook usan los mismos datos", () => {
  const ctx = {
    ipCountry: "BO",
    ip: "181.115.172.17",
    ipRegion: "L",
    ipCity: "La Paz",
    userAgent: "Mozilla/5.0",
  };
  const row = submissionContextColumns(ctx);
  assert.deepEqual(row, {
    submitted_ip_country: "BO",
    submitted_ip: "181.115.172.17",
    submitted_ip_region: "L",
    submitted_ip_city: "La Paz",
    submitted_user_agent: "Mozilla/5.0",
  });
  assert.deepEqual(submissionContextOf(row), ctx);
  assert.deepEqual(webhookSubmissionContext(row), {
    ip_country: "BO",
    ip: "181.115.172.17",
    ip_region: "L",
    ip_city: "La Paz",
    user_agent: "Mozilla/5.0",
  });
  // Una fila enviada antes de 0036 solo tiene el país.
  assert.deepEqual(submissionContextOf({ submitted_ip_country: "BO" }), {
    ...EMPTY_SUBMISSION_CONTEXT,
    ipCountry: "BO",
  });
});
