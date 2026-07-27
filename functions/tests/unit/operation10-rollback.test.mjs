import assert from "node:assert/strict";
import test from "node:test";
import {
  SERVER_OPERATIONS,
  createServerApiClient,
  resolveServerTransport,
} from "../../../src/server-api-core.js";

test("rollback is configuration-only and defaults safely to callable", async () => {
  assert.equal(resolveServerTransport(undefined), "callable");
  assert.equal(resolveServerTransport(""), "callable");
  assert.equal(resolveServerTransport("callable"), "callable");
  assert.equal(resolveServerTransport("vercel"), "vercel");
  assert.throws(() => resolveServerTransport("production-auto"), {
    code: "invalid-server-transport",
  });

  const expected = { status: "received", operationId: "same-contract" };
  const callable = createServerApiClient({
    transport: "callable",
    callableInvoker: async (operation) => ({ ...expected, operation }),
  });
  const vercel = createServerApiClient({
    transport: "vercel",
    auth: { currentUser: { getIdToken: async () => "local-test-token" } },
    fetchImpl: async (_url, options) => ({
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        data: { ...expected, operation: JSON.parse(options.body).action },
      }),
    }),
  });
  assert.deepEqual(
    await callable.submitAnswer({ roomId: "room" }),
    await vercel.submitAnswer({ roomId: "room" }),
  );
  assert.equal(Object.keys(SERVER_OPERATIONS).length, 15);
});
