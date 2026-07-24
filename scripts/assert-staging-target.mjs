import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const PLACEHOLDER_PATTERN = /(replace|placeholder|example|current_existing)/i;

export function readKnownProductionProject(cwd = process.cwd()) {
  const file = path.join(cwd, ".firebaserc");
  if (!fs.existsSync(file)) return null;
  const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  return parsed?.projects?.default || null;
}

export function assertStagingTarget({
  projectId,
  confirmation,
  productionProjectId,
  allowlist = [],
  credentialsPath,
}) {
  if (!projectId || PLACEHOLDER_PATTERN.test(projectId)) {
    throw new Error("A real staging project ID is required; placeholders are rejected");
  }
  if (projectId === productionProjectId) {
    throw new Error("The known production project is forbidden");
  }
  if (credentialsPath) {
    throw new Error("Service-account credentials are forbidden");
  }
  const explicitlyAllowed = allowlist.includes(projectId);
  if (!projectId.toLowerCase().includes("staging") && !explicitlyAllowed) {
    throw new Error("Project ID must contain staging or appear in STAGING_PROJECT_ALLOWLIST");
  }
  if (confirmation !== projectId) {
    throw new Error("CONFIRM_STAGING_PROJECT must exactly match the target project");
  }
  return { projectId, productionProjectId };
}

export function targetFromProcess() {
  const projectFlag = process.argv.indexOf("--project");
  const projectId =
    projectFlag >= 0 ? process.argv[projectFlag + 1] : process.env.FIREBASE_PROJECT_ID;
  return {
    projectId,
    confirmation: process.env.CONFIRM_STAGING_PROJECT,
    productionProjectId: readKnownProductionProject(),
    allowlist: String(process.env.STAGING_PROJECT_ALLOWLIST || "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean),
    credentialsPath: process.env.GOOGLE_APPLICATION_CREDENTIALS,
  };
}

const isMain =
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isMain) {
  try {
    const result = assertStagingTarget(targetFromProcess());
    console.log(`Staging target approved: ${result.projectId}`);
  } catch (error) {
    console.error(`Staging target rejected: ${error.message}`);
    process.exitCode = 2;
  }
}
