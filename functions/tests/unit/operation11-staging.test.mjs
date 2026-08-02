import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import {
  REQUIRED_BROWSER_VARIABLES,
  validateStagingBuildEnvironment,
} from "../../../scripts/staging-build-guard.mjs";
import { resolveClientEnvironment } from "../../../src/client-environment.js";
import { SERVER_OPERATIONS } from "../../../src/server-api-core.js";

const require = createRequire(import.meta.url);
const { validateStagingServerEnvironment } = require("../../server/environment-guard.js");
const { calculateQuestionPoints } = require("../../finalize-question/calculate-points.js");

function serverEnvironment(overrides = {}) {
  const projectId = "family-quiz-staging";
  return {
    APP_ENVIRONMENT: "staging",
    SERVER_TRANSPORT: "vercel",
    FIREBASE_ADMIN_AUTH_MODE: "legacy-key",
    FIREBASE_ADMIN_PROJECT_ID: projectId,
    FIREBASE_PRODUCTION_PROJECT_ID: "family-quiz-b7960",
    CONFIRM_STAGING_PROJECT: projectId,
    FIREBASE_ADMIN_CLIENT_EMAIL:
      "firebase-adminsdk-test@family-quiz-staging.iam.gserviceaccount.com",
    FIREBASE_ADMIN_PRIVATE_KEY:
      "-----BEGIN PRIVATE KEY-----\nTEST-ONLY\n-----END PRIVATE KEY-----",
    FIREBASE_DATABASE_URL: `https://${projectId}.firebaseio.com`,
    STAGING_ORIGIN: "https://family-quiz-staging.vercel.app",
    PRODUCTION_ORIGIN: "https://family-quiz.com",
    VERCEL_ALLOWED_ORIGINS: "https://family-quiz-staging.vercel.app",
    ...overrides,
  };
}

function browserEnvironment(overrides = {}) {
  return {
    VITE_APP_ENV: "staging",
    VITE_SERVER_TRANSPORT: "vercel",
    VITE_STAGING_BANNER: "true",
    VITE_FIREBASE_API_KEY: "staging-browser-key",
    VITE_FIREBASE_AUTH_DOMAIN: "family-quiz-staging-test.firebaseapp.com",
    VITE_FIREBASE_PROJECT_ID: "family-quiz-staging-test",
    VITE_FIREBASE_STORAGE_BUCKET: "family-quiz-staging-test.firebasestorage.app",
    VITE_FIREBASE_MESSAGING_SENDER_ID: "1234567890",
    VITE_FIREBASE_APP_ID: "1:1234567890:web:staging",
    CONFIRM_STAGING_PROJECT: "family-quiz-staging-test",
    ...overrides,
  };
}

test("server guard accepts a complete isolated staging profile", () => {
  assert.deepEqual(validateStagingServerEnvironment(serverEnvironment()), {
    environment: "staging",
    transport: "vercel",
    projectId: "family-quiz-staging",
    stagingOrigin: "https://family-quiz-staging.vercel.app",
    authMode: "legacy-key",
  });
});

test("server guard blocks Production, missing values, and mixed targets", () => {
  assert.throws(
    () =>
      validateStagingServerEnvironment(
        serverEnvironment({ FIREBASE_ADMIN_PROJECT_ID: "family-quiz-production" }),
      ),
    /family-quiz-staging|match FIREBASE_ADMIN_PROJECT_ID|must not equal/,
  );
  assert.throws(
    () => validateStagingServerEnvironment(serverEnvironment({ FIREBASE_ADMIN_PRIVATE_KEY: "" })),
    /FIREBASE_ADMIN_PRIVATE_KEY/,
  );
  assert.throws(
    () =>
      validateStagingServerEnvironment(
        serverEnvironment({
          FIREBASE_ADMIN_CLIENT_EMAIL:
            "firebase-adminsdk-test@family-quiz-production.iam.gserviceaccount.com",
        }),
      ),
    /does not belong/,
  );
  assert.throws(
    () =>
      validateStagingServerEnvironment(
        serverEnvironment({ GOOGLE_APPLICATION_CREDENTIALS: "forbidden.json" }),
      ),
    /forbidden/,
  );
  assert.throws(
    () =>
      validateStagingServerEnvironment(
        serverEnvironment({ VERCEL_ALLOWED_ORIGINS: "https://family-quiz.example" }),
      ),
    /only STAGING_ORIGIN/,
  );
});

test("browser build guard blocks Production, missing values, and invalid transport", () => {
  assert.deepEqual(
    validateStagingBuildEnvironment(browserEnvironment(), {
      productionProjectId: "family-quiz-production",
    }).projectId,
    "family-quiz-staging-test",
  );
  assert.throws(
    () =>
      validateStagingBuildEnvironment(browserEnvironment(), {
        productionProjectId: "family-quiz-staging-test",
      }),
    /cannot use the production/,
  );
  for (const variable of REQUIRED_BROWSER_VARIABLES) {
    assert.throws(
      () =>
        validateStagingBuildEnvironment(browserEnvironment({ [variable]: "" }), {
          productionProjectId: "family-quiz-production",
        }),
      new RegExp(variable),
    );
  }
  assert.throws(
    () =>
      validateStagingBuildEnvironment(browserEnvironment({ VITE_SERVER_TRANSPORT: "callable" }), {
        productionProjectId: "family-quiz-production",
      }),
    /Vercel|vercel/,
  );
});

test("client banner and rollback modes remain explicit", () => {
  assert.deepEqual(
    resolveClientEnvironment({
      VITE_APP_ENV: "staging",
      VITE_SERVER_TRANSPORT: "vercel",
      VITE_STAGING_BANNER: "true",
    }),
    {
      name: "staging",
      transport: "vercel",
      isStaging: true,
      showStagingBanner: true,
    },
  );
  assert.equal(
    resolveClientEnvironment({
      VITE_APP_ENV: "production",
      VITE_SERVER_TRANSPORT: "callable",
      VITE_STAGING_BANNER: "false",
    }).showStagingBanner,
    false,
  );
  assert.equal(
    resolveClientEnvironment({
      VITE_APP_ENV: "production",
      VITE_SERVER_TRANSPORT: "vercel",
      VITE_STAGING_BANNER: "false",
    }).showStagingBanner,
    false,
  );
});

test("operation registry and scoring behavior remain unchanged", () => {
  assert.equal(Object.keys(SERVER_OPERATIONS).length, 16);
  assert.deepEqual(Object.keys(SERVER_OPERATIONS), [
    "registerPlayer",
    "recoverPlayer",
    "submitAnswer",
    "activateJoker",
    "cancelJoker",
    "updatePlayerProfile",
    "prepareQuestion",
    "startQuestion",
    "controlQuestion",
    "finalizeQuestion",
    "adjustPlayerScore",
    "getPlayerPrivateDetails",
    "initializeQuiz",
    "deletePlayer",
    "resetPracticeScores",
    "resetQuizData",
  ]);
  assert.deepEqual(
    calculateQuestionPoints({
      answeredAtMs: 1_005_000,
      answerStartAtMs: 1_000_000,
      seconds: 10,
      maxPoints: 1_000,
      minPoints: 100,
      isCorrect: true,
      jokerMultiplier: null,
    }),
    { basePoints: 550, points: 550 },
  );
});
