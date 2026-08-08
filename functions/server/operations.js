"use strict";

const { createFinalizeQuestionHandler } = require("../finalize-question/handler");
const { createSecureWriteHandlers } = require("../secure-writes/handlers");
const { getServerFirebase } = require("./firebase-admin");

const operationsByDatabase = new WeakMap();

function createServerOperations({ db }) {
  const secureWrites = createSecureWriteHandlers({ db });
  const resetAndOpenRegistration = async (request) => {
    const roomId = request?.data?.roomId;
    let reset;
    try {
      reset = await secureWrites.resetQuizData({
        auth: request.auth,
        data: {
          roomId,
          mode: "full",
          reason: "فتح التسجيل من أدوات التحكم الآمنة",
        },
      });
    } catch (error) {
      if (error && typeof error === "object") error.failedStep ||= "reset-quiz-data";
      throw error;
    }
    let lifecycle;
    try {
      lifecycle = await secureWrites.controlQuizLifecycle({
        auth: request.auth,
        data: { roomId, action: "open-registration" },
      });
    } catch (error) {
      if (error && typeof error === "object") error.failedStep ||= "open-registration";
      throw error;
    }
    return { success: true, status: "registration-opened", reset, lifecycle };
  };
  const startCompetitionWithQuestion = async (request) => {
    const { roomId, questionId, questionIndex, selectedCategory } = request?.data || {};
    const lifecycle = await secureWrites.controlQuizLifecycle({
      auth: request.auth,
      data: { roomId, action: "start-competition" },
    });
    const prepared = await secureWrites.prepareQuestion({
      auth: request.auth,
      data: {
        roomId,
        questionId,
        questionIndex,
        ...(selectedCategory ? { selectedCategory } : {}),
      },
    });
    return { success: true, status: "competition-question-prepared", lifecycle, prepared };
  };
  return Object.freeze({
    ...secureWrites,
    resetAndOpenRegistration,
    startCompetitionWithQuestion,
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
