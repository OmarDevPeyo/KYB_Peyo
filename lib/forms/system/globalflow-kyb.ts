/**
 * Formulario del sistema «GlobalFlow · KYB empresas».
 *
 * Lo consume GlobalFlow (modo `peyo_api`): su contrato (`shared/kybFormContract.ts`
 * en ese repo) lee estas claves y estos valores para calificar el riesgo, armar
 * los contratos y precargar Bridge. Por eso vive en el código y no en el panel
 * (ver 0035): un cambio que toque claves, opciones o ramas sube `version`, y
 * GlobalFlow tiene que conocer esa versión antes de recibir solicitudes con ella.
 *
 * Reglas:
 * - Todo sí/no es `single_choice` con `yes`/`no`: un `boolean` obligatorio solo
 *   acepta «sí».
 * - Las opciones de Bridge usan los valores que GlobalFlow ya verificó contra
 *   Bridge (`shared/bridgeCustomerOptions.ts`), no los del preset de Peyo.
 * - Didit por partes, al enviar: AML de la empresa (en la razón social), y de
 *   cada persona verificación del CI y AML. El registro mercantil lo lanza el
 *   analista. Un socio empresa lleva el AML de empresa sobre su razón social.
 * - Hasta 5 socios, uno por sección. Con más de 5 se exige el registro de
 *   accionistas y se cargan los 5 de mayor participación.
 *
 * Los `id` de las preguntas son sus `key`: estables, porque `internalFields`
 * apunta por id.
 *
 * Extensiones explícitas y sin alias `@/`: se prueba con `node --test`.
 */
import type {
  AmlSubject,
  Condition,
  Field,
  FieldReview,
  FormDefinition,
  FormOption,
  Section,
} from "../definition.ts";
import { GLOBALFLOW_KYB_KEY, GLOBALFLOW_KYB_VERSION } from "./keys.ts";

export { GLOBALFLOW_KYB_KEY, GLOBALFLOW_KYB_VERSION };

type L = { es: string; en: string };

const l = (es: string, en: string): L => ({ es, en });
const opt = (value: string, es: string, en: string, extra: Partial<FormOption> = {}): FormOption => ({
  value,
  label: l(es, en),
  ...extra,
});

type FieldInput = Omit<Field, "id" | "label" | "required"> & {
  label: L;
  required?: boolean;
};

function field(f: FieldInput): Field {
  return { ...f, id: f.key, required: f.required ?? true };
}

const YES_NO: FormOption[] = [opt("yes", "Sí", "Yes"), opt("no", "No", "No")];

const yesNo = (key: string, label: L, extra: Partial<FieldInput> = {}): Field =>
  field({ key, type: "single_choice", label, options: YES_NO, ...extra });

const IMAGE_OR_PDF = ["image/*", "application/pdf"];
const file = (key: string, label: L, extra: Partial<FieldInput> = {}): Field =>
  field({ key, type: "file", label, file: { accept: IMAGE_OR_PDF, multiple: false, maxSizeMB: 15 }, ...extra });
const files = (key: string, label: L, extra: Partial<FieldInput> = {}): Field =>
  field({ key, type: "file", label, file: { accept: IMAGE_OR_PDF, multiple: true, maxSizeMB: 15 }, ...extra });

const didit = (feature: FieldReview["feature"], aml?: AmlSubject): FieldReview => ({
  provider: "didit",
  feature,
  ...(aml ? { aml } : {}),
});

const eq = (fieldKey: string, value: string): Condition => ({ field: fieldKey, op: "eq", value });

// ------------------------------------------------------------
// Opciones (valores = lo que lee GlobalFlow)
// ------------------------------------------------------------
export const LEGAL_FORMS: FormOption[] = [
  opt("unipersonal", "Empresa unipersonal", "Sole proprietorship"),
  opt("srl", "Sociedad de responsabilidad limitada (S.R.L.)", "Limited liability company (S.R.L.)"),
  opt("sa", "Sociedad anónima (S.A.)", "Corporation (S.A.)"),
  opt("cooperativa", "Cooperativa", "Cooperative"),
  opt("otra", "Otra", "Other"),
];

/** Las 13 actividades del Google Forms, más «Ninguna», que va sola. */
export const REGULATED_ACTIVITIES: FormOption[] = [
  opt("financial_services", "Servicios financieros", "Financial services"),
  opt("lending_banking", "Préstamos o banca", "Lending or banking"),
  opt("virtual_currency", "Corretaje de monedas virtuales", "Virtual currency brokerage"),
  opt("client_funds_custody", "Resguardo de fondos de clientes", "Safekeeping of client funds"),
  opt("investment_services", "Servicios de inversión", "Investment services"),
  opt("safe_deposit_boxes", "Alquiler de cajas de seguridad", "Safe deposit box rental"),
  opt("third_party_payments", "Pagos de terceras personas", "Third-party payments"),
  opt("adult_entertainment", "Entretenimiento para adultos", "Adult entertainment"),
  opt("weapons_explosives", "Armas, explosivos y similares", "Weapons, explosives and similar"),
  opt("gambling", "Apuestas y juegos de azar", "Gambling"),
  opt("nicotine_tobacco", "Nicotina, tabaco o servicios relacionados", "Nicotine, tobacco or related services"),
  opt("pharmaceuticals", "Medicamentos", "Pharmaceuticals"),
  opt("precious_metals_gems", "Metales preciosos, gemas o joyería", "Precious metals, gems or jewelry"),
  opt("none", "Ninguna de las anteriores", "None of the above", { exclusive: true }),
];

/** `estimated_annual_revenue_usd` de Bridge (verificado en GlobalFlow). */
export const ANNUAL_REVENUE: FormOption[] = [
  opt("0_99999", "USD 0 – 99.999", "USD 0 – 99,999"),
  opt("100000_999999", "USD 100.000 – 999.999", "USD 100,000 – 999,999"),
  opt("1000000_9999999", "USD 1 M – 9,99 M", "USD 1M – 9.99M"),
  opt("10000000_49999999", "USD 10 M – 49,99 M", "USD 10M – 49.99M"),
  opt("50000000_249999999", "USD 50 M – 249,99 M", "USD 50M – 249.99M"),
  opt("250000000_plus", "USD 250 M o más", "USD 250M+"),
];

/** `account_purpose` de Bridge para empresas (verificado en GlobalFlow). */
export const ACCOUNT_PURPOSE: FormOption[] = [
  opt("receive_payments_for_goods_and_services", "Recibir pagos por bienes y servicios", "Receive payments for goods and services"),
  opt("purchase_goods_and_services", "Compra de bienes y servicios", "Purchase of goods and services"),
  opt("ecommerce_retail_payments", "Pagos de comercio electrónico / retail", "E-commerce / retail payments"),
  opt("payroll", "Pago de nómina", "Payroll"),
  opt("treasury_management", "Gestión de tesorería", "Treasury management"),
  opt("tax_optimization", "Optimización fiscal", "Tax optimization"),
  opt("third_party_money_transmission", "Transmisión de dinero de terceros", "Third-party money transmission"),
  opt("investment_purposes", "Fines de inversión", "Investment purposes"),
  opt("payments_to_friends_or_family_abroad", "Pagos a familiares o amigos en el extranjero", "Payments to friends or family abroad"),
  opt("personal_or_living_expenses", "Gastos personales o de manutención", "Personal or living expenses"),
  opt("charitable_donations", "Donaciones benéficas", "Charitable donations"),
  opt("protect_wealth", "Protección de patrimonio", "Protect wealth"),
  opt("other", "Otro", "Other"),
];

/** `source_of_funds` de Bridge para empresas (verificado en GlobalFlow). */
export const SOURCE_OF_FUNDS: FormOption[] = [
  opt("sales_of_goods_and_services", "Venta de bienes y servicios", "Sales of goods and services"),
  opt("business_loans", "Préstamos del negocio", "Business loans"),
  opt("owners_capital", "Capital de los dueños", "Owners' capital"),
  opt("investment_proceeds", "Ingresos por inversiones", "Investment proceeds"),
  opt("inter_company_funds", "Fondos intercompañía", "Inter-company funds"),
  opt("treasury_reserves", "Reservas de tesorería", "Treasury reserves"),
  opt("grants", "Subvenciones", "Grants"),
  opt("legal_settlement", "Acuerdo legal", "Legal settlement"),
  opt("sale_of_assets", "Venta de activos", "Sale of assets"),
  opt("third_party_funds", "Fondos de terceros", "Third-party funds"),
  opt("pension_retirement", "Pensión / jubilación", "Pension / retirement"),
];

export const PROFITABILITY: FormOption[] = [
  opt("covers_100", "Cubre el 100 % de sus gastos", "Covers 100% of its expenses"),
  opt("covers_75", "Cubre el 75 % de sus gastos", "Covers 75% of its expenses"),
  opt("covers_50", "Cubre el 50 % de sus gastos", "Covers 50% of its expenses"),
  opt("covers_25", "Cubre el 25 % de sus gastos", "Covers 25% of its expenses"),
  opt("less_than_25", "Menos del 25 % de sus gastos", "Less than 25% of its expenses"),
];

export const DOCUMENT_TYPES: FormOption[] = [
  opt("ci", "Cédula de identidad", "National ID card"),
  opt("passport", "Pasaporte", "Passport"),
  opt("foreign_id", "Carnet de extranjero", "Foreign resident ID"),
];

export const PARTNER_TYPES: FormOption[] = [
  opt("person", "Persona", "Individual"),
  opt("company", "Empresa", "Company"),
];

export const PARTNER_COUNTS: FormOption[] = [
  opt("1", "1", "1"),
  opt("2", "2", "2"),
  opt("3", "3", "3"),
  opt("4", "4", "4"),
  opt("5", "5", "5"),
  opt("more_than_5", "Más de 5", "More than 5"),
];

/**
 * Los 62 bancos del Google Forms, con el mismo texto, en orden alfabético.
 * GlobalFlow no los interpreta. «Otro» abre el nombre a mano.
 */
const BANKS = [
  "ADMINISTRADORA DE TARJETAS DE CREDITO",
  "BANCO BISA",
  "BANCO CENTRAL DE BOLIVIA",
  "BANCO CENTRAL DE BOLIVIA - MLD",
  "BANCO DE CREDITO",
  "BANCO DE LA NACION ARGENTINA",
  "BANCO ECONOMICO",
  "BANCO FIE S.A.",
  "BANCO FORTALEZA S.A.",
  "BANCO GANADERO",
  "BANCO MERCANTIL",
  "BANCO NACIONAL DE BOLIVIA",
  "BANCO PYME DE LA COMUNIDAD",
  "BANCO PYME ECOFUTURO S.A.",
  "BANCO SOL",
  "BANCO UNION",
  "CIDRE IFD",
  "COOPERATIVA ABIERTA SAN FRANCISCO SOLANO R.L.",
  "COOPERATIVA ABIERTA SAN PEDRO DE AIQUILE R.L.",
  "COOPERATIVA ASOCIACION DE PRODUCTORES DE LECHE R.L.",
  "COOPERATIVA ASUNCION LTDA",
  "COOPERATIVA CACEF R.L.",
  "COOPERATIVA CATEDRAL LTDA",
  "COOPERATIVA COMARAPA LTDA",
  "COOPERATIVA EDUCADORES GRAN CHACO LTDA",
  "COOPERATIVA EL CHOROLQUE LTDA",
  "COOPERATIVA FÁTIMA LTDA.",
  "COOPERATIVA INCA HUASI LTDA.",
  "COOPERATIVA JESUS NAZARENO",
  "COOPERATIVA LA MERCED",
  "COOPERATIVA LA SAGRADA FAMILIA R.L.",
  "COOPERATIVA LOYOLA R.L.",
  "COOPERATIVA MADRE Y MAESTRA LTDA",
  "COOPERATIVA MAGISTERIO RURAL DE CHUQUISACA R.L.",
  "COOPERATIVA MAGISTERIO RURAL LTDA",
  "COOPERATIVA MONSEÑOR FELIX GAINZA LTDA",
  "COOPERATIVA PIO X R.L.",
  "COOPERATIVA PROGRESO R.L.",
  "COOPERATIVA QUILLACOLLO",
  "COOPERATIVA SAN ANTONIO R.L.",
  "COOPERATIVA SAN CARLOS BORROMEO LTDA",
  "COOPERATIVA SAN JOAQUIN R.L.",
  "COOPERATIVA SAN JOSE DE BERMEJO LTDA",
  "COOPERATIVA SAN JOSE DE PUNATA LTDA",
  "COOPERATIVA SAN MARTIN DE PORRES",
  "COOPERATIVA SAN MATEO LTDA",
  "COOPERATIVA SAN PEDRO LTDA.",
  "COOPERATIVA SAN ROQUE R.L.",
  "COOPERATIVA SOCIETARIA SAN MARTIN R.L.",
  "COOPERATIVA SOCIETARIA VIRGEN DE LOS REMEDIOS R.L.",
  "COOPERATIVA TRINIDAD LTDA",
  "CRECER IFD",
  "DIACONIA IFD",
  "EL PROGRESO EFV",
  "FUBODE IFD",
  "FUNDACION PROMUJER IFD",
  "IDEPRO IFD",
  "LA PRIMERA EFV",
  "LA PROMOTORA EFV",
  "LINKSER S.A.",
  "TIGO MONEY",
  "UNILINK S.A.",
];

// ------------------------------------------------------------
// Socios y representante
// ------------------------------------------------------------
export const MAX_PARTNERS = 5;

/** Valores de `partners_count` con los que se pide el socio `n` (1..5). */
export function partnerCountsFor(n: number): string[] {
  return PARTNER_COUNTS.map((o) => o.value).filter((v) => v === "more_than_5" || Number(v) >= n);
}

const partnerKey = (n: number, suffix: string) => `partner_${n}_${suffix}`;

/** Datos de una persona (socio o representante) con su CI y su AML. */
function personFields(prefix: string, extra: { visibleIf?: Condition; contact?: boolean }): Field[] {
  const k = (s: string) => `${prefix}_${s}`;
  const v = extra.visibleIf ? { visibleIf: extra.visibleIf } : {};
  return [
    field({
      key: k("first_names"),
      type: "short_text",
      label: l("Nombres", "First names"),
      review: didit("aml_screening", {
        entityType: "person",
        nameKeys: [k("first_names"), k("last_names")],
        dobKey: k("birth_date"),
        nationalityKey: k("nationality"),
        documentKey: k("doc_number"),
      }),
      validation: { maxLen: 120 },
      ...v,
    }),
    field({ key: k("last_names"), type: "short_text", label: l("Apellidos", "Last names"), validation: { maxLen: 120 }, ...v }),
    field({ key: k("birth_date"), type: "date", label: l("Fecha de nacimiento", "Date of birth"), ...v }),
    field({ key: k("nationality"), type: "country", label: l("Nacionalidad", "Nationality"), ...v }),
    field({ key: k("doc_type"), type: "dropdown", label: l("Tipo de documento", "Document type"), options: DOCUMENT_TYPES, ...v }),
    field({ key: k("doc_number"), type: "short_text", label: l("Número de documento", "Document number"), validation: { maxLen: 40 }, ...v }),
    field({ key: k("doc_country"), type: "country", label: l("País que emitió el documento", "Issuing country"), ...v }),
    file(k("id_front"), l("Documento de identidad (anverso)", "ID document (front)"), {
      review: didit("id_verification"),
      help: l(
        "Foto clara, sin reflejos, en la que se lean todos los datos.",
        "A clear photo, without glare, where every detail can be read.",
      ),
      ...v,
    }),
    // El pasaporte no tiene reverso.
    file(k("id_back"), l("Documento de identidad (reverso)", "ID document (back)"), {
      review: didit("id_verification"),
      visibleIf: extra.visibleIf
        ? { all: [extra.visibleIf, { field: k("doc_type"), op: "neq", value: "passport" }] }
        : { field: k("doc_type"), op: "neq", value: "passport" },
    }),
    ...(extra.contact === false
      ? []
      : [
          field({ key: k("phone"), type: "short_text", label: l("Celular", "Mobile phone"), validation: { maxLen: 30 }, ...v }),
          field({ key: k("email"), type: "email", label: l("Correo electrónico", "Email"), ...v }),
          field({ key: k("address"), type: "long_text", label: l("Dirección del domicilio", "Home address"), validation: { maxLen: 300 }, ...v }),
        ]),
  ];
}

function partnerSection(n: number): Section {
  const k = (s: string) => partnerKey(n, s);
  const isPerson = eq(k("type"), "person");
  const isCompany = eq(k("type"), "company");
  return {
    id: `partner_${n}`,
    title: l(`Socio ${n}`, `Partner ${n}`),
    description: l(
      "Si son más de 5, carga los de mayor participación.",
      "If there are more than 5, enter those with the largest ownership.",
    ),
    visibleIf: { field: "partners_count", op: "in", value: partnerCountsFor(n) },
    fields: [
      field({ key: k("type"), type: "single_choice", label: l("¿El socio es una persona o una empresa?", "Is the partner an individual or a company?"), options: PARTNER_TYPES }),
      field({
        key: k("ownership_pct"),
        type: "number",
        label: l("Porcentaje de participación (%)", "Ownership percentage (%)"),
        validation: { min: 0.01, max: 100 },
      }),
      ...personFields(`partner_${n}`, { visibleIf: isPerson }),
      yesNo(k("is_legal_rep"), l("¿Es el representante legal de la empresa?", "Is this person the company's legal representative?"), {
        visibleIf: isPerson,
      }),
      field({
        key: k("company_name"),
        type: "short_text",
        label: l("Razón social del socio", "Partner's legal name"),
        review: didit("aml_screening", { entityType: "company" }),
        validation: { maxLen: 200 },
        visibleIf: isCompany,
      }),
      field({ key: k("company_country"), type: "country", label: l("País de constitución del socio", "Partner's country of incorporation"), visibleIf: isCompany }),
      field({ key: k("company_tax_id"), type: "short_text", label: l("NIT o identificación tributaria del socio", "Partner's tax ID"), validation: { maxLen: 40 }, visibleIf: isCompany }),
      file(k("company_incorporation_doc"), l("Documento de constitución del socio", "Partner's incorporation document"), { visibleIf: isCompany }),
    ],
  };
}

/**
 * El representante legal aparte se pide solo si ningún socio PERSONA que se
 * pidió dijo serlo. Se escribe sin «not» (las condiciones no lo tienen): para
 * cada socio, o no se pidió, o no es persona, o no es el representante. Mirar
 * si se pidió importa: el borrador conserva respuestas de socios que la
 * persona dejó de cargar al bajar la cantidad.
 */
export const LEGAL_REP_SECTION_VISIBLE: Condition = {
  all: Array.from({ length: MAX_PARTNERS }, (_, i) => {
    const n = i + 1;
    return {
      any: [
        { field: "partners_count", op: "not_in", value: partnerCountsFor(n) },
        { field: partnerKey(n, "type"), op: "neq", value: "person" },
        { field: partnerKey(n, "is_legal_rep"), op: "neq", value: "yes" },
      ],
    } as Condition;
  }),
};

// ------------------------------------------------------------
// Definición
// ------------------------------------------------------------
export const GLOBALFLOW_KYB_FORM: FormDefinition = {
  version: 1,
  title: l("GlobalFlow · KYB empresas", "GlobalFlow · Business KYB"),
  locales: ["es", "en"],
  defaultLocale: "es",
  meta: { system: { key: GLOBALFLOW_KYB_KEY, version: GLOBALFLOW_KYB_VERSION } },
  internalFields: { title: "company_legal_name", contactEmail: "company_email" },
  sections: [
    {
      id: "company",
      title: l("Empresa", "Company"),
      fields: [
        field({
          key: "company_legal_name",
          type: "short_text",
          label: l("Razón social", "Legal name"),
          validation: { maxLen: 200 },
          // Registro mercantil (lo lanza el analista) + AML de la empresa al enviar.
          review: {
            provider: "didit",
            feature: "kyb_registry",
            kybCountryKey: "company_incorporation_country",
            kybRegNumberKey: "company_registration_number",
            aml: { entityType: "company", dobKey: "company_incorporation_date" },
          },
        }),
        field({ key: "company_tax_id", type: "short_text", label: l("NIT", "Tax ID (NIT)"), validation: { maxLen: 40 } }),
        field({ key: "company_registration_number", type: "short_text", label: l("Número de matrícula de comercio", "Commercial registration number"), validation: { maxLen: 60 } }),
        field({ key: "company_incorporation_country", type: "country", label: l("País de constitución", "Country of incorporation") }),
        field({ key: "company_legal_form", type: "dropdown", label: l("Tipo de sociedad", "Legal form"), options: LEGAL_FORMS }),
        field({ key: "company_incorporation_date", type: "date", label: l("Fecha de constitución", "Date of incorporation") }),
        field({ key: "company_address_street", type: "short_text", label: l("Dirección (calle y número)", "Address (street and number)"), validation: { maxLen: 200 } }),
        field({ key: "company_address_city", type: "short_text", label: l("Ciudad", "City"), validation: { maxLen: 100 } }),
        field({ key: "company_address_state", type: "short_text", label: l("Departamento o estado", "State or department"), required: false, validation: { maxLen: 100 } }),
        field({ key: "company_address_postal_code", type: "short_text", label: l("Código postal", "Postal code"), required: false, validation: { maxLen: 20 } }),
        field({ key: "company_address_country", type: "country", label: l("País de la dirección", "Address country") }),
        field({ key: "company_phone", type: "short_text", label: l("Celular con WhatsApp de la empresa", "Company mobile number with WhatsApp"), validation: { maxLen: 30 } }),
        field({ key: "company_email", type: "email", label: l("Correo de contacto", "Contact email") }),
        field({
          key: "company_website",
          type: "short_text",
          label: l("Sitio web o redes sociales", "Website or social media"),
          required: false,
          validation: { maxLen: 300 },
          help: l("Si no tiene, déjelo en blanco.", "Leave it blank if you have none."),
        }),
        field({ key: "company_years_operating", type: "number", label: l("Años de operación", "Years in operation"), validation: { min: 0, max: 200, integer: true } }),
        yesNo("company_publicly_listed", l("¿La empresa cotiza en alguna bolsa de valores?", "Is the company listed on a stock exchange?")),
      ],
    },
    {
      id: "activity",
      title: l("Actividad", "Activity"),
      fields: [
        field({
          key: "business_description",
          type: "long_text",
          label: l("Describa las actividades principales de la empresa", "Describe the company's main activities"),
          validation: { minLen: 20, maxLen: 2000 },
        }),
        field({
          key: "business_industry",
          type: "naics",
          label: l("Industria (NAICS)", "Industry (NAICS)"),
          help: l(
            "Busque por palabra (p. ej. «software», «transporte») o por código.",
            "Search by word (e.g. “software”, “trucking”) or by code.",
          ),
        }),
        field({
          key: "regulated_activities",
          type: "multiple_choice",
          label: l("¿La empresa realiza alguna de estas actividades?", "Does the company carry out any of these activities?"),
          options: REGULATED_ACTIVITIES,
          help: l("Si no realiza ninguna, marque «Ninguna de las anteriores».", "If none apply, choose “None of the above”."),
        }),
        files("regulated_license", l(
          "Permiso o licencia vigente para las actividades marcadas",
          "Valid permit or license for the activities selected",
        ), {
          visibleIf: {
            all: [
              { field: "regulated_activities", op: "answered" },
              { field: "regulated_activities", op: "not_in", value: ["none"] },
            ],
          },
        }),
      ],
    },
    {
      id: "declarations",
      title: l("Declaraciones", "Declarations"),
      fields: [
        yesNo("pep_declared", l(
          "¿Algún socio, director o el representante legal es una Persona Expuesta Políticamente (PEP)?",
          "Is any partner, director or the legal representative a Politically Exposed Person (PEP)?",
        )),
        field({
          key: "pep_details",
          type: "long_text",
          label: l("¿Quién es y qué cargo ocupa u ocupó?", "Who is it and what position do or did they hold?"),
          validation: { minLen: 5, maxLen: 1000 },
          visibleIf: eq("pep_declared", "yes"),
        }),
        yesNo("us_bank_denied", l(
          "¿A la empresa o a sus socios les negaron o cerraron cuentas bancarias en EE. UU.?",
          "Has the company or any partner had a US bank account denied or closed?",
        )),
        yesNo("legal_actions", l(
          "¿Hay auditorías fiscales o regulatorias, o acciones legales en curso, contra la empresa o sus socios?",
          "Are there tax or regulatory audits, or legal actions in progress, against the company or its partners?",
        )),
        field({
          key: "legal_actions_details",
          type: "long_text",
          label: l("Detalle", "Details"),
          validation: { minLen: 5, maxLen: 1000 },
          visibleIf: eq("legal_actions", "yes"),
        }),
      ],
    },
    {
      id: "profile",
      title: l("Perfil financiero y transaccional", "Financial and transaction profile"),
      fields: [
        field({
          key: "expected_monthly_volume_usd",
          type: "number",
          label: l("Volumen mensual esperado (USD)", "Expected monthly volume (USD)"),
          validation: { min: 1, max: 100_000_000 },
          help: l("Monto en dólares que estima enviar por mes.", "Dollar amount you expect to send each month."),
        }),
        field({ key: "annual_revenue_range", type: "dropdown", label: l("Ingresos anuales estimados", "Estimated annual revenue"), options: ANNUAL_REVENUE }),
        field({
          key: "monthly_transactions",
          type: "number",
          label: l("Transacciones por mes", "Transactions per month"),
          validation: { min: 1, max: 100_000, integer: true },
        }),
        field({ key: "account_purpose", type: "dropdown", label: l("Propósito de la cuenta", "Account purpose"), options: ACCOUNT_PURPOSE }),
        field({
          key: "account_purpose_other",
          type: "short_text",
          label: l("Detalle el propósito", "Describe the purpose"),
          validation: { minLen: 3, maxLen: 200 },
          visibleIf: eq("account_purpose", "other"),
        }),
        yesNo("third_party_operations", l(
          "¿Opera o hace transacciones en nombre de clientes, proveedores u otros terceros?",
          "Do you operate or transact on behalf of clients, suppliers or other third parties?",
        ), {
          help: l(
            "Responda «Sí» si la empresa envía, recibe o retiene fondos que no son solo para su propio beneficio.",
            "Answer “Yes” if the company sends, receives or holds funds that are not solely for its own benefit.",
          ),
        }),
        field({ key: "operating_country_1", type: "country", label: l("País principal donde opera", "Main country of operation") }),
        field({ key: "operating_country_2", type: "country", label: l("Otro país donde opera (opcional)", "Another country of operation (optional)"), required: false }),
        field({ key: "operating_country_3", type: "country", label: l("Otro país donde opera (opcional)", "Another country of operation (optional)"), required: false }),
        field({ key: "source_of_funds", type: "dropdown", label: l("Origen principal de los fondos", "Main source of funds"), options: SOURCE_OF_FUNDS }),
        field({
          key: "source_of_funds_explanation",
          type: "long_text",
          label: l("Explique el origen de los fondos", "Explain the source of funds"),
          validation: { minLen: 10, maxLen: 1000 },
        }),
        field({
          key: "company_profitability",
          type: "single_choice",
          label: l("¿Con sus ingresos, qué parte de sus gastos cubre la empresa?", "What share of its expenses does the company cover with its income?"),
          options: PROFITABILITY,
        }),
        field({
          key: "available_cash_usd",
          type: "number",
          label: l("Efectivo disponible hoy (USD)", "Cash available today (USD)"),
          validation: { min: 0, max: 100_000_000_000 },
        }),
      ],
    },
    {
      id: "company_documents",
      title: l("Documentos de la empresa", "Company documents"),
      fields: [
        file("doc_tax_id", l("NIT", "Tax ID (NIT)")),
        file("doc_commercial_registration", l("Matrícula de comercio vigente", "Valid commercial registration")),
        file("doc_incorporation_deed", l("Testimonio de constitución", "Deed of incorporation")),
        field({ key: "incorporation_deed_number", type: "short_text", label: l("Número del testimonio de constitución", "Deed of incorporation number"), required: false, validation: { maxLen: 60 } }),
        files("doc_amendments", l("Modificaciones a la constitución", "Amendments to the incorporation"), {
          required: false,
          help: l("Si hubo cambios en la constitución o en la participación.", "If the incorporation or the ownership changed."),
        }),
        file("doc_power_of_attorney", l("Poder del representante legal", "Legal representative's power of attorney"), { required: false }),
        field({ key: "power_of_attorney_number", type: "short_text", label: l("Número del poder", "Power of attorney number"), required: false, validation: { maxLen: 60 } }),
        files("doc_bank_statements", l("Extractos bancarios de los últimos 3 meses, a nombre de la empresa", "Bank statements for the last 3 months, in the company's name")),
        files("doc_invoices", l("3 facturas, cotizaciones o contratos emitidos a clientes", "3 invoices, quotes or contracts issued to clients")),
        file("doc_proof_of_address", l(
          "Comprobante de domicilio reciente a nombre de la empresa (agua, luz o similar)",
          "Recent proof of address in the company's name (water, power or similar)",
        )),
        files("doc_financial_statements", l(
          "Estados financieros de la última gestión (o formulario 500)",
          "Financial statements for the last fiscal year (or form 500)",
        )),
      ],
    },
    {
      id: "partners",
      title: l("Socios", "Partners"),
      fields: [
        field({ key: "partners_count", type: "single_choice", label: l("¿Cuántos socios tiene la empresa?", "How many partners does the company have?"), options: PARTNER_COUNTS }),
        files("shareholder_registry", l("Registro de accionistas", "Shareholder registry"), {
          visibleIf: eq("partners_count", "more_than_5"),
          help: l(
            "Con más de 5 socios, a continuación cargue los 5 de mayor participación.",
            "With more than 5 partners, enter the 5 with the largest ownership next.",
          ),
        }),
      ],
    },
    ...Array.from({ length: MAX_PARTNERS }, (_, i) => partnerSection(i + 1)),
    {
      id: "legal_rep",
      title: l("Representante legal", "Legal representative"),
      description: l(
        "Ninguno de los socios es el representante legal: cargue sus datos.",
        "None of the partners is the legal representative: enter their details.",
      ),
      visibleIf: LEGAL_REP_SECTION_VISIBLE,
      fields: personFields("legal_rep", {}),
    },
    {
      id: "references",
      title: l("Referencias y términos", "References and terms"),
      fields: [
        field({ key: "usd_account_number", type: "short_text", label: l("Número de cuenta en USD de la empresa", "Company USD account number"), validation: { maxLen: 40 } }),
        field({
          key: "bank_name",
          type: "dropdown",
          label: l("Banco", "Bank"),
          options: [...BANKS.map((b) => opt(b, b, b)), opt("other", "Otro", "Other")],
        }),
        field({
          key: "bank_name_other",
          type: "short_text",
          label: l("Nombre del banco", "Bank name"),
          validation: { maxLen: 120 },
          visibleIf: eq("bank_name", "other"),
        }),
        field({
          key: "accept_terms",
          type: "boolean",
          label: l("Términos y condiciones", "Terms and conditions"),
          placeholder: l("Acepto los términos y condiciones", "I accept the terms and conditions"),
          help: l("https://www.peyopagos.com/terminos", "https://www.peyopagos.com/terminos"),
        }),
      ],
    },
  ],
};
