import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";

const root = path.resolve(import.meta.dirname, "..");
const rootRequire = createRequire(path.join(root, "package.json"));
const requiredModules = [
  "@google-cloud/firestore",
  "firebase-admin/app",
  "firebase-admin/auth",
  "firebase-admin/database",
  "firebase-admin/firestore",
  "firebase-functions",
  "firebase-functions/v2/https",
  "google-auth-library",
];

for (const moduleName of requiredModules) {
  const resolved = rootRequire.resolve(moduleName);
  assert.ok(
    resolved.startsWith(path.join(root, "node_modules") + path.sep),
    `${moduleName} must resolve from the root node_modules used by Vercel`,
  );
  console.log(`${moduleName}: root dependency resolved`);
}

const rootPackage = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const functionsPackage = JSON.parse(
  await readFile(path.join(root, "functions", "package.json"), "utf8"),
);
assert.equal(rootPackage.engines?.node, "24.x", "Vercel runtime must be pinned to Node 24.x");
assert.equal(functionsPackage.engines?.node, "24", "Callable runtime must remain on Node 24");
for (const dependency of [
  "@google-cloud/firestore",
  "firebase-admin",
  "firebase-functions",
  "google-auth-library",
]) {
  assert.equal(
    rootPackage.dependencies?.[dependency],
    functionsPackage.dependencies?.[dependency],
    `${dependency} must use the same declared range at the root and in functions`,
  );
}

const forbiddenEnvironmentPrefixes = [
  "FIREBASE_",
  "FIRESTORE_",
  "GCLOUD_",
  "GOOGLE_",
  "GCP_",
  "VERCEL_",
];
const cleanEnvironment = Object.fromEntries(
  Object.entries(process.env).filter(
    ([name]) => !forbiddenEnvironmentPrefixes.some((prefix) => name.startsWith(prefix)),
  ),
);
delete cleanEnvironment.APP_ENVIRONMENT;
delete cleanEnvironment.FUNCTIONS_EMULATOR;
delete cleanEnvironment.FUNCTION_TARGET;
delete cleanEnvironment.K_SERVICE;

await new Promise((resolve, reject) => {
  const child = spawn(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      'await import("./api/_lib/server-runtime.js"); console.log("server runtime import: ok");',
    ],
    {
      cwd: root,
      env: cleanEnvironment,
      stdio: "inherit",
    },
  );
  child.once("error", reject);
  child.once("exit", (code, signal) => {
    if (signal) reject(new Error(`Runtime import exited after signal ${signal}`));
    else if (code !== 0) reject(new Error(`Runtime import exited with code ${code}`));
    else resolve();
  });
});

console.log("Vercel runtime dependency check passed without initializing Firebase Admin");
