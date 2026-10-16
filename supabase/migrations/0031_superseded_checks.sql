-- =============================================================
-- Pedir correcciones ya no borra evidencia
-- -------------------------------------------------------------
-- `requestChanges` (lib/kyb/service.ts) borraba, de cada pregunta marcada, la
-- respuesta, el archivo de Storage, su fila en kyb_documents y sus
-- verificaciones (aml_checks), salvo kyb_registry. Lo que el solicitante envió
-- y lo que DIDIT devolvió desaparecían, también para el cliente que lee
-- /documents en vivo.
--
-- Ahora la respuesta sale del borrador (el solicitante la vuelve a responder),
-- pero el archivo queda en Storage y en kyb_documents, y la verificación queda
-- marcada como reemplazada en la ronda. Lo vigente se calcula al leer, como en
-- las renovaciones (0030): un archivo que ya no está en las respuestas es una
-- versión anterior; un check con `superseded_at` describe la respuesta de antes.
-- =============================================================

alter table public.aml_checks
  add column if not exists superseded_at    timestamptz,
  add column if not exists superseded_round integer;

comment on column public.aml_checks.superseded_at is
  'Cuándo una ronda de correcciones volvió a pedir la pregunta de este check. Null = vigente.';
comment on column public.aml_checks.superseded_round is
  'Ronda de correcciones (kyb_requests.corrections.round) que reemplazó este check.';
