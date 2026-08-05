import assert from "node:assert/strict";
import test from "node:test";
import {
  adminFirestoreListenersReady,
  confirmFirestoreDocumentReadable,
  startFirestoreListener,
} from "../../../src/firestore-read-boundary.js";

test("admin listeners wait for Auth readiness and the admin custom claim", () => {
  assert.equal(adminFirestoreListenersReady(undefined), false);
  assert.equal(adminFirestoreListenersReady({ loading: true }), false);
  assert.equal(
    adminFirestoreListenersReady({ loading: false, user: { uid: "admin" }, isAdmin: false }),
    false,
  );
  assert.equal(
    adminFirestoreListenersReady({ loading: false, user: { uid: "admin" }, isAdmin: true }),
    true,
  );
});

test("a disabled listener never subscribes", () => {
  let subscriptions = 0;
  const unsubscribe = startFirestoreListener({
    enabled: false,
    path: "rooms/test",
    subscribe() {
      subscriptions += 1;
    },
  });
  unsubscribe();
  assert.equal(subscriptions, 0);
});

test("permission-denied reaches visible state through the snapshot error callback", () => {
  let captured;
  const unsubscribe = startFirestoreListener({
    path: "rooms/test/questions",
    subscribe(_next, error) {
      error({ code: "permission-denied", message: "sensitive emulator detail" });
      return () => {};
    },
    onData() {},
    onError(failure) {
      captured = failure;
    },
  });
  unsubscribe();
  assert.equal(captured.code, "permission-denied");
  assert.equal(captured.path, "rooms/test/questions");
  assert.match(captured.message, /Firestore.*Staging/);
  assert.doesNotMatch(captured.message, /sensitive emulator detail/);
});

test("room confirmation succeeds only after a readable document exists", async () => {
  const snapshot = { exists: () => true };
  assert.equal(
    await confirmFirestoreDocumentReadable({
      path: "rooms/test",
      read: async () => snapshot,
    }),
    snapshot,
  );
  await assert.rejects(
    confirmFirestoreDocumentReadable({
      path: "rooms/test",
      read: async () => {
        throw { code: "permission-denied" };
      },
    }),
    (error) => error.code === "permission-denied" && /Staging/.test(error.message),
  );
});
