import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { safeServerFailureDiagnostic } from "../../../api/_lib/http.js";

const require = createRequire(import.meta.url);
const { createSecureWriteHandlers } = require("../../secure-writes/handlers.js");

function diagnosticDatabase({ failCollection = null } = {}) {
  const collections = new Map([
    ["players", [{ ref: { collectionName: "players" } }]],
    ["playerPrivate", [{ ref: { collectionName: "playerPrivate" } }]],
    ["playerRegistrationKeys", [{ ref: { collectionName: "playerRegistrationKeys" } }]],
    ["visitors", []],
    ["answers", [{ ref: { collectionName: "answers" } }]],
    ["questionResults", [{ ref: { collectionName: "questionResults" } }]],
    ["messages", []],
  ]);
  const roomRef = {
    async get() { return { exists: true, data: () => ({ stage: "prizeWheel" }) }; },
    collection(name) {
      return {
        async get() { return { docs: collections.get(name) || [] }; },
        doc() { return { async create() {} }; },
      };
    },
  };
  return {
    doc(path) {
      assert.equal(path, "rooms/test-room");
      return roomRef;
    },
    batch() {
      const refs = [];
      return {
        delete(ref) { refs.push(ref); },
        async commit() {
          if (refs.some((ref) => ref.collectionName === failCollection)) {
            const error = new Error("unsafe raw Firestore detail");
            error.code = 16;
            throw error;
          }
          for (const ref of refs) {
            collections.set(
              ref.collectionName,
              (collections.get(ref.collectionName) || []).filter((document) => document.ref !== ref),
            );
          }
        },
      };
    },
  };
}

const adminRequest = {
  auth: { uid: "test-admin", token: { admin: true } },
  data: { roomId: "test-room", mode: "full", reason: "targeted reset test" },
};

test("reset failure reports the exact safe Firestore deletion step", async () => {
  const handlers = createSecureWriteHandlers({ db: diagnosticDatabase({ failCollection: "players" }) });
  await assert.rejects(
    handlers.resetQuizData(adminRequest),
    (error) => {
      assert.equal(error.failedStep, "delete-players");
      assert.equal(error.firestoreCode, "16");
      assert.ok(Number.isFinite(error.elapsedMs));
      return true;
    },
  );
});

test("empty and partially deleted collections remain idempotent", async () => {
  const handlers = createSecureWriteHandlers({ db: diagnosticDatabase() });
  const first = await handlers.resetQuizData(adminRequest);
  const retry = await handlers.resetQuizData(adminRequest);
  assert.equal(first.status, "reset");
  assert.equal(first.deletedCount, 5);
  assert.equal(retry.status, "reset");
  assert.equal(retry.deletedCount, 0);
});

test("HTTP diagnostics retain only safe reset metadata", () => {
  const diagnostic = safeServerFailureDiagnostic({
    failedStep: "delete-players",
    firestoreCode: "16",
    elapsedMs: 321.4,
    message: "private document contents",
  }, { code: "internal", status: 500 });
  assert.equal(diagnostic.failedStep, "delete-players");
  assert.equal(diagnostic.firestoreCode, "16");
  assert.equal(diagnostic.elapsedMs, 321);
  assert.equal(JSON.stringify(diagnostic).includes("private document contents"), false);
});
