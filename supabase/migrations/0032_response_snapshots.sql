-- =============================================================
-- Historial de lo que declaró el solicitante
-- -------------------------------------------------------------
-- kyb_form_responses es UNA fila por solicitud y se pisa: la reescriben el
-- autosave, cada envío, cada ronda de correcciones y cada renovación aceptada.
-- Una vez que el solicitante corregía, lo que había enviado antes no quedaba
-- en ningún lado.
--
-- kyb_response_snapshots guarda una foto de las respuestas en cada momento que
-- cuenta como declaración:
--   submitted         cada envío: el primero y cada reenvío tras corregir.
--   renewal_accepted  las respuestas después de aceptar una renovación (0030).
--   backfill          lo que había al aplicar esta migración en las solicitudes
--                     ya enviadas. Si estaban en `changes_requested`, sin las
--                     preguntas marcadas (se borraban al pedir la corrección).
--
-- Append-only: un trigger rechaza UPDATE, DELETE y TRUNCATE. La FK a la
-- solicitud no tiene `on delete`: una solicitud con declaraciones no se borra.
-- =============================================================

create table if not exists public.kyb_response_snapshots (
  id            uuid primary key default gen_random_uuid(),
  request_id    uuid not null references public.kyb_requests(id),
  kind          text not null
                check (kind in ('submitted', 'renewal_accepted', 'backfill')),
  -- submitted: ronda de correcciones que responde (null = primer envío).
  -- renewal_accepted: ronda de la renovación. backfill: null.
  round         integer,
  data          jsonb not null,
  -- Revisión del formulario de la solicitud (kyb_requests.form_revision).
  form_revision integer,
  created_at    timestamptz not null default now()
);

create index if not exists kyb_response_snapshots_request_idx
  on public.kyb_response_snapshots (request_id, created_at);

-- -------------------------------------------------------------
-- Append-only
-- -------------------------------------------------------------
-- Genérica: la usan las tablas cuyo historial no se reescribe (también
-- audit_log, 0033).
create or replace function public.reject_append_only_change()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception '% es append-only: no admite %', tg_table_name, tg_op
    using errcode = 'check_violation';
  return null;
end;
$$;

revoke execute on function public.reject_append_only_change() from public;

drop trigger if exists kyb_response_snapshots_append_only on public.kyb_response_snapshots;
create trigger kyb_response_snapshots_append_only
  before update or delete on public.kyb_response_snapshots
  for each row execute function public.reject_append_only_change();

drop trigger if exists kyb_response_snapshots_no_truncate on public.kyb_response_snapshots;
create trigger kyb_response_snapshots_no_truncate
  before truncate on public.kyb_response_snapshots
  for each statement execute function public.reject_append_only_change();

-- -------------------------------------------------------------
-- RLS: lectura por la solicitud (patrón de 0025); escrituras por service-role.
-- -------------------------------------------------------------
alter table public.kyb_response_snapshots enable row level security;

drop policy if exists kyb_response_snapshots_select on public.kyb_response_snapshots;
create policy kyb_response_snapshots_select on public.kyb_response_snapshots
  for select to authenticated
  using (exists (select 1 from public.kyb_requests r where r.id = request_id));

grant all on public.kyb_response_snapshots to service_role;
grant select on public.kyb_response_snapshots to authenticated;

-- -------------------------------------------------------------
-- Backfill: lo que hay hoy en las solicitudes ya enviadas.
-- -------------------------------------------------------------
insert into public.kyb_response_snapshots (request_id, kind, data, form_revision)
select r.id, 'backfill', coalesce(fr.data, '{}'::jsonb), r.form_revision
from public.kyb_requests r
join public.kyb_form_responses fr on fr.request_id = r.id
where r.submitted_at is not null
  and not exists (
    select 1 from public.kyb_response_snapshots s
    where s.request_id = r.id and s.kind = 'backfill'
  );
