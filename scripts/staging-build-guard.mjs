const PLACEHOLDER_PATTERN = /(replace|placeholder|example|current_existing)/i;

const REQUIRED_BROWSER_VARIABLES = Object.freeze([
  "VITE_FIREBASE_API_KEY",
  "VITE_FIREBASE_AUTH_DOMAIN",
  "VITE_FIREBASE_PROJECT_ID",
  "VITE_FIREBASE_STORAGE_BUCKET",
  "VITE_FIREBASE_MESSAGING_SENDER_ID",
  "VITE_FIREBASE_APP_ID",
]);

function required(env, name) {
  const value = String(env[name] || "").trim();
  if (!value || PLACEHOLDER_PATTERN.test(value)) {
    throw new Error(`Staging build requires ${name}`);
  }
  return value;
}

export function validateStagingBuildEnvironment(env, { productionProjectId } = {}) {
  if (env.VITE_APP_ENV !== "staging") {
    throw new Error("Staging build requires VITE_APP_ENV=staging");
  }
  if (env.VITE_SERVER_TRANSPORT !== "vercel") {
    throw new Error("Staging build requires VITE_SERVER_TRANSPORT=vercel");
  }
  if (env.VITE_STAGING_BANNER !== "true") {
    throw new Error("Staging build requires VITE_STAGING_BANNER=true");
  }
  for (const name of REQUIRED_BROWSER_VARIABLES) required(env, name);
  const projectId = required(env, "VITE_FIREBASE_PROJECT_ID");
  const confirmation = required(env, "CONFIRM_STAGING_PROJECT");
  if (confirmation !== projectId) {
    throw new Error("CONFIRM_STAGING_PROJECT must match VITE_FIREBASE_PROJECT_ID");
  }
  if (productionProjectId && projectId === productionProjectId) {
    throw new Error("Staging build cannot use the production Firebase project");
  }
  if (!projectId.toLowerCase().includes("staging")) {
    throw new Error("Staging Firebase project ID must contain staging");
  }
  return Object.freeze({ environment: "staging", transport: "vercel", projectId });
}

export { REQUIRED_BROWSER_VARIABLES };
