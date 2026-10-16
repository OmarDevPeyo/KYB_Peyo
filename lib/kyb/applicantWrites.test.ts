import { test } from "node:test";
import assert from "node:assert/strict";
import { acceptsApplicantWrites, canApplicantDeleteDocument } from "./applicantWrites.ts";

test("el link escribe solo mientras la solicitud espera al solicitante", () => {
  assert.equal(acceptsApplicantWrites("created"), true);
  assert.equal(acceptsApplicantWrites("in_progress"), true);
  assert.equal(acceptsApplicantWrites("changes_requested"), true);
});

test("enviada, en revisión, decidida o vencida, el link no escribe", () => {
  for (const status of ["submitted", "under_review", "approved", "rejected", "expired"] as const) {
    assert.equal(acceptsApplicantWrites(status), false, status);
  }
});

test("sin ningún envío, cualquier archivo se puede quitar", () => {
  assert.equal(
    canApplicantDeleteDocument({ submittedAt: null, uploadedAt: "2026-10-01T10:00:00Z" }),
    true,
  );
});

test("lo que formó parte de un envío se conserva", () => {
  assert.equal(
    canApplicantDeleteDocument({
      submittedAt: "2026-10-02T10:00:00Z",
      uploadedAt: "2026-10-01T10:00:00Z",
    }),
    false,
  );
  // Subido en el mismo instante que el envío: cuenta como enviado.
  assert.equal(
    canApplicantDeleteDocument({
      submittedAt: "2026-10-02T10:00:00Z",
      uploadedAt: "2026-10-02T10:00:00Z",
    }),
    false,
  );
});

test("en una corrección se puede quitar lo subido en esa ronda", () => {
  assert.equal(
    canApplicantDeleteDocument({
      submittedAt: "2026-10-02T10:00:00Z",
      uploadedAt: "2026-10-03T09:00:00Z",
    }),
    true,
  );
});

test("una subida sin fila (nunca confirmada) no es evidencia", () => {
  assert.equal(
    canApplicantDeleteDocument({ submittedAt: "2026-10-02T10:00:00Z", uploadedAt: null }),
    true,
  );
});
