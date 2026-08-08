"use strict";

const { AsyncLocalStorage } = require("node:async_hooks");
const { Firestore } = require("@google-cloud/firestore");
const { GoogleAuth } = require("google-auth-library");
const {
  currentVercelOidcToken,
  externalAccountOptions,
} = require("./vercel-oidc");
const {
  measureServerTiming,
} = require("./request-timing");

const requestFirestoreStorage = new AsyncLocalStorage();
const defaultRuntimeCache = { runtime: null, closing: null };

class RequestLocalSubjectTokenSupplier {
  constructor({ audience, subjectTokenType }) {
    this.audience = audience;
    this.subjectTokenType = subjectTokenType;
  }

  async getSubjectToken(context) {
    if (
      context?.audience !== this.audience ||
      context?.subjectTokenType !== this.subjectTokenType
    ) {
      throw new Error("WIF subject token context does not match the approved provider");
    }
    return currentVercelOidcToken();
  }
}

function externalAccountConfiguration(env, subjectTokenSupplier) {
  const options = externalAccountOptions(env);
  if (!subjectTokenSupplier || typeof subjectTokenSupplier.getSubjectToken !== "function") {
    throw new Error("A request-local WIF subject token supplier is required");
  }
  return Object.freeze({
    type: "external_account",
    audience: options.audience,
    subject_token_type: options.subject_token_type,
    token_url: options.token_url,
    service_account_impersonation_url: options.service_account_impersonation_url,
    service_account_impersonation: options.service_account_impersonation,
    subject_token_supplier: subjectTokenSupplier,
  });
}

function configurationProjectId(env) {
  return String(env.FIREBASE_ADMIN_PROJECT_ID || "").trim();
}

function runtimeFingerprint(env) {
  const options = externalAccountOptions(env);
  return JSON.stringify({
    projectId: configurationProjectId(env),
    audience: options.audience,
    subjectTokenType: options.subject_token_type,
    tokenUrl: options.token_url,
    impersonationUrl: options.service_account_impersonation_url,
  });
}

function createWarmWifFirestoreRuntime(
  env,
  { FirestoreClass = Firestore, GoogleAuthClass = GoogleAuth } = {},
) {
  const options = externalAccountOptions(env);
  const projectId = configurationProjectId(env);
  const supplier = new RequestLocalSubjectTokenSupplier({
    audience: options.audience,
    subjectTokenType: options.subject_token_type,
  });
  const auth = new GoogleAuthClass({
    projectId,
    scopes: [...options.scopes],
    credentials: externalAccountConfiguration(env, supplier),
  });
  const firestore = new FirestoreClass({
    projectId,
    auth,
    maxIdleChannels: 1,
  });
  return Object.freeze({
    auth,
    fingerprint: runtimeFingerprint(env),
    firestore,
    supplier,
  });
}

function warmRuntime(env, cache, factories) {
  const fingerprint = runtimeFingerprint(env);
  if (cache.runtime) {
    if (cache.runtime.fingerprint !== fingerprint) {
      throw new Error("Warm WIF runtime configuration cannot change within a process");
    }
    return cache.runtime;
  }
  cache.runtime = createWarmWifFirestoreRuntime(env, factories);
  return cache.runtime;
}

async function ensureWifCredential(runtime) {
  const client = await runtime.auth.getClient();
  await client.getAccessToken();
}

async function runWithWifFirestoreRequest(
  env,
  callback,
  {
    FirestoreClass = Firestore,
    GoogleAuthClass = GoogleAuth,
    runtimeCache = defaultRuntimeCache,
    credentialReady = ensureWifCredential,
  } = {},
) {
  currentVercelOidcToken();
  const runtime = await measureServerTiming("firestoreReadyMs", () =>
    warmRuntime(env, runtimeCache, { FirestoreClass, GoogleAuthClass }),
  );
  try {
    return await requestFirestoreStorage.run(
      Object.freeze({ credentialReady, firestore: runtime.firestore, runtime }),
      callback,
    );
  } finally {
    await measureServerTiming("cleanupMs", async () => undefined);
  }
}

async function ensureRequestWifCredential() {
  const request = requestFirestoreStorage.getStore();
  if (!request?.runtime) {
    throw new Error("Request-local WIF Firestore is not initialized");
  }
  await measureServerTiming("wifCredentialMs", () =>
    request.credentialReady(request.runtime),
  );
}

function getRequestFirestore() {
  const firestore = requestFirestoreStorage.getStore()?.firestore;
  if (!firestore) {
    throw new Error("Request-local WIF Firestore is not initialized");
  }
  return firestore;
}

async function closeWarmWifFirestore(runtimeCache = defaultRuntimeCache) {
  if (!runtimeCache.runtime) return;
  if (!runtimeCache.closing) {
    const runtime = runtimeCache.runtime;
    runtimeCache.closing = Promise.resolve(runtime.firestore?.terminate?.()).finally(() => {
      runtimeCache.runtime = null;
      runtimeCache.closing = null;
    });
  }
  await runtimeCache.closing;
}

process.once("beforeExit", () => closeWarmWifFirestore().catch(() => undefined));

module.exports = {
  RequestLocalSubjectTokenSupplier,
  closeWarmWifFirestore,
  createWarmWifFirestoreRuntime,
  externalAccountConfiguration,
  ensureRequestWifCredential,
  getRequestFirestore,
  runWithWifFirestoreRequest,
};
