import { spawn } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const STAGING_LABEL = "STAGING — بيانات تجريبية";
const SERVER_ONLY_MARKERS = [
  "FIREBASE_ADMIN_PRIVATE_KEY",
  "FIREBASE_ADMIN_CLIENT_EMAIL",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "GCP_PROJECT_NUMBER",
  "GCP_WORKLOAD_IDENTITY_POOL_ID",
  "GCP_WORKLOAD_IDENTITY_PROVIDER_ID",
  "GCP_SERVICE_ACCOUNT_EMAIL",
  "VERCEL_OIDC_TOKEN",
  "BEGIN PRIVATE KEY",
  "firebase-admin",
  "firebase-functions",
  "google-auth-library",
];

function runBuild(mode) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["scripts/build-environment.mjs", mode], {
      cwd: process.cwd(),
      env: process.env,
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) reject(new Error(`${mode} build exited after signal ${signal}`));
      else if (code !== 0) reject(new Error(`${mode} build failed with exit code ${code}`));
      else resolve();
    });
  });
}

async function bundledText(directory) {
  const entries = await readdir(directory, { recursive: true, withFileTypes: true });
  const files = entries
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(entry.parentPath, entry.name));
  return (await Promise.all(files.map((file) => readFile(file, "utf8").catch(() => "")))).join("\n");
}

for (const mode of ["staging", "callable", "vercel"]) {
  await runBuild(mode);
  const output = await bundledText(path.join(process.cwd(), "dist"));
  for (const marker of SERVER_ONLY_MARKERS) {
    if (output.includes(marker)) {
      throw new Error(`${mode} client bundle contains server-only material: ${marker}`);
    }
  }
  const containsBanner = output.includes(STAGING_LABEL);
  if (mode === "staging" && !containsBanner) {
    throw new Error("Staging build does not contain the required visual banner");
  }
  if (mode !== "staging" && containsBanner) {
    throw new Error(`${mode} build unexpectedly contains the staging banner`);
  }
  console.log(`operation11 build ${mode}: banner=${containsBanner ? "present" : "absent"}`);
}
