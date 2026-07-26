import assert from "node:assert/strict";
import test from "node:test";
import healthHandler from "../../../api/health.js";
import "../helpers/emulator.mjs";

test("Vercel health smoke check is safe on the emulator profile", async () => {
  const response = {
    body: null,
    statusCode: 200,
    setHeader() {},
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
    end() {
      return this;
    },
  };
  await healthHandler(
    {
      method: "GET",
      headers: { origin: "http://127.0.0.1:5173" },
    },
    response
  );
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.ok, true);
  assert.equal(response.body.data.status, "ok");
});
