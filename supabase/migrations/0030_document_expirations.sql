-- =============================================================
-- Vencimiento de documentos y renovación
-- -------------------------------------------------------------
-- En el builder, una pregunta de archivo puede marcarse para controlar su
-- vencimiento (`field.expiry`, ver lib/forms/expiry.ts). La fecha sale del
-- resultado de DIDIT id_verification o de una pregunta de fecha del mismo
-- formulario, y el analista puede corregirla.
--
-- document_expirations: una fila por solicitud y documento controlado. La
--   escribe la app (lib/kyb/expirations.ts) al enviar, al verificar y al
--   cambiar la marca del formulario (eso hace de backfill). El estado
--   (vencido / por vencer / vigente) NO se guarda: se calcula contra hoy.
-- document_renewals: rondas de renovación sobre una solicitud APROBADA. El
--   link tiene su propio token (no toca invitation_token_hash ni
--   token_expires_at, que la API expone) y lo que sube el solicitante queda
--   retenido acá hasta que el analista acepta. La solicitud no cambia de estado.
-- organizations.logo_*: logo de la organización para el correo de renovación.
-- =============================================================

alter table public.organizations
  add column if not exists logo_url  text,
  add column if not exists logo_path text;

comment on column public.organizations.logo_url is
  'URL pública del logo (bucket form-assets) que encabeza el correo de renovación.';

create table if not exists public.document_expirations (
  id                  uuid primary key default gen_random_uuid(),
  request_id          uuid not null references public.kyb_requests(id) on delete cascade,
  -- La pregunta por id (estable en el builder) y por key (la de la respuesta y
  -- la de aml_checks.field_key).
  field_id            text not null,
  field_key           text not null,
  field_label         jsonb,
  marker_source       text not null check (marker_source in ('didit', 'date_field')),
  -- Origen efectivo de `expires_on`: la corrección del analista gana.
  source              text not null check (source in ('didit', 'declared', 'analyst')),
  auto_expires_on     date,
  expires_on          date,
  override_expires_on date,
  override_by         uuid,
  override_by_email   text,
  override_at         timestamptz,
  -- Documento al que corresponde la fecha: si cambia, la corrección se descarta.
  doc_path            text,
  doc_filename        text,
  check_id            uuid references public.aml_checks(id) on delete set null,
  -- Webhook `document.expired` ya encolado (una vez por documento y fecha).
  expired_notified_at timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint document_expirations_request_field_key unique (request_id, field_id)
);

-- Barrido diario de `document.expired`: solo mira lo que no se avisó.
create index if not exists document_expirations_due_idx
  on public.document_expirations (expires_on)
  where expired_notified_at is null;

create table if not exists public.document_renewals (
  id                 uuid primary key default gen_random_uuid(),
  request_id         uuid not null references public.kyb_requests(id) on delete cascade,
  round              integer not null,
  -- sending: correo en curso (el link aún no vale). requested: link vigente.
  -- submitted: el solicitante envió; espera revisión. accepted / rejected: revisada.
  -- cancelled: reemplazada o cancelada. failed: el correo no salió.
  state              text not null
                     check (state in ('sending', 'requested', 'submitted', 'accepted',
                                      'rejected', 'cancelled', 'failed')),
  -- Documentos pedidos: [{fieldId, fieldKey, label, expiresOn}].
  fields             jsonb not null default '[]',
  -- Keys de respuesta que el link puede escribir (archivo, reverso y fecha).
  keys               text[] not null default '{}',
  locale             text not null default 'es' check (locale in ('es', 'en')),
  email_to           text,
  email_note         text,
  email_message_id   text,
  email_sent_at      timestamptz,
  email_error        text,
  token_hash         text unique,
  token_expires_at   timestamptz,
  -- Retenido hasta que el analista acepta: respuestas y resultados de DIDIT.
  answers            jsonb not null default '{}',
  checks             jsonb,
  requested_by       uuid,
  requested_by_email text,
  submitted_at       timestamptz,
  reviewed_by        uuid,
  reviewed_by_email  text,
  reviewed_at        timestamptz,
  review_note        text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  constraint document_renewals_round_key unique (request_id, round)
);

-- Una sola ronda abierta por solicitud.
create unique index if not exists document_renewals_one_open
  on public.document_renewals (request_id)
  where state in ('requested', 'submitted');

-- Archivos y checks de una renovación. Los anteriores nunca se borran.
alter table public.kyb_documents
  add column if not exists renewal_id uuid references public.document_renewals(id) on delete set null;
alter table public.aml_checks
  add column if not exists renewal_id uuid references public.document_renewals(id) on delete set null;

-- -------------------------------------------------------------
-- RLS: lectura por la solicitud (patrón de 0025); escrituras por service-role.
-- -------------------------------------------------------------
alter table public.document_expirations enable row level security;
alter table public.document_renewals    enable row level security;

drop policy if exists document_expirations_select on public.document_expirations;
create policy document_expirations_select on public.document_expirations
  for select to authenticated
  using (exists (select 1 from public.kyb_requests r where r.id = request_id));

drop policy if exists document_renewals_select on public.document_renewals;
create policy document_renewals_select on public.document_renewals
  for select to authenticated
  using (exists (select 1 from public.kyb_requests r where r.id = request_id));

grant all on public.document_expirations to service_role;
grant all on public.document_renewals    to service_role;
grant select on public.document_expirations to authenticated;

-- El hash del token no se expone: grant por columnas, sin `token_hash`. El
-- panel selecciona columnas explícitas (un `*` fallaría por permisos).
revoke all on public.document_renewals from anon, authenticated;
grant select (
  id, request_id, round, state, fields, keys, locale,
  email_to, email_note, email_message_id, email_sent_at, email_error,
  token_expires_at, answers, checks,
  requested_by, requested_by_email, submitted_at,
  reviewed_by, reviewed_by_email, reviewed_at, review_note,
  created_at, updated_at
) on public.document_renewals to authenticated;

-- -------------------------------------------------------------
-- Vista de la pantalla Vencimientos: un renglón por solicitud APROBADA con
-- documentos controlados. security_invoker: aplica la RLS de quien consulta.
-- -------------------------------------------------------------
create or replace view public.expiring_requests
with (security_invoker = true) as
select
  r.id            as request_id,
  r.org_id,
  r.external_ref,
  r.subject_title,
  r.contact_email,
  r.form_id,
  r.decided_at,
  min(d.expires_on)                                          as first_expires_on,
  count(*) filter (where d.expires_on < current_date)        as expired_count,
  min(d.expires_on) filter (where d.expires_on >= current_date) as next_expires_on,
  count(*) filter (where d.expires_on is null)               as unknown_count,
  count(*)                                                   as tracked_count,
  (select x.state from public.document_renewals x
    where x.request_id = r.id and x.state in ('requested', 'submitted')
    limit 1)                                                 as open_renewal_state,
  (select max(x.email_sent_at) from public.document_renewals x
    where x.request_id = r.id)                               as last_email_sent_at
from public.kyb_requests r
join public.document_expirations d on d.request_id = r.id
where r.status = 'approved'
group by r.id;

grant select on public.expiring_requests to authenticated, service_role;
