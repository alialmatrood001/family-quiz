import { spawn } from "node:child_process";
import path from "node:path";

const mode = process.argv[2];
const modes = {
  callable: {
    viteMode: "production",
    variables: {
      VITE_APP_ENV: "production",
      VITE_SERVER_TRANSPORT: "callable",
      VITE_STAGING_BANNER: "false",
      VITE_STAGING_LABEL: "",
    },
  },
  staging: {
    viteMode: "staging",
    variables: {
      VITE_APP_ENV: "staging",
      VITE_SERVER_TRANSPORT: "vercel",
      VITE_STAGING_BANNER: "true",
      VITE_STAGING_LABEL: "STAGING — بيانات تجريبية",
    },
  },
  vercel: {
    viteMode: "production",
    variables: {
      VITE_APP_ENV: "production",
      VITE_SERVER_TRANSPORT: "vercel",
      VITE_STAGING_BANNER: "false",
      VITE_STAGING_LABEL: "",
    },
  },
};

if (!Object.hasOwn(modes, mode)) {
  throw new Error(`Unknown build environment: ${mode}`);
}

const selected = modes[mode];
const vite = path.join(process.cwd(), "node_modules", "vite", "bin", "vite.js");
const child = spawn(process.execPath, [vite, "build", "--mode", selected.viteMode], {
  stdio: "inherit",
  env: { ...process.env, ...selected.variables },
});
child.once("error", (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
child.once("exit", (code, signal) => {
  if (signal) {
    console.error(`Vite exited after signal ${signal}`);
    process.exitCode = 1;
  } else {
    process.exitCode = code ?? 1;
  }
});
