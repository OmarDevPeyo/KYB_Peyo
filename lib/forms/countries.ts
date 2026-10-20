// ============================================================
// Países ISO 3166-1 (client-safe).
// El valor que se guarda/usa es el código alpha-3 (lo que Bridge
// requiere). El nombre localizado sale de Intl.DisplayNames y la
// bandera (emoji) del alpha-2 — no se hardcodean nombres.
// ============================================================

/** Mapa ISO 3166-1 alpha-2 → alpha-3 (todos los países/territorios). */
export const COUNTRY_A2_TO_A3: Record<string, string> = {
  AD: "AND", AE: "ARE", AF: "AFG", AG: "ATG", AI: "AIA", AL: "ALB", AM: "ARM", AO: "AGO",
  AQ: "ATA", AR: "ARG", AS: "ASM", AT: "AUT", AU: "AUS", AW: "ABW", AX: "ALA", AZ: "AZE",
  BA: "BIH", BB: "BRB", BD: "BGD", BE: "BEL", BF: "BFA", BG: "BGR", BH: "BHR", BI: "BDI",
  BJ: "BEN", BL: "BLM", BM: "BMU", BN: "BRN", BO: "BOL", BQ: "BES", BR: "BRA", BS: "BHS",
  BT: "BTN", BV: "BVT", BW: "BWA", BY: "BLR", BZ: "BLZ",
  CA: "CAN", CC: "CCK", CD: "COD", CF: "CAF", CG: "COG", CH: "CHE", CI: "CIV", CK: "COK",
  CL: "CHL", CM: "CMR", CN: "CHN", CO: "COL", CR: "CRI", CU: "CUB", CV: "CPV", CW: "CUW",
  CX: "CXR", CY: "CYP", CZ: "CZE",
  DE: "DEU", DJ: "DJI", DK: "DNK", DM: "DMA", DO: "DOM", DZ: "DZA",
  EC: "ECU", EE: "EST", EG: "EGY", EH: "ESH", ER: "ERI", ES: "ESP", ET: "ETH",
  FI: "FIN", FJ: "FJI", FK: "FLK", FM: "FSM", FO: "FRO", FR: "FRA",
  GA: "GAB", GB: "GBR", GD: "GRD", GE: "GEO", GF: "GUF", GG: "GGY", GH: "GHA", GI: "GIB",
  GL: "GRL", GM: "GMB", GN: "GIN", GP: "GLP", GQ: "GNQ", GR: "GRC", GS: "SGS", GT: "GTM",
  GU: "GUM", GW: "GNB", GY: "GUY",
  HK: "HKG", HM: "HMD", HN: "HND", HR: "HRV", HT: "HTI", HU: "HUN",
  ID: "IDN", IE: "IRL", IL: "ISR", IM: "IMN", IN: "IND", IO: "IOT", IQ: "IRQ", IR: "IRN",
  IS: "ISL", IT: "ITA",
  JE: "JEY", JM: "JAM", JO: "JOR", JP: "JPN",
  KE: "KEN", KG: "KGZ", KH: "KHM", KI: "KIR", KM: "COM", KN: "KNA", KP: "PRK", KR: "KOR",
  KW: "KWT", KY: "CYM", KZ: "KAZ",
  LA: "LAO", LB: "LBN", LC: "LCA", LI: "LIE", LK: "LKA", LR: "LBR", LS: "LSO", LT: "LTU",
  LU: "LUX", LV: "LVA", LY: "LBY",
  MA: "MAR", MC: "MCO", MD: "MDA", ME: "MNE", MF: "MAF", MG: "MDG", MH: "MHL", MK: "MKD",
  ML: "MLI", MM: "MMR", MN: "MNG", MO: "MAC", MP: "MNP", MQ: "MTQ", MR: "MRT", MS: "MSR",
  MT: "MLT", MU: "MUS", MV: "MDV", MW: "MWI", MX: "MEX", MY: "MYS", MZ: "MOZ",
  NA: "NAM", NC: "NCL", NE: "NER", NF: "NFK", NG: "NGA", NI: "NIC", NL: "NLD", NO: "NOR",
  NP: "NPL", NR: "NRU", NU: "NIU", NZ: "NZL",
  OM: "OMN",
  PA: "PAN", PE: "PER", PF: "PYF", PG: "PNG", PH: "PHL", PK: "PAK", PL: "POL", PM: "SPM",
  PN: "PCN", PR: "PRI", PS: "PSE", PT: "PRT", PW: "PLW", PY: "PRY",
  QA: "QAT",
  RE: "REU", RO: "ROU", RS: "SRB", RU: "RUS", RW: "RWA",
  SA: "SAU", SB: "SLB", SC: "SYC", SD: "SDN", SE: "SWE", SG: "SGP", SH: "SHN", SI: "SVN",
  SJ: "SJM", SK: "SVK", SL: "SLE", SM: "SMR", SN: "SEN", SO: "SOM", SR: "SUR", SS: "SSD",
  ST: "STP", SV: "SLV", SX: "SXM", SY: "SYR", SZ: "SWZ",
  TC: "TCA", TD: "TCD", TF: "ATF", TG: "TGO", TH: "THA", TJ: "TJK", TK: "TKL", TL: "TLS",
  TM: "TKM", TN: "TUN", TO: "TON", TR: "TUR", TT: "TTO", TV: "TUV", TW: "TWN", TZ: "TZA",
  UA: "UKR", UG: "UGA", UM: "UMI", US: "USA", UY: "URY", UZ: "UZB",
  VA: "VAT", VC: "VCT", VE: "VEN", VG: "VGB", VI: "VIR", VN: "VNM", VU: "VUT",
  WF: "WLF", WS: "WSM",
  YE: "YEM", YT: "MYT",
  ZA: "ZAF", ZM: "ZMB", ZW: "ZWE",
};

/** Bandera emoji a partir del alpha-2 (indicadores regionales unicode). */
export function flagEmoji(alpha2: string): string {
  const cc = alpha2.toUpperCase();
  if (!/^[A-Z]{2}$/.test(cc)) return "";
  return String.fromCodePoint(...[...cc].map((c) => 127397 + c.charCodeAt(0)));
}

export interface CountryOption {
  value: string; // alpha-3 (Bridge)
  name: string; // nombre localizado
  flag: string; // emoji
  alpha2: string;
}

const nameCache = new Map<string, Intl.DisplayNames>();
function displayNames(locale: string): Intl.DisplayNames {
  let dn = nameCache.get(locale);
  if (!dn) {
    try {
      dn = new Intl.DisplayNames([locale], { type: "region" });
    } catch {
      dn = new Intl.DisplayNames(["en"], { type: "region" });
    }
    nameCache.set(locale, dn);
  }
  return dn;
}

/** Lista completa de países para el selector, ordenada por nombre localizado. */
export function countryOptions(locale = "es"): CountryOption[] {
  const dn = displayNames(locale);
  const list: CountryOption[] = Object.entries(COUNTRY_A2_TO_A3).map(([a2, a3]) => {
    let name = a3;
    try {
      name = dn.of(a2) ?? a3;
    } catch {
      /* mantiene a3 */
    }
    return { value: a3, name, flag: flagEmoji(a2), alpha2: a2 };
  });
  return list.sort((a, b) => a.name.localeCompare(b.name, locale));
}

/** Nombre localizado de un país por su alpha-2; el código si no se conoce. */
export function countryName(alpha2: string, locale = "es"): string {
  try {
    return displayNames(locale).of(alpha2.toUpperCase()) ?? alpha2;
  } catch {
    return alpha2;
  }
}

/** alpha-3 → alpha-2 (para reconstruir nombre/bandera de un valor guardado). */
export function alpha3ToAlpha2(alpha3: string): string | undefined {
  const up = alpha3.toUpperCase();
  for (const [a2, a3] of Object.entries(COUNTRY_A2_TO_A3)) if (a3 === up) return a2;
  return undefined;
}

/** Acepta alpha-3 (los campos tipo `country` guardan alpha-3) o alpha-2 directo. */
export function toAlpha2(v: string): string | undefined {
  const s = v.trim().toUpperCase();
  if (/^[A-Z]{2}$/.test(s)) return s;
  if (/^[A-Z]{3}$/.test(s)) return alpha3ToAlpha2(s);
  return undefined;
}
