# Servicio KYB

Servicio externo de validación de empresas (KYB). Formulario grande por invitación,
integración AML con DIDIT, y panel de revisión para analistas. Next.js + Supabase.

## Arquitectura

Tres superficies sobre una app Next.js (App Router) + Supabase:

1. **Formulario público** (`/f/[token]`) — acceso por token de invitación, sin cuenta.
   Autosave y subida de documentos. Todo pasa por Server Actions con el cliente
   service-role (server-only); el token es el gatekeeper.
2. **API máquina-a-máquina** (`/api/v1/kyb/...`) — para la app principal. Auth por API key.
3. **Panel de revisión** (`/admin`) — analistas con Supabase Auth + RLS.

### Flujo

1. App principal → `POST /api/v1/kyb/requests` (API key) → recibe `invitationUrl` + `token`.
2. Usuario llena `/f/[token]`, sube documentos, envía.
3. Al enviar se dispara el check AML (mock en local / DIDIT en prod); estado → `under_review`.
4. App principal → `GET /api/v1/kyb/requests/:id` → estado + resultado + AML.
5. Analista revisa en `/admin` y aprueba/rechaza.

## Requisitos

- Node 20+ / 22+, npm
- **Docker Desktop** (para Supabase local)

## Puesta en marcha (local)

```bash
npm install
cp .env.example .env.local          # completar claves (ver abajo)

# captcha local (Turnstile, clave secreta de PRUEBA de Cloudflare; ver supabase/config.toml).
# Hoy está EN PAUSA en todo el panel: CAPTCHA_PAUSED en lib/auth/captcha.ts.
echo "SUPABASE_AUTH_CAPTCHA_SECRET=1x0000000000000000000000000000000AA" > supabase/.env

npm run db:start                    # levanta Supabase (Docker). Imprime ANON_KEY / SERVICE_ROLE_KEY
# copiar esas claves a .env.local si difieren

npm run db:reset                    # aplica migraciones + seed (2 orgs, una api key de prueba c/u)

cp scripts/provision/users.example.json scripts/provision/users.json
PROVISION_PASSWORD='...' npm run provision -- apply   # crea orgs y usuarios del panel

npm run dev                         # http://localhost:3000
```

Studio de Supabase: http://127.0.0.1:54323 · Correos de las cuentas (acceso,
restablecer, cambio de email): los manda la app por Resend; sin `RESEND_API_KEY`
y `APPLICANT_EMAIL_FROM` en `.env.local` se imprimen en la consola de
`npm run dev`. Supabase Auth no manda correos (Mailpit en
http://127.0.0.1:54324 tiene que quedar vacío).

### Variables de entorno

Ver `.env.example`. Claves relevantes:

- `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`
- `NEXT_PUBLIC_APP_URL` — base para construir el `invitationUrl` y el callback de
  la búsqueda registral (`/api/webhooks/didit/kyb-search`). Para la validación de
  empresa (kyb_registry) debe ser **públicamente alcanzable**: en dev local usa un
  túnel (ngrok / cloudflared) o la búsqueda quedará en "Buscando…" hasta reintentar.
- `AML_PROVIDER` — `mock` (local) | `didit` (prod)
- `DIDIT_API_URL`, `DIDIT_API_KEY`, `DIDIT_WEBHOOK_SECRET` — solo con `AML_PROVIDER=didit`

## Panel: accesos y cuentas

Dos logins para el mismo panel; cada uno acepta solo su rol:

- **`/login`**: usuarios de cada organización (ven solo lo de su org).
- **`/admin/login`**: administradores de la plataforma (ven y gestionan todas las orgs).

Las pantallas compartidas viven en `/auth/*`: recuperar contraseña (`forgot`),
links de los correos (`confirm`), contraseña nueva (`reset`), primer ingreso
(`welcome`), código 2FA (`mfa`) y cuenta suspendida (`suspended`). La cookie `kyb_portal` recuerda por qué login
entró cada uno, para mandarlo ahí al cerrar sesión o cuando vence.

**Página Usuarios** (`/admin/users`, solo admin):

- Crear cuentas: a la persona le llega por correo (Resend) una contraseña
  temporal que nadie más ve. Al entrar por primera vez elige la suya
  (`/auth/welcome`; la marca es `app_metadata.must_change_password`) y se le
  ofrece activar el 2FA. Mientras no entre, se le puede reenviar el acceso
  (contraseña nueva) o cancelarlo.
- Editar nombre, rol y organización; cambiar email o mandar el link para
  restablecer la contraseña. Ningún admin elige la contraseña de otro. A
  **otro admin** solo se le manda el link.
- **Temporal** (se dará de baja): a otro admin que ya entró se le puede mandar
  por correo una contraseña nueva ("Enviar contraseña por correo"); se le
  cierran las sesiones y al entrar elige la suya.
- Suspender y reactivar usuarios y organizaciones, eligiendo el admin de
  contacto cuyo email ve el suspendido en `/auth/suspended`.
  - Usuario suspendido: no entra al panel.
  - Organización suspendida: sus usuarios no entran, su API responde
    `403 organization_suspended` y sus formularios públicos (`/forms/<id>`) no
    toman solicitudes nuevas. Los `/f/<token>` en curso siguen andando.
- Para modificar hace falta que el admin tenga **2FA activado** (Seguridad); dar
  rol admin, cambiar email y reactivar a un admin vuelven a pedir su
  contraseña. Crear una cuenta no la pide; si es admin, sale una alerta a
  `ALERT_EMAIL_TO`.
- La base garantiza que nunca queden cero admins activos y que no se suspenda
  una org con admins (`0028_accounts.sql`).

El script `npm run provision` sigue sirviendo para el alta inicial en local
(en remoto los usuarios nuevos se crean desde el panel) y para
`disable <email> --contact <admin>`, `enable`, `reset-mfa` (quitar el 2FA de
alguien, que el panel no hace) y `recovery-link`.

## API

Crear solicitud:

```bash
curl -X POST http://localhost:3000/api/v1/kyb/requests \
  -H "Authorization: Bearer kyb_test_key_local_dev" \
  -H "Content-Type: application/json" \
  -d '{"external_ref":"emp-123"}'
```

Body opcional: `ttl_hours`, `form_id` (UUID del formulario publicado a usar),
`callback_url` (webhook server-to-server, ver abajo) y `return_url` (a dónde
redirigir el navegador del usuario tras enviar, ver "Reanudación y redirect").

Consultar estado:

```bash
curl http://localhost:3000/api/v1/kyb/requests/<id> \
  -H "Authorization: Bearer kyb_test_key_local_dev"
```

### Endpoints del cliente (todos con `Authorization: Bearer <key>`, aislados por key)

| Método | Ruta | Qué devuelve |
|---|---|---|
| `POST` | `/api/v1/kyb/requests` | Crea la solicitud → `{ id, invitationUrl, token, expiresAt }` |
| `GET` | `/api/v1/kyb/requests` | **Lista** sus solicitudes. Query: `status`, `external_ref`, `limit` (máx 100), `offset` → `{ data, limit, offset, total }` |
| `GET` | `/api/v1/kyb/requests/:id` | Estado + decisión + `aml[]` |
| `GET` | `/api/v1/kyb/requests/:id/answers` | Respuestas mapeadas a etiquetas (`?locale=`); file/selfie con URLs firmadas |
| `GET` | `/api/v1/kyb/requests/:id/documents` | Documentos con URLs firmadas (`?expires_in=`, seg) |
| `GET` | `/api/v1/kyb/requests/:id/draft` | Avance del borrador: `{ filled, total, percent, fields[] }` |
| `POST` | `/api/v1/kyb/requests/:id/invitation` | Re-emite el link (mismo borrador) si se perdió/expiró → nuevo `invitationUrl` |

> La API key de prueba (`kyb_test_key_local_dev`) se siembra en `supabase/seed.sql`.
> En producción se gestionan desde el panel **Clientes API** (`/admin/clients`):
> emitir (se muestra el texto una sola vez), rotar, revocar, fijar rate limit y ver uso.

### Aislamiento por cliente

Cada solicitud queda ligada a la API key que la creó (`kyb_requests.api_key_id`).
El `GET /:id` solo devuelve solicitudes de **esa** key (404 si no es suya). Los
intakes públicos (`/forms/[id]`) no tienen dueño y no son accesibles por la API.

### Rate limiting

Por API key. Límite configurable por key (panel) o el default global
`API_RATE_LIMIT_DEFAULT_PER_MIN` (60). Al exceder: `429 {"error":"rate_limited"}`
con headers `Retry-After`, `X-RateLimit-Limit`, `X-RateLimit-Remaining`.

### Webhook saliente (push de resultados)

El cliente **registra sus endpoints** en el panel (`/admin/clients/<id>/webhooks`):
solo `https`, puerto 443, y se **rechazan IPs privadas/loopback/link-local**
(anti-SSRF). Cada endpoint tiene su **propio secreto** (cifrado en reposo,
mostrado en claro una sola vez). Al crear la solicitud se pasa
`webhook_endpoint_id` (no una URL arbitraria).

Se hace `POST` al endpoint cuando:
- `verification.completed` — terminan las verificaciones DIDIT/AML (`under_review`).
- `decision.made` — el analista aprueba/rechaza.

Body = shape del `GET` + `event` + `event_id` + `sent_at`. Headers:
`x-kyb-timestamp`, `x-kyb-event-id`, `x-kyb-delivery-id`, y
`x-kyb-signature: v1=<hex>` donde `<hex> = HMAC-SHA256(secret, timestamp + "." + rawBody)`.

**Verificación del receptor**: recomputar la firma (comparación en tiempo
constante), **rechazar timestamps > 5 min** (anti-replay), **deduplicar por
`event_id`** y procesar de forma **idempotente**. No se siguen redirects; timeout
corto; hasta 3 reintentos; el polling del `GET` es el respaldo. Entregas en
`audit_log` (`webhook_delivered` / `webhook_failed`).

### Reanudación y redirect

- **Reanudar a medias**: el formulario autosalva el borrador. Si el usuario se sale
  y **el cliente lo manda de vuelta al mismo `invitationUrl`** (mientras la solicitud
  esté `created`/`in_progress`), se **restauran los datos** llenados. El token dura 14
  días (`ttl_hours` configurable). Si se perdió o expiró, `POST /:id/invitation`
  genera un link nuevo conservando el borrador.
- **Redirect al terminar**: si al crear se pasó `return_url`, al enviar el formulario
  el navegador del usuario se redirige a esa URL (botón + auto-redirect). Es distinto
  de `callback_url` (webhook server-to-server); `return_url` es el redirect del
  **navegador** del usuario final.

## Traducción con IA

El motor vive en `lib/i18n-ai/` y sirve a dos superficies. Proveedor configurable
(`TRANSLATE_PROVIDER=mock|openai`); `mock` pseudo-traduce sin llamar a nadie, así que
en local se puede probar todo el flujo sin gastar tokens.

### 1. Formularios (`/admin/forms/<id>/edit`)

Botón **Traducir** en la barra del builder: traduce los textos del formulario al locale
elegido, sección por sección, y los aplica **sobre el borrador** (no publica nada). Los
textos que puso la IA quedan marcados con un badge `auto`; al corregirlos a mano el badge
desaparece y un re-pase en modo "solo lo que falta" ya no los toca. La procedencia se
guarda en `definition.meta.i18n` (path → locale → `{source, model, at}`).

El indicador de cobertura (`EN 92% · 41 sin traducir`) importa porque `resolveText` cae al
locale por defecto en silencio: sin medirlo, un formulario a medio traducir se ve completo
y sale a producción con español filtrado. Al publicar se avisa si algún locale está incompleto.

Lo que la IA **nunca** ve, y por lo tanto no puede romper: `field.key`, `option.value`,
los `id` y `validation.pattern`. Solo se le mandan strings, y se aplican por path. Como
`visibleIf` compara contra `option.value` (no contra la etiqueta), traducir no afecta la
lógica de ramificación ni las respuestas ya guardadas.

**Calidad.** El glosario y las reglas de estilo viven en `lib/i18n-ai/glossary.json`,
derivados de los pares ES/EN escritos a mano en `lib/forms/presets/*.ts`. Esos mismos pares
son el set de evaluación:

```bash
TRANSLATE_PROVIDER=openai npm run i18n:eval          # todo el corpus (~118 pares)
TRANSLATE_PROVIDER=openai npm run i18n:eval -- --limit 30
```

Imprime coincidencia exacta/normalizada y los diffs. La coincidencia exacta no es el
objetivo (hay varias traducciones válidas): los diffs son lo que hay que leer. Corrélo
cada vez que toques el glosario.

### 2. Respuestas (opt-in por cliente)

Traduce el **texto libre** que escribió el solicitante (`short_text` / `long_text`); el
resto ya es bilingüe vía `option.label`. Se cachea en `answer_translations` por
`(solicitud, campo, locale, hash del origen)`: se paga una vez, y si el solicitante corrige
su respuesta el hash cambia y se re-traduce solo.

- **API**: `GET /api/v1/kyb/requests/:id/answers?locale=en&translate=1` agrega
  `valueTranslated` a cada respuesta (campo aditivo: sin `translate=1` la respuesta es
  idéntica a la histórica).
- **Panel**: en el detalle de la solicitud, *Ver en EN* muestra la traducción bajo cada
  valor. El original queda como valor principal: es el registro de lo que se declaró.

> **PII.** Esto manda datos del solicitante a un proveedor externo, así que es **opt-in por
> cliente** (`api_keys.allow_ai_translation`, apagado por defecto) y se activa en el panel
> **Clientes API**. El gate aplica también a la vista del analista: el consentimiento es
> sobre el dato, no sobre quién lo mira. Los intakes públicos (`/forms/[id]`) no tienen
> cliente dueño y quedan permitidos. Cada traducción se registra en `audit_log`
> (`answer_translation`). Antes de activarlo en producción hace falta resolver la parte
> legal (retención cero / términos enterprise / DPA con el proveedor).

## DIDIT (AML) — por definir

La integración está aislada en `lib/aml/` (`provider.ts`, `didit.ts`, `mock.ts`, `mapping.ts`).
Falta por confirmar con DIDIT: endpoints, credenciales, formato del webhook y qué campos
del formulario se envían (`lib/aml/mapping.ts`). El resultado asíncrono llega a
`POST /api/webhooks/didit` (firma HMAC-SHA256).

## Producción (resumen)

- `supabase link` + `supabase db push` a un proyecto Supabase Cloud.
- Deploy de la app en Vercel con las env vars de producción.
- `AML_PROVIDER=didit` + credenciales reales.

### Cuentas y logins (0028)

Antes del push que aplica `0028_accounts.sql`:

- En el SQL editor de producción, `select count(*) from auth.sessions;` tiene
  que andar como `postgres`. `session_alive()` (security definer) lo lee dentro
  de la RLS: si no tuviera permiso, el panel dejaría de ver datos.
- Los correos de las cuentas los manda la app por Resend, no Supabase
  (`lib/auth/accountMail.ts`). En Vercel: `NEXT_PUBLIC_APP_URL` (la URL real:
  sin ella, en producción no se mandan), `RESEND_API_KEY`,
  `APPLICANT_EMAIL_FROM` (dominio verificado en Resend) y, con captcha,
  `TURNSTILE_SECRET_KEY`.
- En el dashboard de Supabase: **Authentication → Emails**, apagar
  "Secure email change" (el link va solo a la dirección nueva) y la
  notificación "Password changed" (la manda la app). SMTP y plantillas de
  Supabase ya no hacen falta.
- **URL Configuration**: Site URL = `NEXT_PUBLIC_APP_URL` (higiene: los correos
  ya no lo usan).

Después del deploy:

- Un admin activa su 2FA en Seguridad (sin eso la página Usuarios es de solo
  lectura).
- Mandar un link de restablecer desde Usuarios con el captcha encendido: con
  service role GoTrue no lo pide (verificado en local).
