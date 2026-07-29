"use strict";

const { AsyncLocalStorage } = require("node:async_hooks");
const { IdentityPoolClient } = require("google-auth-library");
const {
  EXPECTED_VERCEL_AUDIENCE,
  EXPECTED_VERCEL_ISSUER,
  EXPECTED_VERCEL_SUBJECT,
  validateStagingServerEnvironment,
} = require("./environment-guard");

const SUBJECT_TOKEN_TYPE = "urn:ietf:params:oauth:token-type:jwt";
const GOOGLE_SCOPES = Object.freeze([
  "https://www.googleapis.com/auth/cloud-platform",
  "https://www.googleapis.com/auth/firebase.database",
  "https://www.googleapis.com/auth/userinfo.email",
]);
const requestTokenStorage = new AsyncLocalStorage();
let cachedCredential;

function safeBase64Json(value) {
  try {
    return JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    throw new Error("Vercel OIDC token is malformed");
  }
}

function validateVercelOidcToken(token, nowSeconds = Math.floor(Date.now() / 1000)) {
  if (typeof token !== "string" || token.length < 32 || token.length > 16_384) {
    throw new Error("Vercel OIDC token is missing or malformed");
  }
  const parts = token.split(".");
  if (parts.length !== 3) {
    throw new Error("Vercel OIDC token is malformed");
  }
  const claims = safeBase64Json(parts[1]);
  if (claims.iss !== EXPECTED_VERCEL_ISSUER) {
    throw new Error("Vercel OIDC issuer is not approved");
  }
  if (claims.aud !== EXPECTED_VERCEL_AUDIENCE) {
    throw new Error("Vercel OIDC audience is not approved");
  }
  if (claims.sub !== EXPECTED_VERCEL_SUBJECT) {
    throw new Error("Vercel OIDC subject is not approved");
  }
  if (!Number.isFinite(claims.exp) || claims.exp <= nowSeconds + 30) {
    throw new Error("Vercel OIDC token is expired or too close to expiry");
  }
  if (Number.isFinite(claims.nbf) && claims.nbf > nowSeconds + 30) {
    throw new Error("Vercel OIDC token is not active");
  }
  return Object.freeze({
    issuerApproved: true,
    audienceApproved: true,
    subjectApproved: true,
  });
}

function oidcTokenFromRequest(req) {
  const value = req?.headers?.["x-vercel-oidc-token"];
  if (Array.isArray(value) || typeof value !== "string") {
    throw new Error("Vercel OIDC request token is required");
  }
  return value;
}

function runWithVercelOidcRequest(req, callback) {
  const token = oidcTokenFromRequest(req);
  validateVercelOidcToken(token);
  return requestTokenStorage.run(token, callback);
}

function externalAccountOptions(env) {
  const configuration = validateStagingServerEnvironment(env);
  if (configuration.authMode !== "oidc") {
    throw new Error("External account configuration requires OIDC mode");
  }
  const providerAudience =
    `//iam.googleapis.com/projects/${env.GCP_PROJECT_NUMBER}` +
    `/locations/global/workloadIdentityPools/${env.GCP_WORKLOAD_IDENTITY_POOL_ID}` +
    `/providers/${env.GCP_WORKLOAD_IDENTITY_PROVIDER_ID}`;
  return Object.freeze({
    audience: providerAudience,
    subject_token_type: SUBJECT_TOKEN_TYPE,
    token_url: "https://sts.googleapis.com/v1/token",
    service_account_impersonation_url:
      "https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/" +
      `${encodeURIComponent(env.GCP_SERVICE_ACCOUNT_EMAIL)}:generateAccessToken`,
    service_account_impersonation: { token_lifetime_seconds: 900 },
    scopes: [...GOOGLE_SCOPES],
  });
}

function createWifCredential(
  env = process.env,
  { IdentityPoolClientClass = IdentityPoolClient } = {},
) {
  const options = externalAccountOptions(env);
  const authClient = new IdentityPoolClientClass({
    ...options,
    subject_token_supplier: {
      async getSubjectToken(context) {
        if (
          context.audience !== options.audience ||
          context.subjectTokenType !== SUBJECT_TOKEN_TYPE
        ) {
          throw new Error("Google external account requested an unexpected token contract");
        }
        const token = requestTokenStorage.getStore();
        validateVercelOidcToken(token);
        return token;
      },
    },
  });

  return Object.freeze({
    async getAccessToken() {
      const response = await authClient.getAccessToken();
      if (!response?.token) {
        throw new Error("Google Workload Identity Federation returned no access token");
      }
      const expiryDate = Number(authClient.credentials?.expiry_date);
      const expiresIn = Number.isFinite(expiryDate)
        ? Math.max(1, Math.floor((expiryDate - Date.now()) / 1000))
        : 300;
      return { access_token: response.token, expires_in: expiresIn };
    },
  });
}

function getWifCredential(env = process.env, dependencies) {
  if (!cachedCredential) {
    cachedCredential = createWifCredential(env, dependencies);
  }
  return cachedCredential;
}

function resetWifCredentialForTests() {
  cachedCredential = undefined;
}

module.exports = {
  GOOGLE_SCOPES,
  SUBJECT_TOKEN_TYPE,
  createWifCredential,
  externalAccountOptions,
  getWifCredential,
  oidcTokenFromRequest,
  resetWifCredentialForTests,
  runWithVercelOidcRequest,
  validateVercelOidcToken,
};
