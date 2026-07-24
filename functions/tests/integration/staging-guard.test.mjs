import assert from "node:assert/strict";
import test from "node:test";
import { assertStagingTarget } from "../../../scripts/assert-staging-target.mjs";

const base = {
  productionProjectId: "family-quiz-production",
  allowlist: [],
  credentialsPath: undefined,
};

test("staging target guard rejects placeholders, production, missing confirmation and credentials", () => {
  assert.throws(
    () => assertStagingTarget({ ...base, projectId: "REPLACE_WITH_STAGING_PROJECT_ID" }),
    /placeholders/
  );
  assert.throws(
    () =>
      assertStagingTarget({
        ...base,
        projectId: "family-quiz-production",
        confirmation: "family-quiz-production",
      }),
    /production/
  );
  assert.throws(
    () =>
      assertStagingTarget({
        ...base,
        projectId: "family-quiz-staging",
        confirmation: "",
      }),
    /CONFIRM_STAGING_PROJECT/
  );
  assert.throws(
    () =>
      assertStagingTarget({
        ...base,
        projectId: "family-quiz-staging",
        confirmation: "family-quiz-staging",
        credentialsPath: "forbidden.json",
      }),
    /Service-account/
  );
});

test("staging target guard accepts only an explicitly confirmed staging target", () => {
  assert.deepEqual(
    assertStagingTarget({
      ...base,
      projectId: "family-quiz-staging",
      confirmation: "family-quiz-staging",
    }),
    {
      projectId: "family-quiz-staging",
      productionProjectId: "family-quiz-production",
    }
  );
});
