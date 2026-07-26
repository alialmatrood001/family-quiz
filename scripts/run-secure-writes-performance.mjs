import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { createConnection } from "node:net";
import path from "node:path";

const DEMO_PROJECT_ID = "demo-family-quiz";
const DISCOVERY_TIMEOUT_SECONDS = "60";
const EMULATOR_PORTS = Object.freeze([5001, 8080, 9000, 9099]);
const READY_TIMEOUT_MS = 30_000;

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: "inherit",
      ...options,
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) {
        reject(new Error(`${command} exited after signal ${signal}`));
        return;
      }
      resolve(code ?? 1);
    });
  });
}

async function firebaseInvocation() {
  if (process.platform !== "win32") {
    return { command: "firebase", leadingArgs: [] };
  }
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

async function waitForEmulators() {
  if (
    process.env.GCLOUD_PROJECT !== DEMO_PROJECT_ID ||
    process.env.FIREBASE_AUTH_EMULATOR_HOST !== "127.0.0.1:9099" ||
    process.env.FIRESTORE_EMULATOR_HOST !== "127.0.0.1:8080" ||
    process.env.FIREBASE_DATABASE_EMULATOR_HOST !== "127.0.0.1:9000"
  ) {
    throw new Error("Refusing to run performance tests outside the demo emulator profile.");
  }

  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const ready = await Promise.all(EMULATOR_PORTS.map(canConnect));
    if (ready.every(Boolean)) {
      console.log("Firebase Emulator Suite readiness check passed.");
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error("Firebase Emulator Suite did not become ready within 30 seconds.");
}

async function main() {
  if (process.argv.includes("--inside-emulators")) {
    await waitForEmulators();
    process.exitCode = await run(
      process.execPath,
      [
        "--test",
        "--test-concurrency=1",
        "functions/tests/integration/secure-writes-performance.test.mjs",
      ],
    );
    return;
  }

  const firebase = await firebaseInvocation();
  const innerCommand =
    "node scripts/run-secure-writes-performance.mjs --inside-emulators";
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
    {
      env: {
        ...process.env,
        FUNCTIONS_DISCOVERY_TIMEOUT: DISCOVERY_TIMEOUT_SECONDS,
      },
    },
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
