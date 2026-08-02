import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import {
  inspectFirebaseIdToken,
  verifiedAuth,
} from "../../../api/_lib/http.js";

const require = createRequire(import.meta.url);
const {
  EXPECTED_VERCEL_AUDIENCE,
  EXPECTED_VERCEL_ISSUER,
  EXPECTED_VERCEL_SUBJECT,
} = require("../../server/environment-guard.js");
const { validateVercelOidcToken } = require("../../server/vercel-oidc.js");

const STAGING_PROJECT_ID = "family-quiz-staging";
const PRODUCTION_PROJECT_ID = "family-quiz-b7960";
const NOW_SECONDS = 2_000_000_000;

function jwt(payload) {
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.test-signature`;
}

function firebaseClaims(projectId = STAGING_PROJECT_ID, overrides = {}) {
  return {
    aud: projectId,
    iss: `https://securetoken.google.com/${projectId}`,
    sub: "safe-test-admin-uid",
    uid: "safe-test-admin-uid",
    iat: NOW_SECONDS - 60,
    exp: NOW_SECONDS + 3600,
    auth_time: NOW_SECONDS - 60,
    ...overrides,
  };
}

function stagingEnvironment() {
  return {
    APP_ENVIRONMENT: "staging",
    FIREBASE_ADMIN_PROJECT_ID: STAGING_PROJECT_ID,
  };
}

function requestWithAuthorization(value) {
  return { headers: { authorization: value } };
}

function runtimeFor(claims, verify = async () => claims) {
  return {
    projectId: STAGING_PROJECT_ID,
    auth: { verifyIdToken: verify },
  };
}

test("valid Firebase ID token envelope for Staging is accepted without real Google access", async () => {
  const claims = firebaseClaims();
  const token = jwt(claims);
  const result = await verifiedAuth(requestWithAuthorization(`Bearer ${token}`), {
    env: stagingEnvironment(),
    runtimeFactory: () => runtimeFor(claims),
  });
  assert.equal(result.uid, claims.sub);
  assert.equal(result.token.aud, STAGING_PROJECT_ID);
});

test("safe diagnostics expose only the expected Firebase claim metadata", () => {
  const diagnostic = inspectFirebaseIdToken(
    jwt(firebaseClaims(STAGING_PROJECT_ID, { admin: true })),
    NOW_SECONDS,
  );
  assert.deepEqual(diagnostic, {
    present: true,
    partCount: 3,
    payloadReadable: true,
    aud: STAGING_PROJECT_ID,
    iss: `https://securetoken.google.com/${STAGING_PROJECT_ID}`,
    subPresent: true,
    adminClaimPresent: true,
    expValid: true,
  });
  assert.equal(Object.values(diagnostic).some((value) => String(value).includes("test-signature")), false);
});

test("Production Firebase token is rejected before Admin verification", async () => {
  let verificationCalls = 0;
  const token = jwt(firebaseClaims(PRODUCTION_PROJECT_ID));
  await assert.rejects(
    verifiedAuth(requestWithAuthorization(`Bearer ${token}`), {
      env: stagingEnvironment(),
      runtimeFactory: () => runtimeFor({}, async () => {
        verificationCalls += 1;
        return {};
      }),
    }),
    (error) => error.stableCode === "invalid-token" && error.httpStatus === 401,
  );
  assert.equal(verificationCalls, 0);
});

test("missing and malformed Firebase tokens are rejected", async () => {
  await assert.rejects(
    verifiedAuth({ headers: {} }, { env: stagingEnvironment() }),
    (error) => error.stableCode === "missing-token",
  );
  await assert.rejects(
    verifiedAuth(requestWithAuthorization("Bearer malformed"), {
      env: stagingEnvironment(),
    }),
    (error) => error.stableCode === "invalid-token",
  );
});

test("double Bearer prefix is rejected", async () => {
  const token = jwt(firebaseClaims());
  await assert.rejects(
    verifiedAuth(requestWithAuthorization(`Bearer Bearer ${token}`), {
      env: stagingEnvironment(),
    }),
    (error) => error.stableCode === "invalid-token" && error.httpStatus === 401,
  );
});

test("unsigned Firebase token is allowed only for the local Auth Emulator", async () => {
  const claims = firebaseClaims("demo-family-quiz");
  const unsignedToken = jwt(claims).replace(/test-signature$/, "");
  await assert.rejects(
    verifiedAuth(requestWithAuthorization(`Bearer ${unsignedToken}`), {
      env: stagingEnvironment(),
    }),
    (error) => error.stableCode === "invalid-token",
  );
  const result = await verifiedAuth(requestWithAuthorization(`Bearer ${unsignedToken}`), {
    env: {
      FIREBASE_AUTH_EMULATOR_HOST: "127.0.0.1:9099",
      GCLOUD_PROJECT: "demo-family-quiz",
    },
    runtimeFactory: () => ({
      projectId: "demo-family-quiz",
      auth: { verifyIdToken: async () => claims },
    }),
  });
  assert.equal(result.uid, claims.sub);
});

test("Vercel OIDC token is never accepted as a Firebase ID token", async () => {
  const token = jwt({
    iss: EXPECTED_VERCEL_ISSUER,
    aud: EXPECTED_VERCEL_AUDIENCE,
    sub: EXPECTED_VERCEL_SUBJECT,
    iat: NOW_SECONDS - 60,
    exp: NOW_SECONDS + 3600,
  });
  await assert.rejects(
    verifiedAuth(requestWithAuthorization(`Bearer ${token}`), {
      env: stagingEnvironment(),
    }),
    (error) => error.stableCode === "invalid-token",
  );
});

test("Firebase ID token is never accepted as a Vercel OIDC token", () => {
  const token = jwt(firebaseClaims());
  assert.throws(() => validateVercelOidcToken(token, NOW_SECONDS), /issuer/);
});

test("OIDC or Firebase Admin initialization failure is not mislabeled invalid-token", async () => {
  const token = jwt(firebaseClaims());
  await assert.rejects(
    verifiedAuth(requestWithAuthorization(`Bearer ${token}`), {
      env: stagingEnvironment(),
      runtimeFactory: () => {
        throw new Error("test-only missing WIF configuration");
      },
    }),
    (error) =>
      error.stableCode === "server-configuration-error" &&
      error.httpStatus === 500 &&
      error.stableCode !== "invalid-token",
  );
});

test("Firebase verification infrastructure failure is a safe server error", async () => {
  const claims = firebaseClaims();
  const token = jwt(claims);
  await assert.rejects(
    verifiedAuth(requestWithAuthorization(`Bearer ${token}`), {
      env: stagingEnvironment(),
      runtimeFactory: () =>
        runtimeFor(claims, async () => {
          const error = new Error("test-only certificate service failure");
          error.code = "auth/internal-error";
          throw error;
        }),
    }),
    (error) =>
      error.stableCode === "server-authentication-unavailable" &&
      error.httpStatus === 503,
  );
});

test("admin custom claim reaches authorization after successful verification", async () => {
  const claims = firebaseClaims(STAGING_PROJECT_ID, { admin: true });
  const token = jwt(claims);
  const result = await verifiedAuth(requestWithAuthorization(`Bearer ${token}`), {
    env: stagingEnvironment(),
    runtimeFactory: () => runtimeFor(claims),
  });
  assert.equal(result.token.admin, true);
  assert.equal(result.uid, claims.sub);
});
