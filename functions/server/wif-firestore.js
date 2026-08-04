"use strict";

const { AsyncLocalStorage } = require("node:async_hooks");
const { mkdtemp, rm, writeFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const path = require("node:path");
const { Firestore } = require("@google-cloud/firestore");
const {
  currentVercelOidcToken,
  externalAccountOptions,
} = require("./vercel-oidc");

const requestFirestoreStorage = new AsyncLocalStorage();

function externalAccountConfiguration(env, subjectTokenPath) {
  const options = externalAccountOptions(env);
  return Object.freeze({
    type: "external_account",
    audience: options.audience,
    subject_token_type: options.subject_token_type,
    token_url: options.token_url,
    service_account_impersonation_url: options.service_account_impersonation_url,
    service_account_impersonation: options.service_account_impersonation,
    credential_source: Object.freeze({
      file: subjectTokenPath,
      format: Object.freeze({ type: "text" }),
    }),
  });
}

async function runWithWifFirestoreRequest(
  env,
  callback,
  {
    FirestoreClass = Firestore,
    fileSystem = { mkdtemp, rm, writeFile },
    temporaryDirectory = tmpdir(),
  } = {},
) {
  const token = currentVercelOidcToken();
  const directory = await fileSystem.mkdtemp(
    path.join(temporaryDirectory, "family-quiz-wif-"),
  );
  const tokenPath = path.join(directory, "subject-token.jwt");
  const configurationPath = path.join(directory, "external-account.json");
  let firestore;
  try {
    await fileSystem.writeFile(tokenPath, token, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    const configuration = externalAccountConfiguration(env, tokenPath);
    await fileSystem.writeFile(
      configurationPath,
      `${JSON.stringify(configuration)}\n`,
      { encoding: "utf8", flag: "wx", mode: 0o600 },
    );
    firestore = new FirestoreClass({
      projectId: configurationProjectId(env),
      keyFilename: configurationPath,
    });
    return await requestFirestoreStorage.run(
      Object.freeze({ firestore }),
      callback,
    );
  } finally {
    try {
      await firestore?.terminate?.();
    } finally {
      await fileSystem.rm(directory, { recursive: true, force: true });
    }
  }
}

function configurationProjectId(env) {
  return String(env.FIREBASE_ADMIN_PROJECT_ID || "").trim();
}

function getRequestFirestore() {
  const firestore = requestFirestoreStorage.getStore()?.firestore;
  if (!firestore) {
    throw new Error("Request-local WIF Firestore is not initialized");
  }
  return firestore;
}

module.exports = {
  externalAccountConfiguration,
  getRequestFirestore,
  runWithWifFirestoreRequest,
};
