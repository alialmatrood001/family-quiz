import { spawn } from "node:child_process";
import process from "node:process";

const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error("npm_execpath is required to run the release verifier");
const npmCheck = (script) => [process.execPath, [npmCli, "run", script]];
const checks = [
  npmCheck("test:staging-config"),
  npmCheck("test:vercel-runtime-deps"),
  npmCheck("test:oidc"),
  npmCheck("test:firebase-token-boundary"),
  npmCheck("test:operation11"),
  npmCheck("test:operation10:all"),
  npmCheck("test:unit"),
  npmCheck("test:vercel-api"),
  npmCheck("test:privacy"),
  npmCheck("test:staging-release-smoke"),
  npmCheck("lint"),
  npmCheck("build:staging"),
  npmCheck("test:operation11:builds"),
  ["git", ["diff", "--check"]],
];

function run(command, args) {
  return new Promise((resolve, reject) => {
    console.log(`\n[verify:staging-release] ${command} ${args.join(" ")}`);
    const child = spawn(command, args, { cwd: process.cwd(), env: process.env, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) reject(new Error(`${command} exited after signal ${signal}`));
      else if (code !== 0) reject(new Error(`${command} exited with code ${code}`));
      else resolve();
    });
  });
}

for (const [command, args] of checks) await run(command, args);
console.log("\nverify:staging-release passed all checks");
