// Genera lib/forms/naics-2022.ts: el catálogo NAICS 2022 de 6 dígitos del tipo
// de pregunta `naics`, con el título oficial en inglés y su traducción.
//
// Fuente: U.S. Census Bureau, «2022 NAICS 6-digit codes» (dominio público):
//   https://www.census.gov/naics/2022NAICS/6-digit_2022_Codes.xlsx
// La traducción al español vive en scripts/naics/naics-2022.es.json (código →
// título), revisada a mano. El script falla si a un código le falta la
// traducción o si sobra una: así un catálogo nuevo no sale a medio traducir.
//
// Uso:
//   node scripts/naics/build-naics.mjs                 -> descarga el xlsx del Censo
//   node scripts/naics/build-naics.mjs <ruta.xlsx>     -> usa un xlsx ya descargado
//
// Sin dependencias: el xlsx es un zip, y de él solo se leen dos XML.
import { readFileSync, writeFileSync } from "node:fs";
import { inflateRawSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SOURCE_URL = "https://www.census.gov/naics/2022NAICS/6-digit_2022_Codes.xlsx";
const ES = join(ROOT, "scripts/naics/naics-2022.es.json");
const OUT = join(ROOT, "lib/forms/naics-2022.ts");

/** Archivos de un zip por nombre (lee el directorio central, sin extraer a disco). */
function unzip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("No es un zip (sin fin de directorio central).");
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const files = new Map();
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error("Directorio central corrupto.");
    const method = buf.readUInt16LE(p + 10);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(start, start + size);
    files.set(name, () => (method === 8 ? inflateRawSync(raw) : raw).toString("utf8"));
    p += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

function decodeXml(s) {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

/** Filas de la primera hoja: [{ A: "111110", B: "Soybean Farming" }, …]. */
function readSheet(xlsx) {
  const files = unzip(xlsx);
  const shared = [];
  const ss = files.get("xl/sharedStrings.xml");
  if (ss) {
    for (const [, si] of ss().matchAll(/<si>([\s\S]*?)<\/si>/g)) {
      shared.push(decodeXml([...si.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((m) => m[1]).join("")));
    }
  }
  const sheet = files.get("xl/worksheets/sheet1.xml");
  if (!sheet) throw new Error("El xlsx no tiene xl/worksheets/sheet1.xml.");
  const rows = [];
  for (const [, row] of sheet().matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells = {};
    for (const [, attrs, body] of row.matchAll(/<c([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const col = /r="([A-Z]+)/.exec(attrs)?.[1];
      const v = body && /<v>([\s\S]*?)<\/v>/.exec(body)?.[1];
      const inline = body && /<t[^>]*>([\s\S]*?)<\/t>/.exec(body)?.[1];
      if (!col) continue;
      if (/t="s"/.test(attrs) && v != null) cells[col] = shared[Number(v)];
      else if (v != null) cells[col] = decodeXml(v);
      else if (inline != null) cells[col] = decodeXml(inline);
    }
    rows.push(cells);
  }
  return rows;
}

async function loadXlsx(arg) {
  if (arg) return readFileSync(arg);
  const res = await fetch(SOURCE_URL);
  if (!res.ok) throw new Error(`${SOURCE_URL} -> ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

const rows = readSheet(await loadXlsx(process.argv[2]));
const entries = rows
  .map((r) => [String(r.A ?? "").trim(), String(r.B ?? "").trim().replace(/\s+/g, " ")])
  .filter(([code]) => /^\d{6}$/.test(code));
if (entries.length < 1000) throw new Error(`Solo ${entries.length} códigos: ¿cambió el formato del xlsx?`);
if (new Set(entries.map(([c]) => c)).size !== entries.length) throw new Error("Códigos repetidos.");

const es = JSON.parse(readFileSync(ES, "utf8"));
const missing = entries.filter(([c]) => !es[c]?.trim()).map(([c]) => c);
const extra = Object.keys(es).filter((c) => !entries.some(([k]) => k === c));
if (missing.length || extra.length) {
  console.error(`Faltan traducciones: ${missing.join(", ") || "—"}`);
  console.error(`Sobran traducciones: ${extra.join(", ") || "—"}`);
  process.exit(1);
}

const lines = entries.map(([c, en]) => `  [${JSON.stringify(c)}, ${JSON.stringify(en)}, ${JSON.stringify(es[c].trim())}],`);
writeFileSync(
  OUT,
  `// GENERADO por scripts/naics/build-naics.mjs: no editar a mano.
// NAICS 2022, códigos de 6 dígitos. Fuente: U.S. Census Bureau (dominio
// público). La traducción sale de scripts/naics/naics-2022.es.json.
//
// Sin funciones a propósito: las consultas viven en ./naics.ts, y este archivo
// se carga a demanda en el navegador (ver NaicsField en DynamicForm).

/** [código, título en inglés, título en español] */
export type NaicsEntry = readonly [code: string, en: string, es: string];

export const NAICS_2022: readonly NaicsEntry[] = [
${lines.join("\n")}
];
`,
);
console.log(`${OUT}: ${entries.length} códigos`);
