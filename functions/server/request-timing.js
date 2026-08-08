"use strict";

const { AsyncLocalStorage } = require("node:async_hooks");

const TIMING_FIELDS = Object.freeze([
  "requestTotalMs",
  "verifyFirebaseTokenMs",
  "resolveVercelOidcMs",
  "wifCredentialMs",
  "firestoreReadyMs",
  "firestoreOperationMs",
  "cleanupMs",
]);

const timingStorage = new AsyncLocalStorage();

function monotonicNow() {
  return globalThis.performance?.now?.() ?? Date.now();
}

function runWithServerTimings(callback, { now = monotonicNow } = {}) {
  return timingStorage.run(
    { startedAt: now(), now, values: Object.create(null) },
    callback,
  );
}

function recordServerTiming(name, durationMs) {
  const store = timingStorage.getStore();
  if (!store || !TIMING_FIELDS.includes(name)) return;
  const safeDuration = Math.max(0, Number(durationMs) || 0);
  store.values[name] = Number(store.values[name] || 0) + safeDuration;
}

function measureServerTiming(name, callback) {
  const store = timingStorage.getStore();
  if (!store) return callback();
  const startedAt = store.now();
  let result;
  try {
    result = callback();
  } catch (error) {
    recordServerTiming(name, store.now() - startedAt);
    throw error;
  }
  if (result && typeof result.then === "function") {
    return result.finally(() => recordServerTiming(name, store.now() - startedAt));
  }
  recordServerTiming(name, store.now() - startedAt);
  return result;
}

function serverTimingSnapshot() {
  const store = timingStorage.getStore();
  if (!store) {
    return Object.freeze(Object.fromEntries(TIMING_FIELDS.map((name) => [name, 0])));
  }
  store.values.requestTotalMs = Math.max(0, store.now() - store.startedAt);
  return Object.freeze(
    Object.fromEntries(
      TIMING_FIELDS.map((name) => [name, Number(Number(store.values[name] || 0).toFixed(2))]),
    ),
  );
}

function serverTimingHeader(snapshot = serverTimingSnapshot()) {
  return TIMING_FIELDS.map((name) => `${name};dur=${Number(snapshot[name] || 0).toFixed(2)}`).join(", ");
}

module.exports = {
  TIMING_FIELDS,
  measureServerTiming,
  recordServerTiming,
  runWithServerTimings,
  serverTimingHeader,
  serverTimingSnapshot,
};
