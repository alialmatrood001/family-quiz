import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import process from "node:process";
import { assertStagingTarget } from "./assert-staging-target.mjs";

export function stagingFirestoreDeployment(cwd = process.cwd(), env = process.env) {
  const rc = JSON.parse(fs.readFileSync(path.join(cwd, ".firebaserc"), "utf8"));
  const firebaseConfig = JSON.parse(
    fs.readFileSync(path.join(cwd, "firebase.json"), "utf8"),
  );
  const projectId = String(rc?.projects?.staging || "").trim();
  const productionProjectId = String(rc?.projects?.default || "").trim();
  assertStagingTarget({
    projectId,
    confirmation: env.CONFIRM_STAGING_PROJECT,
    productionProjectId,
    credentialsPath: env.GOOGLE_APPLICATION_CREDENTIALS,
  });
  if (projectId !== "family-quiz-staging") {
    throw new Error("The staging alias must resolve exactly to family-quiz-staging");
  }
  if (
    firebaseConfig?.firestore?.rules !== "firestore.rules" ||
    firebaseConfig?.firestore?.indexes !== "firestore.indexes.json"
  ) {
    throw new Error("firebase.json must target the reviewed Firestore rules and indexes");
  }
  return Object.freeze({
    projectId,
    command: process.platform === "win32" ? "firebase.cmd" : "firebase",
    args: Object.freeze([
      "deploy",
      "--only",
      "firestore:rules,firestore:indexes",
      "--project",
      "staging",
    ]),
  });
}

async function executeDeployment(deployment) {
  await new Promise((resolve, reject) => {
    const child = spawn(deployment.command, deployment.args, {
      cwd: process.cwd(),
      env: process.env,
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) reject(new Error(`Firebase CLI exited after signal ${signal}`));
      else if (code !== 0) reject(new Error(`Firebase CLI exited with code ${code}`));
      else resolve();
    });
  });
}

const isMain =
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isMain) {
  const deployment = stagingFirestoreDeployment();
  if (!process.argv.includes("--execute")) {
    throw new Error("Explicit --execute is required for the Staging Firestore deployment");
  }
  console.log(`Deploying reviewed Firestore rules and indexes to ${deployment.projectId}`);
  await executeDeployment(deployment);
}
