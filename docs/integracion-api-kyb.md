# Integración con la API KYB de Peyo

Guía para consumir uno de nuestros formularios KYB desde tu aplicación. Cubre
autenticación, todos los endpoints, el flujo del usuario final, webhooks
(registro + verificación de firma), rate limiting y manejo de errores.

---

## 1. Qué te entregamos nosotros

Antes de integrar, te proporcionamos:

| Dato | Descripción |
|---|---|
| `KYB_BASE_URL` | Base de la API. Ej. `https://kyb-peyo.vercel.app` |
| `API_KEY` | Tu clave secreta (`kyb_…`). **Se muestra una sola vez**; guárdala como secreto server-side. |
| `FORM_ID` | UUID del formulario publicado que usarán tus usuarios. |
| `WEBHOOK_ENDPOINT_ID` + `WEBHOOK_SECRET` | (Opcional, si usarás webhooks) Se generan cuando registramos **tu** URL de webhook. El secreto se muestra una sola vez. |
| Rate limit | Cuota de req/min de tu key (por defecto 60). |
| Traducción de respuestas | Desactivada por defecto. Si la necesitás (`?translate=1` en §4.4), pedila y la habilitamos para tu key. |

> **Nunca** pongas la `API_KEY` en el frontend ni en repositorios. Solo server-to-server, siempre por HTTPS.

> **De dónde salen estos valores** (nuestro lado): en el panel admin, sección
> **Clientes API → \<cliente\> → Configuración de integración**. Ahí se copian
> `KYB_BASE_URL`, `KYB_FORM_ID` y `KYB_WEBHOOK_ENDPOINT_ID`, y hay un botón
> "Copiar bloque .env". La `KYB_API_KEY` y el `KYB_WEBHOOK_SECRET` se muestran
> **una sola vez** al emitir/rotar (no se pueden recuperar; si se pierden, se rotan).

---

## 2. Autenticación

Todas las llamadas llevan la cabecera:

```
Authorization: Bearer <API_KEY>
```

- Sin cabecera o key inválida/revocada → `401 { "error": "unauthorized" }`.
- Cada key **solo ve sus propias solicitudes** (aislamiento por cliente). Pedir una solicitud que no es tuya → `404`.

---

## 3. Flujo de integración (resumen)

```
1. POST /api/v1/kyb/requests           → creas la solicitud, recibes invitationUrl
2. Rediriges a tu usuario a invitationUrl  → llena el formulario (autosave, reanudable)
3a. Recibes el resultado por WEBHOOK (push)   ── recomendado
3b. …o haces polling de GET /api/v1/kyb/requests/:id
4. Consultas detalle: /answers, /documents, /draft según necesites
```

**Aviso inmediato de envío:** en cuanto el usuario envía el formulario recibes
`request.submitted` (antes de que terminen las verificaciones), ideal para mandarle
al instante tu correo de "recibimos tu solicitud".

**Ciclo de correcciones (opcional):** tras `submitted`/`under_review`, tú (o
nuestro analista) pueden devolver la solicitud para que el usuario **corrija
preguntas puntuales** con `POST /requests/:id/request-changes` (§4.8). Eso borra
solo esas respuestas, pasa la solicitud a `changes_requested`, y devuelve un
`invitationUrl` nuevo (mismo borrador para el resto). El usuario corrige desde la
primera pregunta marcada y reenvía; el flujo vuelve a `submitted → under_review →
decisión`. Recibes un webhook `changes.requested` al pedirlas.

**Expiración y re-envío:** si el link vence sin que el usuario termine, recibes
`request.expired` (aunque nunca vuelva a abrirlo). Para reenviarle una invitación
nueva conservando el borrador, llama a `POST /:id/invitation` (§4.7).

---

## 4. Endpoints

Base: `KYB_BASE_URL/api/v1/kyb`

### 4.1 Crear solicitud — `POST /requests`

**Body (JSON):**

| Campo | Tipo | Req. | Descripción |
|---|---|---|---|
| `external_ref` | string (≤100) | **sí** | Tu identificador interno de la entidad/usuario. Se te devuelve tal cual. |
| `form_id` | uuid | no* | Formulario a usar. Usa el `FORM_ID` que te dimos. |
| `webhook_endpoint_id` | uuid | no | Endpoint de webhook registrado (ver §6). |
| `return_url` | string (https, ≤2048) | no | A dónde redirigir el navegador del usuario tras enviar. |
| `ttl_hours` | int > 0 | no | Vigencia del link de invitación (default 14 días, **máximo 2160 = 90 días**). |

> \* `form_id` es opcional en el esquema, pero **recomendado**. Tiene que ser un
> formulario **tuyo y publicado**; si no, respondemos `422 invalid_form` (no se cae a
> otro formulario en silencio). Si no lo envías, se fija **al momento de crear la
> solicitud** el `KYB_FORM_ID` configurado para tu API key o, si no hay, tu último
> formulario publicado (lo ves después en `formId`, §4.3); si luego publicas otro, esa
> solicitud no cambia. Si no tienes ningún formulario publicado, respondemos
> `422 no_published_form`.

**Cabecera opcional:** `Idempotency-Key: <valor-único>` — si reintentas con la misma
key y el mismo body, devolvemos la respuesta original (no se duplica la solicitud).

**Respuesta `201`:**

```json
{
  "id": "uuid-de-la-solicitud",
  "invitationUrl": "https://kyb-peyo.vercel.app/f/<token>",
  "token": "<token-de-invitación>",
  "expiresAt": "2026-08-01T12:00:00.000Z",
  "status": "created"
}
```

Guarda el `id` (para consultar) y el `invitationUrl` (para tu usuario).

**Ejemplo:**

```bash
curl -X POST "$KYB_BASE_URL/api/v1/kyb/requests" \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: onboarding-emp-123" \
  -d '{
    "external_ref": "emp-123",
    "form_id": "'"$FORM_ID"'",
    "webhook_endpoint_id": "'"$WEBHOOK_ENDPOINT_ID"'",
    "return_url": "https://tu-app.com/kyb/listo"
  }'
```

### 4.2 Listar solicitudes — `GET /requests`

Query params: `status`, `external_ref`, `limit` (def 20, máx 100), `offset` (def 0).

**Respuesta `200`:**

```json
{
  "data": [
    { "id": "…", "externalRef": "emp-123", "status": "under_review",
      "decision": null, "subjectTitle": "Pythas Holdings", "contactEmail": "ops@pythas.com",
      "createdAt": "…", "submittedAt": "…",
      "submissionContext": { "ipCountry": "BO" }, "decidedAt": null }
  ],
  "limit": 20, "offset": 0, "total": 42
}
```

### 4.3 Estado + resultado — `GET /requests/:id`

**Respuesta `200`:**

```json
{
  "id": "…", "externalRef": "emp-123",
  "status": "under_review", "decision": null,
  "reason": null, "corrections": null,
  "formId": "…", "formRevision": 7,
  "subjectTitle": "Pythas Holdings", "contactEmail": "ops@pythas.com",
  "expiresAt": "2026-08-01T12:00:00.000Z",
  "createdAt": "…", "submittedAt": "…",
  "submissionContext": { "ipCountry": "BO" },
  "decidedAt": null,
  "aml": [
    { "provider": "didit", "status": "passed",
      "result": { /* respuesta de DIDIT, sin campos internos nuestros */ },
      "created_at": "…", "updated_at": "…" }
  ],
  "documentExpirations": [
    { "fieldId": "…", "fieldKey": "business_license", "label": "Licencia de funcionamiento",
      "expiresOn": "2026-09-30", "source": "declared", "status": "expired" }
  ]
}
```

- `reason`: motivo legible de la decisión final (string) o `null`. Se llena al
  aprobar/rechazar con un motivo.
- `corrections`: si `status` es `changes_requested`, el set abierto de preguntas a
  corregir; si no, `null`. Shape: `{ round, requested_at, source, fields: [{ key, note }] }`.
- `formId` / `formRevision`: el formulario y la **revisión** con los que se creó la
  solicitud. Úsalos para elegir el mapeo de campos correcto (§4.9). `formRevision` es
  `null` en solicitudes anteriores a que existiera el campo.
- `subjectTitle` / `contactEmail`: respuestas a las preguntas que el formulario
  marca como **título** de la solicitud (p. ej. la razón social) y como **email de
  contacto**. Son `null` si el formulario no marca esa pregunta, si la persona no
  la respondió o no pasó por ella (pregunta condicional), o si la solicitud aún no
  tiene respuestas. Durante el llenado se van rellenando con el borrador; el valor
  definitivo queda al enviar. Trátalos como opcionales.
- `submissionContext`: datos del envío que **no** respondió el solicitante.
  `ipCountry` es el país (ISO 3166-1 alpha-2, p. ej. `"BO"`) de la IP desde la que
  se envió el formulario por última vez; un reenvío tras correcciones lo
  reemplaza. Es una aproximación por IP: con VPN o proxy da el país del servidor,
  así que úsalo como señal, no como prueba de ubicación. Es `null` si la solicitud
  aún no se envió, si se envió antes de que existiera el campo o si no hubo dato.
- `expiresAt`: vencimiento del link de invitación vigente (ISO), o `null`.
- `aml[]`: un elemento por verificación. Además de los checks por persona, puede
  incluir la **validación registral de empresa** (`feature: "kyb_registry"`).
  Este check NO corre al enviar el formulario: lo dispara un analista desde el
  panel (la búsqueda registral tarda ~90s y la consulta del perfil es
  facturable). Puede haber varias filas (una por ciclo de validación); cada una
  lleva `result.phase` (`search` → `candidate_selection` | `select` →
  `completed`) y, con el perfil ya consultado, `result.kyb_registry` (razón
  social, número y estado registral, fecha de constitución, domicilio,
  `officers[]` y `beneficial_owners[]`) más `result.declared` (lo ingresado en
  el formulario). Un check `pending` en `candidate_selection` espera que el
  analista elija la empresa correcta.
- `documentExpirations[]`: documentos cuyo vencimiento controla el formulario
  (carnets, licencias, permisos). Uno por documento subido; vacío si el formulario
  no controla ninguno. `expiresOn` es un día (`YYYY-MM-DD`, sin hora) o `null` si
  no hay fecha. `source`: `didit` (leída del documento por la verificación de
  identidad), `declared` (la escribió el solicitante) o `analyst` (la corrigió
  nuestro analista). `status`: `expired` | `expiring` (vence en los próximos 30
  días) | `valid` | `unknown`; el día del vencimiento todavía es `expiring`.
  **Un documento vencido no cambia el `status` de la solicitud**: una aprobada
  sigue `approved`. Es un aviso para que decidas tú (§8, verificación vs
  activación). Tras una renovación aceptada, `aml[]` puede traer **varias**
  verificaciones de identidad del mismo documento: la más nueva va primero.

`404 { "error": "not_found" }` si la solicitud no existe o no es tuya.

### 4.4 Respuestas del formulario — `GET /requests/:id/answers`

Query:

- `?locale=es|en` (default: idioma del formulario). Traduce las **etiquetas** (`label`)
  y las opciones de selección, que ya vienen escritas en cada idioma.
- `?translate=1` (opcional). Traduce además los **valores de texto libre** que escribió
  el solicitante. Ver abajo.

Los campos de archivo/selfie incluyen **URLs firmadas temporales**.

Cada respuesta puede traer **`skipped: true`**: significa que la lógica del formulario
**nunca le pidió ese campo** al solicitante — quedó fuera por una condición o por una rama
que no tomó. Distingue "no aplicó" de "lo dejó vacío", que antes eran indistinguibles.
Su ausencia significa que el campo sí aplicaba. **No trates un `skipped` como dato faltante**
ni lo cuentes contra la completitud del expediente.

```json
{
  "id": "…", "externalRef": "emp-123", "status": "under_review",
  "answers": [
    { "key": "legal_name", "label": "Razón social", "type": "short_text",
      "value": "ACME S.A.", "raw": "ACME S.A." },
    { "key": "id_front", "label": "Documento (frente)", "type": "file",
      "value": "ine_frente.jpg",
      "files": [{ "filename": "ine_frente.jpg", "url": "https://…firmada…" }] }
  ]
}
```

`value` es siempre texto legible. `raw` es el valor tal como se guardó, así que **su
tipo JSON depende del tipo de campo**: los campos `number` vienen como número
(`42`, no `"42"`), `boolean` como booleano, y `file`/`selfie` como arreglo de
referencias. Si comparas `raw` contra cadenas, usa `value`.

> Las solicitudes enviadas antes de esta versión pueden traer los campos `number`
> como cadena: hasta ahora se guardaba el valor sin normalizar. Los datos viejos no
> se migran, así que conviene tolerar los dos tipos. `value` no cambió en ningún caso.

#### Traducción de las respuestas (`?translate=1`)

`locale` por sí solo **no traduce lo que el usuario escribió**: las etiquetas salen en
inglés y los valores quedan en el idioma en que se llenó el formulario. Para traducir
también los valores, agregá `translate=1`.

**Requiere habilitación previa.** Viene **desactivado** para todas las API keys porque
envía datos del solicitante a un proveedor de IA externo. Pedinos que lo activemos para
tu key; hasta entonces el parámetro **se ignora en silencio** y la respuesta es idéntica
a la de siempre (no falla, no cambia de forma).

Qué se traduce: solo campos de texto libre (`short_text`, `long_text`) con al menos 2
caracteres. Fechas, números, países, archivos y opciones de selección no pasan por el
proveedor — las opciones ya se resuelven con `locale`. Los nombres propios y los códigos
se detectan y se dejan intactos.

La traducción **se agrega** en `valueTranslated`; `value` y `raw` nunca cambian. Si un
campo no aparece con `valueTranslated`, usá `value`.

```json
{
  "id": "…", "externalRef": "emp-123", "status": "under_review",
  "translatedTo": "en",
  "answers": [
    { "key": "legal_name", "label": "Legal name", "type": "short_text",
      "value": "ACME S.A.", "raw": "ACME S.A." },
    { "key": "activity", "label": "Business activity", "type": "long_text",
      "value": "Venta de repuestos automotrices al por mayor",
      "raw": "Venta de repuestos automotrices al por mayor",
      "valueTranslated": "Wholesale of automotive spare parts" }
  ]
}
```

`translatedTo` aparece **solo si tu key tiene la traducción habilitada**. Es la forma de
confirmar que el opt-in está activo: si pediste `translate=1` y no viene, todavía no te
lo activamos.

Notas de operación:

- **Cacheado** por solicitud, campo e idioma. La primera consulta paga la traducción; las
  siguientes son inmediatas. Si el solicitante corrige una respuesta, se retraduce sola.
- **Nunca tumba la lectura.** Si el proveedor falla, la respuesta llega igual, completa,
  solo sin `valueTranslated`. Reintentá más tarde.
- Si `locale` coincide con el idioma del formulario, no hay nada que traducir.
- Cada traducción queda registrada en nuestra auditoría (qué campos y cuándo).

### 4.5 Documentos — `GET /requests/:id/documents`

Query: `?expires_in=<segundos>` (60–86400, default 3600).

```json
{
  "documents": [
    { "doc_type": "general", "filename": "acta.pdf", "mime": "application/pdf",
      "size": 182734, "uploaded_at": "…", "url": "https://…firmada…", "current": true }
  ]
}
```

Las `url` son firmadas y **caducan**; genera una consulta nueva cuando las necesites.

`current` dice si el archivo es el que está **hoy** en las respuestas. Cuando se
renueva un documento vencido (ver `document.renewed` en §6) o se pide corregir una
pregunta de archivo (§4.8), el anterior se conserva como historial con `current: false`. Lo que el usuario sube en una renovación que
nuestro analista todavía no aceptó **no se lista**: aparece recién al aceptarse.

`mime` y `size` son los que **observa el servidor** en el archivo almacenado, no los
que declara el navegador de quien sube. Si tu lado decidía algo con esos valores, ahora
son confiables.

**Límites de subida** (los aplica el servidor, no solo el navegador): cada archivo
respeta el `accept` y el `maxSizeMB` del campo en el formulario, con un techo duro de
**15 MB**. Un archivo fuera de esos límites se rechaza y no queda registrado. Si tu
formulario necesita admitir algún tipo que hoy no está en su `accept`, avísanos y lo
ajustamos en la definición.

### 4.6 Avance del borrador — `GET /requests/:id/draft`

Cuánto lleva lleno el usuario, sin esperar a que envíe:

```json
{
  "id": "…", "externalRef": "emp-123", "status": "in_progress",
  "total": 12, "filled": 7, "percent": 58,
  "fields": [ { "key": "legal_name", "label": "Razón social", "filled": true, "required": true } ]
}
```

`total` y `fields[]` cuentan **solo los campos que la lógica le va a pedir a este usuario**,
siguiendo sus respuestas actuales: no incluyen los ocultos por condición ni los de ramas que
no tomó. Es el mismo conjunto que validamos al enviar, así que `percent: 100` significa que
puede enviar. Como el denominador depende de las respuestas, **puede cambiar** mientras el
usuario avanza y elige una rama u otra.

### 4.7 Re-emitir link — `POST /requests/:id/invitation`

Genera un `invitationUrl` nuevo **conservando el borrador** (si tu usuario perdió el
link o expiró). Body opcional: `{ "ttl_hours": 168 }`.

```json
{ "invitationUrl": "https://…/f/<nuevo-token>", "token": "…", "expiresAt": "…" }
```

Aplica a solicitudes `created`, `in_progress`, `expired` **y `changes_requested`**.
Este último caso es clave: cuando **nuestro analista** pide correcciones desde el
panel, el webhook que recibes **no incluye el link** (por seguridad el token solo
existe en claro al emitirse). Para obtener el link que enviar a tu usuario, llama a
este endpoint tras recibir `changes.requested`. No cambia el estado ni pierde el
borrador; solo rota el token.

`409` si la solicitud ya fue enviada o cerrada (`submitted`, `under_review`,
`approved`, `rejected`).

### 4.8 Solicitar correcciones — `POST /requests/:id/request-changes`

Devuelve la solicitud al usuario para que **corrija preguntas puntuales**. Quita
del borrador solo las respuestas marcadas para que las vuelva a responder, deja el
resto intacto, pasa el estado a `changes_requested` y **re-emite el link**. Requiere
que la solicitud esté `submitted` o `under_review`.

**Nada de lo enviado se borra.** Los archivos de las preguntas marcadas se conservan
y siguen en `GET /:id/documents` con `current: false` (§4.5). Las verificaciones de
esas preguntas también se conservan, pero dejan de listarse en `aml[]`: describen la
respuesta anterior, y al reenviar se vuelven a correr sobre la nueva. La validación
registral (`kyb_registry`) no se toca: un ciclo facturado nunca se repite solo.

**Body (JSON):**

| Campo | Tipo | Req. | Descripción |
|---|---|---|---|
| `fields` | array | **sí** | Preguntas a corregir. Cada ítem: `{ "key": "<field.key>", "note": "<qué corregir>" }` (`note` opcional). |
| `ttl_hours` | int > 0 | no | Vigencia del nuevo link (default 14 días, **máximo 2160 = 90 días**). |

**Respuesta `200`:**

```json
{
  "id": "…", "status": "changes_requested",
  "invitationUrl": "https://…/f/<nuevo-token>",
  "token": "…", "expiresAt": "…", "round": 1
}
```

Comparte el `invitationUrl` con tu usuario. El usuario arranca en la primera
pregunta marcada, ve (sin editar) sus respuestas anteriores, corrige y reenvía.
Recibes un webhook `changes.requested` (ver §6).

- `409` si la solicitud no está en un estado que admita correcciones.
- `422 { "error": "invalid_body" }` si `fields` está vacío o mal formado.

**Ejemplo:**

```bash
curl -X POST "$KYB_BASE_URL/api/v1/kyb/requests/$ID/request-changes" \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "fields": [ { "key": "id_front", "note": "La foto está borrosa; vuelve a subirla." } ] }'
```

---

### 4.9 Contrato del formulario — `GET /forms/:id`

Las claves que produce el formulario publicado, con su tipo, obligatoriedad, etiquetas y
opciones. Existe para que **montes un chequeo en CI** que compare este esquema contra las
claves que tu código consume y falle **antes** de desplegar.

```json
{
  "id": "…", "revision": 7, "locales": ["es","en"], "defaultLocale": "es",
  "fields": [
    { "key": "legal_name", "type": "short_text", "required": true, "section": "empresa",
      "label": { "es": "Razón social", "en": "Legal name" } },
    { "key": "business_type", "type": "dropdown", "required": true, "section": "empresa",
      "label": { "es": "Tipo de empresa", "en": "Business type" },
      "options": [ { "value": "llc", "label": { "es": "S. de R.L.", "en": "LLC" } } ] }
  ]
}
```

- Solo formularios **tuyos y publicados** (`404` si está en borrador, es de otro
  cliente o no existe).
- Las etiquetas viajan como objeto por locale, sin resolver, para que compares sin
  ambigüedad de idioma.
- Las **`options[].value`** son los valores que vas a recibir en las respuestas y son
  independientes del idioma. Si mapeas enums hacia un tercero (p. ej. Bridge), compáralos
  contra esta lista: es la fuente de verdad de lo que el formulario puede producir.

#### `form_revision`: cómo fijar tu mapeo

`revision` es el número de revisión del formulario **publicado hoy**. Lo incrementa cada
publicación y cada cambio que se guarda sobre un formulario ya publicado: dos solicitudes
con la misma revisión vieron exactamente las mismas preguntas.

Las solicitudes llevan la revisión con la que **se crearon**, en `formRevision`
(`GET /:id`, `GET /:id/answers`) y `form_revision` (webhook). Esa es la que debes usar para
elegir el mapeo de campos: una solicitud creada bajo la revisión 6 sigue reportando 6
aunque el formulario ya vaya por la 8. Además, la solicitud **congela la definición** al
crearse: si el formulario cambia después, tu usuario sigue llenando la de la revisión 6.
(Las solicitudes creadas por API antes de esta versión no la congelaron y siguen el
formulario vigente.)

> `formRevision` es `null` en solicitudes creadas antes de que existiera este campo. Trátalo
> como "revisión desconocida" y cae a tu mapeo por defecto — no asumas la revisión 1.

## 5. Flujo del usuario final y reanudación

- Redirige a tu usuario al `invitationUrl`. Llena el formulario (documentos, selfie, etc.).
- **Autosave**: si se sale a la mitad y vuelve al **mismo `invitationUrl`** (mientras esté `created`/`in_progress`), **se restauran sus datos**. Guarda el `invitationUrl` de tu lado.
- Si el link se pierde o expira, usa `POST /:id/invitation` para uno nuevo (mismo borrador).
- **Una vez enviado, el link ya no cambia nada**: ni el borrador, ni los documentos, ni un
  reenvío. Vuelve a aceptar cambios solo si se piden correcciones (`changes_requested`, §4.8),
  y en esa ronda el usuario puede quitar únicamente lo que subió en la ronda: lo que ya envió
  se conserva.
- Si pasaste `return_url`, al enviar el formulario el usuario es redirigido de vuelta a tu app.

---

## 6. Webhooks (recomendado sobre polling)

### Registro
Nos das tu URL de webhook y la **registramos** (solo `https`, puerto 443; rechazamos
IPs privadas/loopback). Te entregamos el `WEBHOOK_ENDPOINT_ID` (para el `POST /requests`)
y el `WEBHOOK_SECRET` (una sola vez).

### Eventos
Hacemos `POST` a tu endpoint cuando:
- `request.submitted` — el usuario **envió** el formulario (estado `submitted`), antes de que corran las verificaciones. Útil para mandarle al instante tu correo de "recibimos tu solicitud" sin esperar a los checks. **Ojo:** también se dispara cuando reenvía **tras una corrección**; si tu correo debe salir solo la primera vez, deduplica por tu propio estado (p. ej. tu primer `request.submitted` para ese `external_ref`).
- `verification.completed` — terminaron las verificaciones (estado `under_review`). **Se re-dispara** cada vez que el usuario reenvía tras una corrección (vuelve a pasar por `submitted → under_review`), así te enteras de que ya corrigió.
- `decision.made` — se aprobó/rechazó la solicitud. El body incluye `reason` (motivo legible del rechazo/aprobación, o `null`).
- `changes.requested` — se devolvió la solicitud para corregir preguntas (estado `changes_requested`). El body incluye `corrections` (`{ round, fields: [{ key, note }] }`) para que sepas **qué preguntas** y **por qué**. **No incluye el `invitationUrl`**: si tú disparaste las correcciones vía `POST /:id/request-changes`, el link viene en la respuesta de esa llamada; si las pidió nuestro analista, obtén un link fresco con `POST /:id/invitation` (§4.7) y reenvíalo a tu usuario.
- `request.expiring` — aviso **proactivo**: el link está **por vencer** (~3 días antes del `expires_at`), mientras la solicitud sigue **no enviada**. Se dispara **una sola vez** por ciclo de link (el marcador se reinicia si re-emites el link). El body incluye `expires_at`. Úsalo para recordarle al usuario que termine o para renovar con `POST /:id/invitation` (§4.7). Detectado por el barrido programado, así que llega aunque el usuario no vuelva a abrir el link.
- `request.expired` — el link/solicitud **venció** sin que el usuario terminara (estado `expired`; solo aplica a solicitudes aún **no enviadas**). Detectado por el mismo barrido programado, así que llega aunque el usuario nunca vuelva a abrir el link. Para reenviarle una invitación nueva, llama a `POST /:id/invitation` (§4.7), que revive la solicitud conservando el borrador.
  - **Timing:** `request.expired` se emite **después** de vencer; el heads-up previo es `request.expiring`. El acceso del usuario al link se corta **en tiempo real** en el instante del vencimiento (`expires_at`), independientemente del barrido. Lo que puede llegar con retraso es solo la **notificación**: con el barrido diario, ambos eventos llegan dentro de su ventana (hasta ~24 h de resolución). Si necesitas más precisión, sube la frecuencia del barrido (requiere plan que lo permita).
- `document.expired` — venció un **documento** con vencimiento controlado (carnet, licencia) de una solicitud **aprobada**. Se dispara **una sola vez** por documento y fecha, desde el barrido diario. El body incluye `document` (`{ field_id, field_key, label, expires_on, source }`). **La solicitud sigue `approved`**: el evento es un aviso. Si se corrige la fecha o llega un documento nuevo que vuelve a vencer, puede llegar otro `document.expired` para la misma pregunta.
- `document.renewed` — nuestro analista **aceptó** documentos renovados de una solicitud **aprobada** (el usuario los subió por un link de renovación). El body incluye `renewal` (`{ round, accepted_at, documents: [{ field_id, field_key, previous_expires_on, expires_on }] }`). Las respuestas y `documentExpirations` ya reflejan el documento nuevo. **La solicitud sigue `approved`**.

### Request que recibes
Cabeceras:
```
x-kyb-event: verification.completed
x-kyb-event-id: evt_…
x-kyb-delivery-id: dlv_…
x-kyb-timestamp: 1784300100
x-kyb-signature: v1=<hex>
```
Body (JSON): el mismo shape que `GET /:id` + `event`, `event_id`, `sent_at`. Incluye
`expires_at` (vencimiento del link vigente; en snake_case dentro del webhook) y
`form_revision` (§4.9), además de `reason` y `corrections` según el evento.
También trae `subject_title` y `contact_email` (los `subjectTitle`/`contactEmail`
de §4.3) y `submission_context: { ip_country }` (el `submissionContext` de §4.3),
que pueden ser `null` o faltar en eventos generados antes de que existieran:
trátalos como opcionales.

### Verificación de la firma (obligatoria)
`<hex> = HMAC-SHA256(WEBHOOK_SECRET, `x-kyb-timestamp` + "." + <body-crudo>)`

Tu receptor **debe**:
1. Recomputar la firma sobre el **body crudo** y comparar en **tiempo constante**.
2. **Rechazar** si `x-kyb-timestamp` tiene más de ~5 minutos (anti-replay).
3. **Deduplicar** por `event_id`. **Obligatorio, no opcional**: la entrega es
   *at-least-once* por diseño (ver "Reintentos").
4. Procesar de forma **idempotente** y responder `2xx` rápido.

### Reintentos

Si tu endpoint no responde `2xx`, reintentamos hasta **10 veces durante ~24 horas**:

| Intento | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 |
|---|---|---|---|---|---|---|---|---|---|---|
| Tras | — | 1 min | 5 min | 15 min | 30 min | 1 h | 2 h | 4 h | 8 h | 8 h |

Dos propiedades que tu receptor necesita conocer:

- **El `event_id` es el mismo en todos los intentos** del mismo evento; el
  `x-kyb-delivery-id` **cambia** en cada uno. Deduplica por `event_id`, nunca por
  `delivery-id`.
- **Cada intento se firma de nuevo, con un `x-kyb-timestamp` fresco.** No cacheés ni
  compares contra la firma de un intento previo: un reintento a las 6 horas trae un
  timestamp actual, precisamente para que siga pasando tu chequeo anti-replay de 5 minutos.

El body **no cambia entre intentos**: se congela cuando ocurre el evento. Un `decision.made`
entregado seis horas tarde describe la decisión tal como fue, no el estado actual de la
solicitud. Si necesitas el estado presente, consulta `GET /:id`.

Agotados los 10 intentos, la entrega queda marcada como fallida de nuestro lado y se puede
**reenviar manualmente** desde nuestro panel (avísanos). El polling de `GET /:id` sigue
siendo el respaldo definitivo.

**Ejemplo (Node.js / Express):**

```js
import crypto from "crypto";

app.post("/kyb-webhook", express.raw({ type: "application/json" }), (req, res) => {
  const raw = req.body;                       // Buffer crudo, sin parsear
  const ts = req.get("x-kyb-timestamp");
  const sig = (req.get("x-kyb-signature") || "").replace(/^v1=/, "");

  // 1) anti-replay
  if (!ts || Math.abs(Date.now() / 1000 - Number(ts)) > 300) {
    return res.status(400).send("stale");
  }
  // 2) firma en tiempo constante
  const expected = crypto
    .createHmac("sha256", process.env.WEBHOOK_SECRET)
    .update(`${ts}.${raw.toString("utf8")}`)
    .digest("hex");
  const ok =
    sig.length === expected.length &&
    crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
  if (!ok) return res.status(401).send("bad signature");

  const event = JSON.parse(raw.toString("utf8"));
  // 3) dedupe por event.event_id  4) procesar idempotente
  res.sendStatus(200);
});
```

> El polling de `GET /:id` sirve de respaldo por si una entrega falla.

---

## 7. Rate limiting

Límite por API key. Al exceder:
```
429 { "error": "rate_limited" }
Retry-After: 60
X-RateLimit-Limit: 60
X-RateLimit-Remaining: 0
```
Respeta el `Retry-After`. Endpoints de escritura/costosos (crear, re-emitir,
documentos) son más estrictos.

---

## 8. Enumeraciones

- **`status`**: `created` → `in_progress` → `submitted` → `under_review` → `approved` | `rejected` | `expired`.
  - `changes_requested` es un estado **no terminal** intermedio: se entra desde `submitted`/`under_review` al pedir correcciones, y se sale a `submitted` cuando el usuario reenvía.
- **`decision`**: `approved` | `rejected` | `null`.
- **AML `status`** (por check): `pending` | `passed` | `flagged` | `error`.
- **`documentExpirations[].status`**: `expired` | `expiring` | `valid` | `unknown`. **`source`**: `didit` | `declared` | `analyst`.

### Vocabulario: verificación vs activación

Dos decisiones distintas que conviene no mezclar, porque viven en sistemas distintos:

| | Quién | Qué es |
|---|---|---|
| **Verificación** | Nosotros (este servicio) | Nuestro analista determina si la documentación y los checks respaldan la identidad de la empresa. Es lo que viaja en `decision` y en el evento `decision.made`. |
| **Activación** | Tú | Dar de alta la cuenta y habilitar operación. Es una decisión **comercial y regulatoria tuya**, con tus propios requisitos (contratos, referidos, estado de KYC). |

Nuestra verificación es un **insumo** de tu activación, nunca un sustituto. Un
`decision: "approved"` no significa "activa la cuenta": significa "la verificación pasó".
Evita llamar "approve" a las dos cosas en tu código — es el atajo que termina cableando una
a la otra.

---

## 9. Errores

| HTTP | `error` | Cuándo |
|---|---|---|
| 400 | `invalid_json` | Body no es JSON |
| 401 | `unauthorized` | Falta/invalida la API key |
| 403 | `organization_suspended` | Tu organización está suspendida: la API no acepta pedidos hasta que la reactiven. Los links de invitación ya emitidos siguen funcionando |
| 404 | `not_found` | La solicitud no existe o no es tuya |
| 409 | `idempotency_key_reuse` / `request_in_progress` | Misma Idempotency-Key con body distinto / en curso |
| 409 | (re-emitir) | La solicitud ya fue enviada o cerrada |
| 409 | (request-changes) | La solicitud no está en un estado que admita correcciones |
| 422 | `invalid_body` / `invalid_return_url` / `invalid_webhook_endpoint` | Validación del body |
| 422 | `invalid_form` | El `form_id` no es un formulario tuyo publicado |
| 422 | `no_published_form` | Sin `form_id` y no tienes ningún formulario publicado |
| 429 | `rate_limited` | Cuota excedida |

---

## 10. Checklist de configuración de tu lado

- [ ] Guardar `API_KEY` como secreto server-side (nunca en frontend).
- [ ] Guardar `FORM_ID`, `WEBHOOK_ENDPOINT_ID`.
- [ ] Guardar `WEBHOOK_SECRET` (verificación de firma).
- [ ] Implementar el receptor de webhook con verificación de firma, anti-replay y dedupe.
- [ ] Persistir el `invitationUrl` (para reanudación) y el `id` (para consultas).
- [ ] Definir tu `external_ref` y (opcional) tu `return_url` https.
- [ ] Manejar `429` con `Retry-After` y usar `Idempotency-Key` en la creación.
- [ ] Si vas a leer las respuestas traducidas (`?translate=1`): pedirnos la habilitación,
      confirmar que llega `translatedTo`, y leer `valueTranslated` con fallback a `value`.
