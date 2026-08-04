"use strict";

const { createFinalizeQuestionHandler } = require("../finalize-question/handler");
const { createSecureWriteHandlers } = require("../secure-writes/handlers");
const { getServerFirebase } = require("./firebase-admin");

const operationsByDatabase = new WeakMap();

function createServerOperations({ db }) {
  const secureWrites = createSecureWriteHandlers({ db });
  return Object.freeze({
    ...secureWrites,
    finalizeQuestion: createFinalizeQuestionHandler({ db }),
  });
}

function getServerOperations() {
  const db = getServerFirebase().db;
  let operations = operationsByDatabase.get(db);
  if (!operations) {
    operations = createServerOperations({ db });
    operationsByDatabase.set(db, operations);
  }
  return operations;
}

module.exports = {
  createServerOperations,
  getServerOperations,
};
