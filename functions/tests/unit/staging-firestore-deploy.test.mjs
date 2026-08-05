import assert from "node:assert/strict";
import test from "node:test";
import { stagingFirestoreDeployment } from "../../../scripts/deploy-staging-firestore.mjs";

test("Firestore deployment is pinned to the staging alias and reviewed files", () => {
  const deployment = stagingFirestoreDeployment(process.cwd(), {
    CONFIRM_STAGING_PROJECT: "family-quiz-staging",
  });
  assert.equal(deployment.projectId, "family-quiz-staging");
  assert.deepEqual(deployment.args, [
    "deploy",
    "--only",
    "firestore:rules,firestore:indexes",
    "--project",
    "staging",
  ]);
  assert.equal(deployment.args.includes("family-quiz-b7960"), false);
});

test("Firestore deployment guard fails closed without exact staging confirmation", () => {
  for (const confirmation of [undefined, "family-quiz-b7960", "staging"]) {
    assert.throws(
      () => stagingFirestoreDeployment(process.cwd(), {
        CONFIRM_STAGING_PROJECT: confirmation,
      }),
      /CONFIRM_STAGING_PROJECT/,
    );
  }
});
