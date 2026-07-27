import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { createConnection } from "node:net";
import path from "node:path";

const DEMO_PROJECT_ID = "demo-family-quiz";
const EMULATOR_PORTS = Object.freeze([5001, 8080, 9000, 9099]);
const READY_TIMEOUT_MS = 30_000;
const MODES = Object.freeze({
  security: [
    "functions/tests/unit/operation10-security.test.mjs",
    "functions/tests/unit/client-boundaries.test.mjs",
    "functions/tests/integration/operation10-security.test.mjs",
  ],
  parity: ["functions/tests/integration/operation10-parity.test.mjs"],
  load: ["functions/tests/integration/operation10-load.test.mjs"],
  rollback: [
    "functions/tests/unit/server-api-core.test.mjs",
    "functions/tests/unit/operation10-rollback.test.mjs",
  ],
});

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit", ...options });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) reject(new Error(`${command} exited after signal ${signal}`));
      else resolve(code ?? 1);
    });
  });
}

async function firebaseInvocation() {
  if (process.platform !== "win32") return { command: "firebase", leadingArgs: [] };
  const firebaseCli = path.join(
    process.env.APPDATA || "",
    "npm",
    "node_modules",
    "firebase-tools",
    "lib",
    "bin",
    "firebase.js",
  );
  await access(firebaseCli);
  return { command: process.execPath, leadingArgs: [firebaseCli] };
}

function canConnect(port) {
  return new Promise((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    socket.setTimeout(1_000);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    const unavailable = () => {
      socket.destroy();
      resolve(false);
    };
    socket.once("error", unavailable);
    socket.once("timeout", unavailable);
  });
}

function assertSafeEnvironment() {
  const projectId = process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT;
  if (
    projectId !== DEMO_PROJECT_ID ||
    process.env.FIREBASE_AUTH_EMULATOR_HOST !== "127.0.0.1:9099" ||
    process.env.FIRESTORE_EMULATOR_HOST !== "127.0.0.1:8080" ||
    process.env.FIREBASE_DATABASE_EMULATOR_HOST !== "127.0.0.1:9000" ||
    process.env.GOOGLE_APPLICATION_CREDENTIALS
  ) {
    throw new Error("Operation 10 is restricted to the credential-free demo emulator profile.");
  }
}

async function waitForEmulators() {
  assertSafeEnvironment();
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if ((await Promise.all(EMULATOR_PORTS.map(canConnect))).every(Boolean)) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error("Firebase Emulator Suite did not become ready within 30 seconds.");
}

async function main() {
  const requested = process.argv.find((argument) => argument.startsWith("--mode="))?.slice(7) || "all";
  const selectedModes = requested === "all" ? Object.keys(MODES) : requested === "core"
    ? ["security", "parity", "rollback"]
    : [requested];
  if (selectedModes.some((mode) => !MODES[mode])) {
    throw new Error(`Unknown Operation 10 mode: ${requested}`);
  }
  const files = [...new Set(selectedModes.flatMap((mode) => MODES[mode]))];

  if (process.argv.includes("--inside-emulators")) {
    await waitForEmulators();
    process.exitCode = await run(process.execPath, [
      "--test",
      "--test-concurrency=1",
      ...files,
    ]);
    return;
  }

  const firebase = await firebaseInvocation();
  const innerCommand = `node scripts/run-operation10.mjs --inside-emulators --mode=${requested}`;
  process.exitCode = await run(
    firebase.command,
    [
      ...firebase.leadingArgs,
      "emulators:exec",
      "--project",
      DEMO_PROJECT_ID,
      "--only",
      "auth,functions,firestore,database",
      innerCommand,
    ],
    { env: { ...process.env, FUNCTIONS_DISCOVERY_TIMEOUT: "60" } },
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
