import { test } from "node:test";
import assert from "node:assert/strict";
import { clearedFilters, requestsHref, withOrg } from "./requestsQuery.ts";

const ACME = "00000000-0000-4000-8000-000000000002";
const PEYO = "00000000-0000-4000-8000-000000000001";

test("requestsHref omite lo vacío y la página 1", () => {
  assert.equal(requestsHref({}), "/admin");
  assert.equal(requestsHref({ q: "", page: 1 }), "/admin");
  assert.equal(requestsHref({ status: "submitted", page: 2 }), "/admin?status=submitted&page=2");
});

test("requestsHref conserva la org junto con los demás filtros", () => {
  assert.equal(
    requestsHref({ org: ACME, q: "acme", from: "2026-09-01" }),
    `/admin?org=${ACME}&q=acme&from=2026-09-01`,
  );
});

test("withOrg cambia de pestaña, conserva búsqueda/estado/fechas y suelta formulario y página", () => {
  const current = {
    org: PEYO,
    q: "sa",
    status: "submitted",
    form: "form-de-peyo",
    from: "2026-09-01",
    to: "2026-09-30",
    page: 3,
  };
  assert.equal(
    withOrg(current, ACME),
    `/admin?org=${ACME}&q=sa&status=submitted&from=2026-09-01&to=2026-09-30`,
  );
  // "Todas" = sin org.
  assert.equal(withOrg(current, ""), "/admin?q=sa&status=submitted&from=2026-09-01&to=2026-09-30");
});

test("el país va en la URL y sobrevive al cambio de pestaña", () => {
  assert.equal(
    requestsHref({ status: "submitted", country: "BO", from: "2026-09-01" }),
    "/admin?status=submitted&country=BO&from=2026-09-01",
  );
  assert.equal(withOrg({ country: "BO", form: "f", page: 2 }, ACME), `/admin?org=${ACME}&country=BO`);
  assert.equal(clearedFilters({ org: ACME, country: "BO" }), `/admin?org=${ACME}`);
});

test("clearedFilters limpia los filtros pero no sale de la pestaña", () => {
  assert.equal(clearedFilters({ org: ACME, q: "x", status: "approved", page: 4 }), `/admin?org=${ACME}`);
  assert.equal(clearedFilters({ q: "x" }), "/admin");
});
