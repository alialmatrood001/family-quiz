import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "../../..");

test("httpsCallable exists only in the dedicated server transport adapter", async () => {
  const files = [
    "src/callable-client.js",
    "src/finalize-question-client.js",
    "src/admin-auth.js",
    "src/admin-player-actions-client.js",
    "src/question-control-client.js",
    "src/quiz-write-client.js",
    "src/server-api-client.js",
  ];
  const matches = [];
  for (const file of files) {
    const source = await readFile(path.join(root, file), "utf8");
    if (source.includes("httpsCallable")) matches.push(file);
  }
  assert.deepEqual(matches, ["src/server-api-client.js"]);
});

test("PWA has no service worker or API cache strategy, so API requests remain network-only", async () => {
  const [main, viteConfig, index, serverApiCore, publicFiles] = await Promise.all([
    readFile(path.join(root, "src/main.jsx"), "utf8"),
    readFile(path.join(root, "vite.config.js"), "utf8"),
    readFile(path.join(root, "index.html"), "utf8"),
    readFile(path.join(root, "src/server-api-core.js"), "utf8"),
    readdir(path.join(root, "public"), { recursive: true }),
  ]);
  const combined = `${main}\n${viteConfig}\n${index}`;
  assert.doesNotMatch(combined, /serviceWorker|registerSW|vite-plugin-pwa|workbox|caches\./);
  assert.doesNotMatch(combined, /Authorization.*cache|\/api\/.*cache/s);
  assert.equal(
    publicFiles.some((file) => /(^|[\\/])(service-worker|sw)\.js$/i.test(file)),
    false,
  );
  assert.match(serverApiCore, /cache:\s*["']no-store["']/);
});

test("server-only modules never import from src", async () => {
  const files = [
    "api/_lib/http.js",
    "api/_lib/server-runtime.js",
    "functions/server/firebase-admin.js",
    "functions/server/firebase-callable.js",
    "functions/server/operations.js",
  ];
  for (const file of files) {
    const source = await readFile(path.join(root, file), "utf8");
    assert.doesNotMatch(source, /from\s+["'][^"']*src|require\(["'][^"']*src/);
  }
});
