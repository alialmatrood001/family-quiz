import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { runQuizInitialization } from "../../../src/quiz-initialization-flow.js";

const root = path.resolve(import.meta.dirname, "../../..");

test("quiz initialization flow exposes busy state and resolves on success", async () => {
  const busy = [];
  const errors = [];
  const successes = [];
  const result = await runQuizInitialization({
    execute: async () => ({ status: "created" }),
    setBusy: (value) => busy.push(value),
    setError: (value) => errors.push(value),
    onSuccess: (value) => successes.push(value),
  });
  assert.deepEqual(result, { ok: true, result: { status: "created" } });
  assert.deepEqual(busy, [true, false]);
  assert.deepEqual(errors, [""]);
  assert.deepEqual(successes, [{ status: "created" }]);
});

test("server failure becomes visible state without an unhandled rejection", async () => {
  const busy = [];
  const errors = [];
  const failure = new Error("Admin permission is required");
  const result = await runQuizInitialization({
    execute: async () => {
      throw failure;
    },
    setBusy: (value) => busy.push(value),
    setError: (value) => errors.push(value),
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, failure);
  assert.deepEqual(busy, [true, false]);
  assert.deepEqual(errors, ["", "Admin permission is required"]);
});

test("post-initialization room confirmation is awaited and failures remain handled", async () => {
  const busy = [];
  const errors = [];
  let navigationAttempted = false;
  const result = await runQuizInitialization({
    execute: async () => ({ status: "created" }),
    setBusy: (value) => busy.push(value),
    setError: (value) => errors.push(value),
    onSuccess: async () => {
      navigationAttempted = true;
      throw new Error("Firestore read permission is missing");
    },
  });
  assert.equal(navigationAttempted, true);
  assert.equal(result.ok, false);
  assert.deepEqual(busy, [true, false]);
  assert.deepEqual(errors, ["", "Firestore read permission is missing"]);
});

test("create competition no longer writes to Firestore from the browser", async () => {
  const source = await readFile(path.join(root, "src", "App.jsx"), "utf8");
  const start = source.indexOf("async function createOrResetRoom()");
  const end = source.indexOf("\n}", start) + 2;
  assert.ok(start >= 0 && end > start);
  const implementation = source.slice(start, end);
  assert.match(implementation, /initializeQuizSecurely\(\{ roomId: ROOM_ID \}\)/);
  assert.doesNotMatch(implementation, /setDoc|updateDoc|addDoc|runTransaction/);
  assert.match(source, /disabled=\{roomCreationBusy\}/);
  assert.match(source, /جاري إنشاء المسابقة/);
  assert.match(source, /roomCreationError/);
  assert.match(source, /confirmFirestoreDocumentReadable/);
  assert.match(source, /window\.location\.assign\("\/\?view=control"\)/);
});
