import { resolveServerTransport } from "./server-api-core.js";

export function resolveClientEnvironment(environment = {}) {
  const name = String(environment.VITE_APP_ENV || "production").trim();
  const transport = resolveServerTransport(environment.VITE_SERVER_TRANSPORT);
  const stagingBanner = environment.VITE_STAGING_BANNER === "true";

  if (name === "staging") {
    if (transport !== "vercel") {
      throw new Error("Staging client requires the Vercel transport");
    }
    if (!stagingBanner) {
      throw new Error("Staging client requires the staging banner");
    }
  }

  return Object.freeze({
    name,
    transport,
    isStaging: name === "staging",
    showStagingBanner: name === "staging" && stagingBanner,
  });
}

const viteEnvironment = import.meta.env || {};
export const clientEnvironment = resolveClientEnvironment(viteEnvironment);
