import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("all Staging Vercel server functions target Mumbai bom1", async () => {
  const config = JSON.parse(await readFile(new URL("../../../vercel.json", import.meta.url), "utf8"));
  assert.deepEqual(config.regions, ["bom1"]);
  assert.equal(JSON.stringify(config.functions).includes("iad1"), false);
  assert.equal(config.functions["api/*.js"].maxDuration, 60);
});
