import { assertStagingTarget, targetFromProcess } from "./assert-staging-target.mjs";

try {
  const { projectId } = assertStagingTarget(targetFromProcess());
  console.log(
    JSON.stringify({
      dryRun: true,
      projectId,
      components: ["functions", "firestore:rules", "database", "hosting"],
      deployExecuted: false,
    })
  );
} catch (error) {
  console.error(`Staging dry-run rejected: ${error.message}`);
  process.exitCode = 2;
}
