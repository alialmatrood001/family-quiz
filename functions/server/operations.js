"use strict";

const { createFinalizeQuestionHandler } = require("../finalize-question/handler");
const { createSecureWriteHandlers } = require("../secure-writes/handlers");
const { getServerFirebase } = require("./firebase-admin");

let cachedOperations;

function createServerOperations({ db }) {
  const secureWrites = createSecureWriteHandlers({ db });
  return Object.freeze({
    ...secureWrites,
    finalizeQuestion: createFinalizeQuestionHandler({ db }),
  });
}

function getServerOperations() {
  if (!cachedOperations) {
    cachedOperations = createServerOperations({ db: getServerFirebase().db });
  }
  return cachedOperations;
}

module.exports = {
  createServerOperations,
  getServerOperations,
};
