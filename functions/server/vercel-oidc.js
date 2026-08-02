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

function identityError(message, diagnosticStage, {
  stableCode = "server-configuration-error",
  httpStatus = 500,
} = {}) {
  const error = new Error(message);
  error.stableCode = stableCode;
  error.httpStatus = httpStatus;
  error.diagnosticStage = diagnosticStage;
  return error;
}

function safeBase64Json(value) {
  try {
    return JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    throw identityError("Vercel OIDC token is malformed", "oidc-claims");
  }
}

function validateVercelOidcToken(token, nowSeconds = Math.floor(Date.now() / 1000)) {
  if (typeof token !== "string" || token.length < 32 || token.length > 16_384) {
    throw identityError("Vercel OIDC token is missing or malformed", "oidc-header");
  }
  const parts = token.split(".");
  if (parts.length !== 3) {
    throw identityError("Vercel OIDC token is malformed", "oidc-claims");
  }
  const claims = safeBase64Json(parts[1]);
  if (claims.iss !== EXPECTED_VERCEL_ISSUER) {
    throw identityError("Vercel OIDC issuer is not approved", "oidc-claims");
  }
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!audiences.includes(EXPECTED_VERCEL_AUDIENCE)) {
    throw identityError("Vercel OIDC audience is not approved", "oidc-claims");
  }
  if (claims.sub !== EXPECTED_VERCEL_SUBJECT) {
    throw identityError("Vercel OIDC subject is not approved", "oidc-claims");
  }
  if (!Number.isFinite(claims.exp) || claims.exp <= nowSeconds + 30) {
    throw identityError("Vercel OIDC token is expired or too close to expiry", "oidc-claims");
  }
  if (Number.isFinite(claims.nbf) && claims.nbf > nowSeconds + 30) {
    throw identityError("Vercel OIDC token is not active", "oidc-claims");
  }
  return Object.freeze({
    issuerApproved: true,
    audienceApproved: true,
    subjectApproved: true,
  });
}

function oidcTokenFromRequest(req) {
  const value =
    req?.headers?.["x-vercel-oidc-token"] ??
    req?.headers?.["X-Vercel-OIDC-Token"] ??
    req?.headers?.get?.("x-vercel-oidc-token");
  if (Array.isArray(value) || typeof value !== "string") {
    throw identityError("Vercel OIDC request token is required", "oidc-header");
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
    `//iam.googleapis.com/projects/${configuration.projectNumber}` +
    `/locations/global/workloadIdentityPools/${configuration.poolId}` +
    `/providers/${configuration.providerId}`;
  return Object.freeze({
    audience: providerAudience,
    subject_token_type: SUBJECT_TOKEN_TYPE,
    token_url: "https://sts.googleapis.com/v1/token",
    service_account_impersonation_url:
      "https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/" +
      `${encodeURIComponent(configuration.serviceAccountEmail)}:generateAccessToken`,
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
      let response;
      try {
        response = await authClient.getAccessToken();
      } catch {
        throw identityError("Server identity provider is unavailable", "sts", {
          httpStatus: 503,
          stableCode: "server-authentication-unavailable",
        });
      }
      if (!response?.token) {
        throw identityError("Server identity provider returned no credential", "impersonation", {
          httpStatus: 503,
          stableCode: "server-authentication-unavailable",
        });
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
