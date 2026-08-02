"use strict";

const crypto = require("node:crypto");
const { HttpsError } = require("firebase-functions/v2/https");
const { Timestamp } = require("firebase-admin/firestore");
const {
  exactInput,
  normalizePhone,
  normalizeRecoveryName,
  publicPlayerData,
  publicQuestionData,
  requireAdmin,
  requireAuthenticated,
  requirePlayerOwner,
  safeId,
  validateScoreAdjustment,
  validateSelectedIndex,
} = require("./domain");

const MAX_PLAYERS = 400;
const QUIZ_INITIALIZATION = Object.freeze({
  title: "مسابقة قروب العائلة العائلية",
  subtitle: "من تقديم الأستاذ إبراهيم ال مطرود",
  stage: "home",
  currentQuestion: null,
  currentQuestionIndex: -1,
  questionSentAt: null,
  audioStartedAt: null,
  audioEndedAt: null,
  mediaStartedAt: null,
  mediaEndedAt: null,
  questionIgnored: false,
  ignoredQuestionIds: {},
  processedQuestionId: null,
  resultsCalculated: false,
  resultsCalculatedQuestionId: null,
  collectingBonusByPlayer: {},
  collectingBonusJokerByPlayer: {},
  collectingBonusPlayerId: null,
  collectingBonusPoints: 0,
  rankMovementByPlayer: {},
  collectingAnswerCorrectByPlayer: {},
  resultsDisplaySnapshot: null,
  calculationStatus: null,
  testMode: {
    autoAnswerEnabled: false,
    slowResultsEnabled: false,
    slowResultsDelayMs: 15000,
  },
  activePackageId: "default",
  activePackageName: "المسابقة الحالية",
  categoryVotingEnabled: false,
  categoryVote: null,
  usedQuestionIds: {},
});

function sameId(left, right) {
  return String(left || "") === String(right || "");
}

function timestampFactory(now) {
  return () => Timestamp.fromMillis(now());
}

function registrationKeyId(type, value) {
  return crypto
    .createHash("sha256")
    .update(`${type}\0${String(value || "").trim().toLocaleLowerCase("ar")}`)
    .digest("hex");
}

function createSecureWriteHandlers({
  db,
  now = () => Date.now(),
  runId = () => crypto.randomUUID(),
}) {
  const serverTimestamp = timestampFactory(now);

  const initializeQuiz = async (request) => {
    requireAdmin(request.auth);
    const data = exactInput(request.data, ["roomId"]);
    const roomId = safeId(data.roomId, "roomId");
    const roomRef = db.doc(`rooms/${roomId}`);
    return db.runTransaction(async (transaction) => {
      const roomSnapshot = await transaction.get(roomRef);
      transaction.set(
        roomRef,
        {
          ...QUIZ_INITIALIZATION,
          ...(roomSnapshot.exists ? {} : { createdAt: serverTimestamp() }),
          updatedAt: serverTimestamp(),
        },
        { merge: true },
      );
      return {
        success: true,
        status: roomSnapshot.exists ? "initialized" : "created",
        roomId,
      };
    });
  };

  const registerPlayer = async (request) => {
    const uid = requireAuthenticated(request.auth);
    const data = exactInput(request.data, ["roomId", "name", "emoji", "fullName", "phone"]);
    const roomId = safeId(data.roomId, "roomId");
    const name = String(data.name || "").trim();
    const emoji = String(data.emoji || "").trim().slice(0, 8);
    const { fullName, recoveryNameNormalized } = normalizeRecoveryName(data.fullName);
    const phoneNormalized = normalizePhone(data.phone);
    if (name.length < 1 || name.length > 40) {
      throw new HttpsError("invalid-argument", "Player display name is invalid");
    }

    const roomRef = db.doc(`rooms/${roomId}`);
    const playersRef = roomRef.collection("players");
    const privatePlayersRef = roomRef.collection("playerPrivate");
    const registrationKeysRef = roomRef.collection("playerRegistrationKeys");
    const playerRef = playersRef.doc();
    const privatePlayerRef = privatePlayersRef.doc(playerRef.id);
    const ownerKeyRef = registrationKeysRef.doc(registrationKeyId("uid", uid));
    const nameKeyRef = registrationKeysRef.doc(registrationKeyId("name", name));
    const phoneKeyRef = registrationKeysRef.doc(
      registrationKeyId("phone", phoneNormalized)
    );
    return db.runTransaction(async (transaction) => {
      const roomSnapshot = await transaction.get(roomRef);
      if (!roomSnapshot.exists) throw new HttpsError("not-found", "Room not found");
      const room = roomSnapshot.data();
      if (!["registration", "instructions"].includes(room.stage) && !room.registrationOverrideOpen) {
        throw new HttpsError("failed-precondition", "Registration is closed");
      }
      const [ownerSnapshot, nameSnapshot, phoneSnapshot] = await Promise.all([
        transaction.get(ownerKeyRef),
        transaction.get(nameKeyRef),
        transaction.get(phoneKeyRef),
      ]);
      if (ownerSnapshot.exists) {
        const existingPlayerId = ownerSnapshot.data().playerId;
        const existingPublicSnapshot = await transaction.get(playersRef.doc(existingPlayerId));
        if (!existingPublicSnapshot.exists) {
          throw new HttpsError("failed-precondition", "Player registration is incomplete");
        }
        const existingPublic = existingPublicSnapshot.data();
        return {
          success: true,
          status: "already-registered",
          playerId: existingPlayerId,
          player: {
            name: existingPublic.name || "",
            displayName: existingPublic.displayName || existingPublic.name || "",
            emoji: existingPublic.emoji || "",
          },
        };
      }
      if (nameSnapshot.exists || phoneSnapshot.exists) {
        throw new HttpsError("already-exists", "Player name or phone is already registered");
      }
      const createdAt = serverTimestamp();
      const publicPlayer = publicPlayerData({
        name,
        emoji,
        createdAt,
      });
      transaction.create(playerRef, publicPlayer);
      transaction.create(privatePlayerRef, {
        authUid: uid,
        fullName,
        phoneNormalized,
        recoveryNameNormalized,
        createdAt,
        updatedAt: createdAt,
      });
      transaction.create(ownerKeyRef, {
        type: "uid",
        playerId: playerRef.id,
        createdAt,
      });
      transaction.create(nameKeyRef, {
        type: "name",
        playerId: playerRef.id,
        createdAt,
      });
      transaction.create(phoneKeyRef, {
        type: "phone",
        playerId: playerRef.id,
        createdAt,
      });
      return {
        success: true,
        status: "registered",
        playerId: playerRef.id,
        player: { name, displayName: name, emoji },
      };
    });
  };

  const recoverPlayer = async (request) => {
    const uid = requireAuthenticated(request.auth);
    const data = exactInput(request.data, ["roomId"]);
    const roomId = safeId(data.roomId, "roomId");
    const roomRef = db.doc(`rooms/${roomId}`);
    const privateSnapshot = await roomRef
      .collection("playerPrivate")
      .where("authUid", "==", uid)
      .limit(2)
      .get();
    if (privateSnapshot.empty) {
      throw new HttpsError("not-found", "No player is linked to this authenticated device");
    }
    if (privateSnapshot.size !== 1) {
      throw new HttpsError("failed-precondition", "Multiple players are linked to this identity");
    }
    const playerId = privateSnapshot.docs[0].id;
    const publicSnapshot = await roomRef.collection("players").doc(playerId).get();
    if (!publicSnapshot.exists) {
      throw new HttpsError("failed-precondition", "Player registration is incomplete");
    }
    const player = publicSnapshot.data();
    return {
      success: true,
      status: "recovered",
      playerId,
      player: {
        name: player.name || "",
        displayName: player.displayName || player.name || "",
        emoji: player.emoji || "",
      },
    };
  };

  const submitAnswer = async (request) => {
    const data = exactInput(request.data, ["roomId", "questionId", "playerId", "selectedIndex"]);
    const roomId = safeId(data.roomId, "roomId");
    const questionId = safeId(data.questionId, "questionId");
    const playerId = safeId(data.playerId, "playerId");
    const selectedIndex = validateSelectedIndex(data.selectedIndex);
    const roomRef = db.doc(`rooms/${roomId}`);
    const playerRef = roomRef.collection("players").doc(playerId);
    const privatePlayerRef = roomRef.collection("playerPrivate").doc(playerId);
    const answerRef = roomRef.collection("answers").doc(`${questionId}_${playerId}`);

    return db.runTransaction(async (transaction) => {
      const [roomSnapshot, playerSnapshot, privatePlayerSnapshot, answerSnapshot] = await Promise.all([
        transaction.get(roomRef),
        transaction.get(playerRef),
        transaction.get(privatePlayerRef),
        transaction.get(answerRef),
      ]);
      if (!roomSnapshot.exists) throw new HttpsError("not-found", "Room not found");
      if (!playerSnapshot.exists) throw new HttpsError("not-found", "Player not found");
      if (!privatePlayerSnapshot.exists) throw new HttpsError("not-found", "Player identity not found");
      requirePlayerOwner(privatePlayerSnapshot.data(), request.auth);
      if (answerSnapshot.exists) {
        throw new HttpsError("already-exists", "An official answer already exists");
      }
      const room = roomSnapshot.data();
      const question = room.currentQuestion;
      if (!question || !sameId(question.questionId || question.id, questionId)) {
        throw new HttpsError("not-found", "Question is not active");
      }
      if (room.stage !== "question" || room.acceptingAnswers !== true) {
        throw new HttpsError("failed-precondition", "Answers are closed");
      }
      const options = Array.isArray(question.options) ? question.options : [];
      if (selectedIndex >= options.length) {
        throw new HttpsError("invalid-argument", "selectedIndex is outside question options");
      }
      const receivedAt = serverTimestamp();
      const receivedAtMs = receivedAt.toMillis();
      const answerStartAtMs = Number(question.answerStartAtMs);
      const answerEndAtMs = Number(question.answerEndAtMs);
      if (
        !Number.isFinite(answerStartAtMs) ||
        !Number.isFinite(answerEndAtMs) ||
        receivedAtMs < answerStartAtMs ||
        receivedAtMs > answerEndAtMs
      ) {
        throw new HttpsError("failed-precondition", "Answers are not open at the server time");
      }
      transaction.create(answerRef, {
        playerId,
        questionId,
        selectedIndex,
        createdAt: receivedAt,
        receivedAtMs,
        source: "submitAnswer",
      });
      return { success: true, status: "received", receivedAtMs };
    });
  };

  const activateJoker = async (request) => {
    const data = exactInput(request.data, ["roomId", "questionId", "playerId"]);
    const roomId = safeId(data.roomId, "roomId");
    const questionId = data.questionId === "next" ? "next" : safeId(data.questionId, "questionId");
    const playerId = safeId(data.playerId, "playerId");
    const roomRef = db.doc(`rooms/${roomId}`);
    const playerRef = roomRef.collection("players").doc(playerId);
    const privatePlayerRef = roomRef.collection("playerPrivate").doc(playerId);

    return db.runTransaction(async (transaction) => {
      const [roomSnapshot, playerSnapshot, privatePlayerSnapshot] = await Promise.all([
        transaction.get(roomRef),
        transaction.get(playerRef),
        transaction.get(privatePlayerRef),
      ]);
      if (!roomSnapshot.exists) throw new HttpsError("not-found", "Room not found");
      if (!playerSnapshot.exists) throw new HttpsError("not-found", "Player not found");
      if (!privatePlayerSnapshot.exists) throw new HttpsError("not-found", "Player identity not found");
      const player = playerSnapshot.data();
      requirePlayerOwner(privatePlayerSnapshot.data(), request.auth);
      const room = roomSnapshot.data();
      const practice = room.practiceMode === true || room.currentQuestion?.isPractice === true;

      if (room.stage === "question") {
        const activeQuestionId = room.currentQuestion?.questionId || room.currentQuestion?.id;
        if (!sameId(activeQuestionId, questionId)) {
          throw new HttpsError("failed-precondition", "Joker question is not active");
        }
        if (room.acceptingAnswers !== true) {
          throw new HttpsError("failed-precondition", "The answer window is not open");
        }
        const nowTimestamp = serverTimestamp();
        const nowMs = nowTimestamp.toMillis();
        if (nowMs > Number(room.currentQuestion?.answerEndAtMs || 0)) {
          throw new HttpsError("failed-precondition", "The question is closed");
        }
        const answerRef = roomRef.collection("answers").doc(`${questionId}_${playerId}`);
        const answerSnapshot = await transaction.get(answerRef);
        if (answerSnapshot.exists) {
          throw new HttpsError("failed-precondition", "Joker cannot be activated after answering");
        }
        if (practice) {
          if (sameId(player.practiceJokerQuestionId, questionId)) {
            return { success: true, status: "already-active", multiplier: 2 };
          }
          transaction.update(playerRef, {
            practicePendingJoker: false,
            practiceJokerQuestionId: questionId,
            practiceJokerTiming: "during",
            practiceJokerMultiplier: 2,
            practiceJokerLockedAt: nowTimestamp,
          });
        } else {
          if (player.jokerUsed === true) {
            if (sameId(player.jokerQuestionId, questionId)) {
              return {
                success: true,
                status: "already-active",
                multiplier: Number(player.jokerMultiplier || 2),
              };
            }
            throw new HttpsError("already-exists", "Joker was already used");
          }
          transaction.update(playerRef, {
            pendingJoker: false,
            jokerUsed: true,
            jokerQuestionId: questionId,
            jokerQuestionNumber: Number(room.currentQuestionIndex || 0) + 1,
            jokerTiming: "during",
            jokerMultiplier: 2,
            jokerLockedAt: nowTimestamp,
          });
        }
        return { success: true, status: "active", multiplier: 2 };
      }

      if (!["registration", "instructions", "practiceComplete", "results"].includes(room.stage)) {
        throw new HttpsError("failed-precondition", "Joker cannot be prepared now");
      }
      if (questionId !== "next") {
        throw new HttpsError("invalid-argument", "Use questionId=next before a question starts");
      }
      if (practice) {
        if (player.practicePendingJoker) {
          return { success: true, status: "already-pending", multiplier: 3 };
        }
        transaction.update(playerRef, {
          practicePendingJoker: true,
          practiceJokerQuestionId: null,
          practiceJokerTiming: "before",
          practiceJokerMultiplier: 3,
          practiceJokerLockedAt: null,
        });
      } else {
        if (player.jokerUsed === true) throw new HttpsError("already-exists", "Joker was already used");
        if (player.pendingJoker) {
          return { success: true, status: "already-pending", multiplier: 3 };
        }
        transaction.update(playerRef, {
          pendingJoker: true,
          jokerTiming: "before",
          jokerMultiplier: 3,
        });
      }
      return { success: true, status: "pending", multiplier: 3 };
    });
  };

  const cancelJoker = async (request) => {
    const data = exactInput(request.data, ["roomId", "playerId"]);
    const roomId = safeId(data.roomId, "roomId");
    const playerId = safeId(data.playerId, "playerId");
    const roomRef = db.doc(`rooms/${roomId}`);
    const playerRef = roomRef.collection("players").doc(playerId);
    const privatePlayerRef = roomRef.collection("playerPrivate").doc(playerId);
    return db.runTransaction(async (transaction) => {
      const [roomSnapshot, playerSnapshot, privatePlayerSnapshot] = await Promise.all([
        transaction.get(roomRef),
        transaction.get(playerRef),
        transaction.get(privatePlayerRef),
      ]);
      if (!roomSnapshot.exists) throw new HttpsError("not-found", "Room not found");
      if (!playerSnapshot.exists) throw new HttpsError("not-found", "Player not found");
      if (!privatePlayerSnapshot.exists) throw new HttpsError("not-found", "Player identity not found");
      const player = playerSnapshot.data();
      requirePlayerOwner(privatePlayerSnapshot.data(), request.auth);
      const room = roomSnapshot.data();
      if (room.stage === "question" || room.stage === "reveal") {
        throw new HttpsError("failed-precondition", "Joker cannot be cancelled after question start");
      }
      const practice = room.practiceMode === true;
      if (practice) {
        if (!player.practicePendingJoker) return { success: true, status: "already-cancelled" };
        transaction.update(playerRef, {
          practicePendingJoker: false,
          practiceJokerQuestionId: null,
          practiceJokerTiming: null,
          practiceJokerMultiplier: null,
          practiceJokerLockedAt: null,
        });
      } else {
        if (player.jokerUsed === true) {
          throw new HttpsError("failed-precondition", "A used joker cannot be restored");
        }
        if (!player.pendingJoker) return { success: true, status: "already-cancelled" };
        transaction.update(playerRef, {
          pendingJoker: false,
          jokerTiming: null,
          jokerMultiplier: null,
        });
      }
      return { success: true, status: "cancelled" };
    });
  };

  const prepareQuestion = async (request) => {
    const adminUid = requireAdmin(request.auth);
    const data = exactInput(
      request.data,
      ["roomId", "questionId", "questionIndex"],
      ["selectedCategory"]
    );
    const roomId = safeId(data.roomId, "roomId");
    const questionId = safeId(data.questionId, "questionId");
    if (!Number.isInteger(data.questionIndex) || data.questionIndex < 0) {
      throw new HttpsError("invalid-argument", "questionIndex must be a non-negative integer");
    }
    const roomRef = db.doc(`rooms/${roomId}`);
    const questionRef = roomRef.collection("questions").doc(questionId);
    const secretRef = roomRef.collection("questionSecrets").doc(questionId);
    return db.runTransaction(async (transaction) => {
      const [roomSnapshot, questionSnapshot, questionsSnapshot] = await Promise.all([
        transaction.get(roomRef),
        transaction.get(questionRef),
        transaction.get(roomRef.collection("questions")),
      ]);
      if (!roomSnapshot.exists) throw new HttpsError("not-found", "Room not found");
      if (!questionSnapshot.exists) throw new HttpsError("not-found", "Question not found");
      const room = roomSnapshot.data();
      const currentId = room.currentQuestion?.questionId || room.currentQuestion?.id;
      if (room.stage === "ready" && sameId(currentId, questionId)) {
        return { success: true, status: "already-prepared", readyUntilMs: room.nextQuestionReadyUntilMs };
      }
      if (room.stage === "question") {
        throw new HttpsError("failed-precondition", "Another question is active");
      }
      const { publicQuestion, secret } = publicQuestionData(
        questionSnapshot.data(),
        questionId,
        data.selectedCategory || null
      );
      const activePackageId = questionSnapshot.data().packageId || "default";
      const totalQuestions = questionsSnapshot.docs.filter((document) => {
        const candidate = document.data();
        return (
          (candidate.packageId || "default") === activePackageId &&
          (candidate.isPractice === true) === (secret.isPractice === true)
        );
      }).length;
      const preparedAt = serverTimestamp();
      const preparedAtMs = preparedAt.toMillis();
      const readyUntilMs = preparedAtMs + 3000;
      transaction.set(secretRef, {
        ...secret,
        preparedBy: adminUid,
        preparedAt,
      });
      transaction.set(
        roomRef,
        {
          stage: "ready",
          currentQuestion: {
            ...publicQuestion,
            questionStartedAt: null,
            questionStartedAtMs: null,
            answerRevealAtMs: null,
            answerStartAtMs: null,
            answerEndAtMs: null,
          },
          currentQuestionIndex: data.questionIndex,
          totalQuestions,
          hasNextQuestion: data.questionIndex < totalQuestions - 1,
          activeQuestionId: questionId,
          acceptingAnswers: false,
          questionSentAt: null,
          questionStartedAt: null,
          questionStartedAtMs: null,
          answerRevealAtMs: null,
          answerStartAtMs: null,
          answerEndAtMs: null,
          nextQuestionReadyUntilMs: readyUntilMs,
          nextQuestionReadyQuestionIndex: data.questionIndex,
          processedQuestionId: null,
          resultsCalculated: false,
          resultsCalculatedQuestionId: null,
          processingQuestionId: null,
          processingStartedAtMs: null,
          collectingBonusByPlayer: {},
          collectingBonusJokerByPlayer: {},
          rankMovementByPlayer: {},
          resultsDisplaySnapshot: null,
          calculationStatus: null,
          categoryVote: null,
          [`usedQuestionIds.${questionId}`]: true,
          stageStartedAtMs: preparedAtMs,
          readyStartedAtMs: preparedAtMs,
          updatedAt: preparedAt,
        },
        { merge: true }
      );
      return { success: true, status: "prepared", readyUntilMs };
    });
  };

  const startQuestion = async (request) => {
    requireAdmin(request.auth);
    const data = exactInput(request.data, ["roomId", "questionId"]);
    const roomId = safeId(data.roomId, "roomId");
    const questionId = safeId(data.questionId, "questionId");
    const roomRef = db.doc(`rooms/${roomId}`);
    const secretRef = roomRef.collection("questionSecrets").doc(questionId);
    const playersQuery = roomRef.collection("players");
    return db.runTransaction(async (transaction) => {
      const [roomSnapshot, secretSnapshot, playersSnapshot] = await Promise.all([
        transaction.get(roomRef),
        transaction.get(secretRef),
        transaction.get(playersQuery),
      ]);
      if (playersSnapshot.size > MAX_PLAYERS) {
        throw new HttpsError(
          "failed-precondition",
          `Question start supports at most ${MAX_PLAYERS} players`
        );
      }
      if (!roomSnapshot.exists) throw new HttpsError("not-found", "Room not found");
      if (!secretSnapshot.exists) throw new HttpsError("not-found", "Question secret not found");
      const room = roomSnapshot.data();
      const currentId = room.currentQuestion?.questionId || room.currentQuestion?.id;
      if (room.stage === "question" && sameId(currentId, questionId)) {
        return { success: true, status: "already-started", questionStartedAtMs: room.questionStartedAtMs };
      }
      if (room.stage === "question" && !sameId(currentId, questionId)) {
        throw new HttpsError("failed-precondition", "A different question is active");
      }
      if (room.stage !== "ready" || !sameId(currentId, questionId)) {
        throw new HttpsError("failed-precondition", "Question is not prepared");
      }
      const secret = secretSnapshot.data();
      const startedAt = serverTimestamp();
      const startedAtMs = startedAt.toMillis();
      const media = secret.type === "audio" || secret.type === "video";
      const revealDelayMs = Math.max(0, Number(secret.answerRevealDelaySeconds || 0) * 1000);
      const answerStartAtMs = media ? null : startedAtMs + revealDelayMs;
      const answerEndAtMs = answerStartAtMs === null
        ? null
        : answerStartAtMs + Number(secret.seconds) * 1000;

      for (const playerDocument of playersSnapshot.docs) {
        const player = playerDocument.data();
        if (player.isVisitorOnly) continue;
        if (secret.isPractice && player.practicePendingJoker) {
          transaction.update(playerDocument.ref, {
            practicePendingJoker: false,
            practiceJokerQuestionId: questionId,
            practiceJokerTiming: "before",
            practiceJokerMultiplier: 3,
            practiceJokerLockedAt: startedAt,
          });
        } else if (!secret.isPractice && player.pendingJoker && player.jokerUsed !== true) {
          transaction.update(playerDocument.ref, {
            pendingJoker: false,
            jokerUsed: true,
            jokerQuestionId: questionId,
            jokerQuestionNumber: Number(room.currentQuestionIndex || 0) + 1,
            jokerTiming: "before",
            jokerMultiplier: 3,
            jokerLockedAt: startedAt,
          });
        }
      }
      transaction.set(
        secretRef,
        { answerStartAtMs, answerEndAtMs, questionStartedAtMs: startedAtMs, startedAt },
        { merge: true }
      );
      transaction.set(
        roomRef,
        {
          stage: "question",
          activeQuestionId: questionId,
          acceptingAnswers: !media,
          questionSentAt: startedAt,
          questionStartedAt: startedAt,
          questionStartedAtMs: startedAtMs,
          answerRevealAtMs: answerStartAtMs,
          answerStartAtMs,
          answerEndAtMs,
          currentQuestion: {
            ...room.currentQuestion,
            questionStartedAt: startedAt,
            questionStartedAtMs: startedAtMs,
            sentAtMs: startedAtMs,
            answerRevealAtMs: answerStartAtMs,
            answerStartAtMs,
            answerEndAtMs,
          },
          nextQuestionReadyUntilMs: null,
          nextQuestionReadyQuestionIndex: null,
          stageStartedAtMs: startedAtMs,
          questionStageStartedAtMs: startedAtMs,
          revealStartedAtMs: null,
          resultsStartedAtMs: null,
          updatedAt: startedAt,
        },
        { merge: true }
      );
      return { success: true, status: "started", questionStartedAtMs: startedAtMs };
    });
  };

  const controlQuestion = async (request) => {
    requireAdmin(request.auth);
    const data = exactInput(request.data, ["roomId", "questionId", "action"], ["seconds"]);
    const roomId = safeId(data.roomId, "roomId");
    const questionId = safeId(data.questionId, "questionId");
    const allowedActions = new Set(["reveal", "extend", "media-start", "media-finish"]);
    if (!allowedActions.has(data.action)) {
      throw new HttpsError("invalid-argument", "Unsupported question action");
    }
    const roomRef = db.doc(`rooms/${roomId}`);
    const secretRef = roomRef.collection("questionSecrets").doc(questionId);
    return db.runTransaction(async (transaction) => {
      const [roomSnapshot, secretSnapshot] = await Promise.all([
        transaction.get(roomRef),
        transaction.get(secretRef),
      ]);
      if (!roomSnapshot.exists) throw new HttpsError("not-found", "Room not found");
      if (!secretSnapshot.exists) throw new HttpsError("not-found", "Question secret not found");
      const room = roomSnapshot.data();
      const secret = secretSnapshot.data();
      const currentId = room.currentQuestion?.questionId || room.currentQuestion?.id;
      if (!sameId(currentId, questionId)) {
        throw new HttpsError("failed-precondition", "Question is not active");
      }
      const changedAt = serverTimestamp();
      const changedAtMs = changedAt.toMillis();

      if (data.action === "reveal") {
        if (room.stage === "reveal") return { success: true, status: "already-revealed" };
        if (room.stage !== "question") {
          throw new HttpsError("failed-precondition", "Question cannot be revealed");
        }
        transaction.set(
          roomRef,
          {
            stage: "reveal",
            acceptingAnswers: false,
            answerEndAtMs: Math.min(Number(room.answerEndAtMs || changedAtMs), changedAtMs),
            currentQuestion: {
              ...room.currentQuestion,
              correctIndex: secret.correctIndex,
              answerEndAtMs: Math.min(
                Number(room.currentQuestion?.answerEndAtMs || changedAtMs),
                changedAtMs
              ),
            },
            stageStartedAtMs: changedAtMs,
            revealStartedAtMs: changedAtMs,
            revealUndoUntilMs: null,
            updatedAt: changedAt,
          },
          { merge: true }
        );
        return { success: true, status: "revealed" };
      }

      if (room.stage !== "question") {
        throw new HttpsError("failed-precondition", "Question is not open");
      }
      if (data.action === "extend") {
        if (!Number.isInteger(data.seconds) || data.seconds < 1 || data.seconds > 60) {
          throw new HttpsError("invalid-argument", "seconds must be between 1 and 60");
        }
        const answerEndAtMs = Number(room.currentQuestion?.answerEndAtMs || room.answerEndAtMs);
        if (!Number.isFinite(answerEndAtMs)) {
          throw new HttpsError("failed-precondition", "Answer timing is not active");
        }
        const nextEndAtMs = answerEndAtMs + data.seconds * 1000;
        transaction.set(
          secretRef,
          { answerEndAtMs: nextEndAtMs },
          { merge: true }
        );
        transaction.set(
          roomRef,
          {
            answerEndAtMs: nextEndAtMs,
            currentQuestion: { ...room.currentQuestion, answerEndAtMs: nextEndAtMs },
            updatedAt: changedAt,
          },
          { merge: true }
        );
        return { success: true, status: "extended", answerEndAtMs: nextEndAtMs };
      }
      if (data.action === "media-start") {
        transaction.set(
          roomRef,
          {
            mediaStartedAt: changedAt,
            audioStartedAt: changedAt,
            currentQuestion: { ...room.currentQuestion, mediaStartedAtMs: changedAtMs },
            updatedAt: changedAt,
          },
          { merge: true }
        );
        return { success: true, status: "media-started" };
      }
      const revealDelayMs = Math.max(0, Number(secret.answerRevealDelaySeconds || 0) * 1000);
      const answerStartAtMs = changedAtMs + revealDelayMs;
      const answerEndAtMs = answerStartAtMs + Number(secret.seconds) * 1000;
      transaction.set(
        secretRef,
        { answerStartAtMs, answerEndAtMs },
        { merge: true }
      );
      transaction.set(
        roomRef,
        {
          mediaEndedAt: changedAt,
          audioEndedAt: changedAt,
          answerRevealAtMs: answerStartAtMs,
          answerStartAtMs,
          answerEndAtMs,
          acceptingAnswers: true,
          currentQuestion: {
            ...room.currentQuestion,
            mediaEndedAtMs: changedAtMs,
            answerRevealAtMs: answerStartAtMs,
            answerStartAtMs,
            answerEndAtMs,
          },
          updatedAt: changedAt,
        },
        { merge: true }
      );
      return { success: true, status: "media-finished", answerStartAtMs, answerEndAtMs };
    });
  };

  const getPlayerPrivateDetails = async (request) => {
    requireAdmin(request.auth);
    const data = exactInput(request.data, ["roomId", "playerId"]);
    const roomId = safeId(data.roomId, "roomId");
    const playerId = safeId(data.playerId, "playerId");
    const privateSnapshot = await db.doc(
      `rooms/${roomId}/playerPrivate/${playerId}`
    ).get();
    if (!privateSnapshot.exists) {
      throw new HttpsError("not-found", "Player private details not found");
    }
    const privatePlayer = privateSnapshot.data();
    return {
      success: true,
      playerId,
      details: {
        fullName: privatePlayer.fullName || "",
        phone: privatePlayer.phoneNormalized || "",
      },
    };
  };

  const updatePlayerProfile = async (request) => {
    const uid = requireAuthenticated(request.auth);
    const data = exactInput(
      request.data,
      ["roomId", "playerId"],
      ["name", "emoji", "fullName", "phone"]
    );
    const roomId = safeId(data.roomId, "roomId");
    const playerId = safeId(data.playerId, "playerId");
    const isAdminRequest = request.auth?.token?.admin === true;
    const roomRef = db.doc(`rooms/${roomId}`);
    const playerRef = roomRef.collection("players").doc(playerId);
    const privatePlayerRef = roomRef.collection("playerPrivate").doc(playerId);
    const registrationKeysRef = roomRef.collection("playerRegistrationKeys");

    return db.runTransaction(async (transaction) => {
      const [playerSnapshot, privatePlayerSnapshot] = await Promise.all([
        transaction.get(playerRef),
        transaction.get(privatePlayerRef),
      ]);
      if (!playerSnapshot.exists || !privatePlayerSnapshot.exists) {
        throw new HttpsError("not-found", "Player not found");
      }
      if (!isAdminRequest) {
        requirePlayerOwner(privatePlayerSnapshot.data(), request.auth);
      } else if (!uid) {
        throw new HttpsError("unauthenticated", "Authentication is required");
      }

      const publicUpdates = {};
      const privateUpdates = {};
      const keyChanges = [];
      if (data.name !== undefined) {
        const name = String(data.name || "").trim();
        if (name.length < 1 || name.length > 40) {
          throw new HttpsError("invalid-argument", "Player display name is invalid");
        }
        const oldName = playerSnapshot.data().name || "";
        const newNameKeyRef = registrationKeysRef.doc(registrationKeyId("name", name));
        const newNameKey = await transaction.get(newNameKeyRef);
        if (newNameKey.exists && newNameKey.data().playerId !== playerId) {
          throw new HttpsError("already-exists", "Player display name is already registered");
        }
        if (name !== oldName) {
          keyChanges.push({
            oldRef: registrationKeysRef.doc(registrationKeyId("name", oldName)),
            newRef: newNameKeyRef,
            type: "name",
          });
        }
        publicUpdates.name = name;
        publicUpdates.displayName = name;
      }
      if (data.emoji !== undefined) {
        publicUpdates.emoji = String(data.emoji || "").trim().slice(0, 8);
      }
      if (data.fullName !== undefined) {
        const normalized = normalizeRecoveryName(data.fullName);
        privateUpdates.fullName = normalized.fullName;
        privateUpdates.recoveryNameNormalized = normalized.recoveryNameNormalized;
      }
      if (data.phone !== undefined) {
        const phoneNormalized = normalizePhone(data.phone);
        const oldPhone = privatePlayerSnapshot.data().phoneNormalized || "";
        const newPhoneKeyRef = registrationKeysRef.doc(
          registrationKeyId("phone", phoneNormalized)
        );
        const newPhoneKey = await transaction.get(newPhoneKeyRef);
        if (newPhoneKey.exists && newPhoneKey.data().playerId !== playerId) {
          throw new HttpsError("already-exists", "Phone is already registered");
        }
        if (phoneNormalized !== oldPhone) {
          keyChanges.push({
            oldRef: registrationKeysRef.doc(registrationKeyId("phone", oldPhone)),
            newRef: newPhoneKeyRef,
            type: "phone",
          });
        }
        privateUpdates.phoneNormalized = phoneNormalized;
      }
      if (!Object.keys(publicUpdates).length && !Object.keys(privateUpdates).length) {
        throw new HttpsError("invalid-argument", "No profile fields were provided");
      }
      const updatedAt = serverTimestamp();
      if (Object.keys(publicUpdates).length) {
        transaction.update(playerRef, { ...publicUpdates, updatedAt });
      }
      if (Object.keys(privateUpdates).length) {
        transaction.update(privatePlayerRef, { ...privateUpdates, updatedAt });
      }
      for (const change of keyChanges) {
        transaction.delete(change.oldRef);
        transaction.set(change.newRef, {
          type: change.type,
          playerId,
          createdAt: updatedAt,
        });
      }
      return {
        success: true,
        status: "updated",
        playerId,
        player: {
          name: publicUpdates.name || playerSnapshot.data().name || "",
          displayName:
            publicUpdates.displayName ||
            playerSnapshot.data().displayName ||
            playerSnapshot.data().name ||
            "",
          emoji:
            publicUpdates.emoji === undefined
              ? playerSnapshot.data().emoji || ""
              : publicUpdates.emoji,
        },
      };
    });
  };

  const deletePlayer = async (request) => {
    const adminUid = requireAdmin(request.auth);
    const data = exactInput(request.data, ["roomId", "playerId", "reason"]);
    const roomId = safeId(data.roomId, "roomId");
    const playerId = safeId(data.playerId, "playerId");
    const reason = String(data.reason || "").trim();
    if (reason.length < 3 || reason.length > 200) {
      throw new HttpsError("invalid-argument", "reason must contain 3 to 200 characters");
    }
    const roomRef = db.doc(`rooms/${roomId}`);
    const playerRef = roomRef.collection("players").doc(playerId);
    const privatePlayerRef = roomRef.collection("playerPrivate").doc(playerId);
    const auditRef = roomRef.collection("auditLogs").doc();
    return db.runTransaction(async (transaction) => {
      const [playerSnapshot, privatePlayerSnapshot] = await Promise.all([
        transaction.get(playerRef),
        transaction.get(privatePlayerRef),
      ]);
      if (!playerSnapshot.exists && !privatePlayerSnapshot.exists) {
        return { success: true, status: "already-deleted", playerId };
      }
      if (playerSnapshot.exists) transaction.delete(playerRef);
      if (privatePlayerSnapshot.exists) transaction.delete(privatePlayerRef);
      if (playerSnapshot.exists) {
        transaction.delete(
          roomRef
            .collection("playerRegistrationKeys")
            .doc(registrationKeyId("name", playerSnapshot.data().name || ""))
        );
      }
      if (privatePlayerSnapshot.exists) {
        const privatePlayer = privatePlayerSnapshot.data();
        transaction.delete(
          roomRef
            .collection("playerRegistrationKeys")
            .doc(registrationKeyId("uid", privatePlayer.authUid || ""))
        );
        transaction.delete(
          roomRef
            .collection("playerRegistrationKeys")
            .doc(registrationKeyId("phone", privatePlayer.phoneNormalized || ""))
        );
      }
      transaction.create(auditRef, {
        type: "delete-player",
        adminUid,
        targetId: playerId,
        playerId,
        reason,
        runId: runId(),
        createdAt: serverTimestamp(),
      });
      return { success: true, status: "deleted", playerId };
    });
  };

  const adjustPlayerScore = async (request) => {
    const adminUid = requireAdmin(request.auth);
    const { roomId, playerId, delta, reason } = validateScoreAdjustment(request.data);
    const roomRef = db.doc(`rooms/${roomId}`);
    const playerRef = roomRef.collection("players").doc(playerId);
    const auditRef = roomRef.collection("auditLogs").doc();
    return db.runTransaction(async (transaction) => {
      const [roomSnapshot, playerSnapshot, playersSnapshot] = await Promise.all([
        transaction.get(roomRef),
        transaction.get(playerRef),
        transaction.get(roomRef.collection("players")),
      ]);
      if (playersSnapshot.size > MAX_PLAYERS) {
        throw new HttpsError(
          "failed-precondition",
          `Score adjustment supports at most ${MAX_PLAYERS} players`
        );
      }
      if (!roomSnapshot.exists) throw new HttpsError("not-found", "Room not found");
      if (!playerSnapshot.exists) throw new HttpsError("not-found", "Player not found");
      const player = playerSnapshot.data();
      const beforePoints = Number(player.score || 0);
      const afterPoints = beforePoints + delta;
      const adjustedPlayers = playersSnapshot.docs
        .filter((item) => !item.data().isVisitorOnly)
        .map((item) => ({
          id: item.id,
          ref: item.ref,
          score: item.id === playerId ? afterPoints : Number(item.data().score || 0),
        }))
        .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id));
      adjustedPlayers.forEach((item, index) => {
        transaction.update(item.ref, {
          ...(item.id === playerId
            ? {
                score: afterPoints,
                manualScoreBaseline:
                  Number(player.manualScoreDelta || 0) === 0
                    ? beforePoints
                    : Number(player.manualScoreBaseline || beforePoints),
                manualScoreDelta: Number(player.manualScoreDelta || 0) + delta,
                manualScoreAdjustedAt: serverTimestamp(),
              }
            : {}),
          rank: index + 1,
        });
      });
      const operationRunId = runId();
      transaction.create(auditRef, {
        type: "adjust-player-score",
        adminUid,
        targetId: playerId,
        playerId,
        delta,
        beforePoints,
        afterPoints,
        reason,
        runId: operationRunId,
        createdAt: serverTimestamp(),
      });
      return {
        success: true,
        status: "adjusted",
        beforePoints,
        afterPoints,
        runId: operationRunId,
      };
    });
  };

  const resetPracticeScores = async (request) => {
    const adminUid = requireAdmin(request.auth);
    const data = exactInput(request.data, ["roomId", "reason"]);
    const roomId = safeId(data.roomId, "roomId");
    const reason = String(data.reason || "").trim();
    if (reason.length < 3 || reason.length > 200) {
      throw new HttpsError("invalid-argument", "reason must contain 3 to 200 characters");
    }
    const roomRef = db.doc(`rooms/${roomId}`);
    const auditRef = roomRef.collection("auditLogs").doc();
    return db.runTransaction(async (transaction) => {
      const [roomSnapshot, playersSnapshot] = await Promise.all([
        transaction.get(roomRef),
        transaction.get(roomRef.collection("players")),
      ]);
      if (!roomSnapshot.exists) throw new HttpsError("not-found", "Room not found");
      const room = roomSnapshot.data();
      if (room.stage === "practiceComplete") {
        return { success: true, status: "already-reset" };
      }
      if (
        room.practiceMode !== true ||
        room.stage !== "results" ||
        !sameId(room.processedQuestionId, room.currentQuestion?.questionId || room.currentQuestion?.id)
      ) {
        throw new HttpsError("failed-precondition", "Practice must be finalized before reset");
      }
      if (playersSnapshot.size > MAX_PLAYERS) {
        throw new HttpsError("failed-precondition", "Too many players for atomic practice reset");
      }
      for (const playerDocument of playersSnapshot.docs) {
        if (playerDocument.data().isVisitorOnly) continue;
        transaction.update(playerDocument.ref, {
          score: 0,
          rank: null,
          answeredCount: 0,
          lastQuestionPoints: 0,
          lastQuestionId: null,
          lastQuestionCorrect: null,
          manualScoreDelta: 0,
          manualScoreBaseline: 0,
          practicePendingJoker: false,
          practiceJokerQuestionId: null,
          practiceJokerTiming: null,
          practiceJokerMultiplier: null,
          practiceJokerLockedAt: null,
        });
      }
      const operationRunId = runId();
      transaction.set(
        roomRef,
        {
          stage: "practiceComplete",
          practiceMode: false,
          practiceFinished: true,
          currentQuestion: null,
          currentQuestionIndex: -1,
          activeQuestionId: null,
          acceptingAnswers: false,
          processedQuestionId: null,
          registrationOverrideOpen: false,
          updatedAt: serverTimestamp(),
        },
        { merge: true }
      );
      transaction.create(auditRef, {
        type: "reset-practice-scores",
        adminUid,
        targetId: roomId,
        reason,
        runId: operationRunId,
        playerCount: playersSnapshot.docs.filter((item) => !item.data().isVisitorOnly).length,
        createdAt: serverTimestamp(),
      });
      return { success: true, status: "reset", runId: operationRunId };
    });
  };

  const resetQuizData = async (request) => {
    const adminUid = requireAdmin(request.auth);
    const data = exactInput(request.data, ["roomId", "mode", "reason"]);
    const roomId = safeId(data.roomId, "roomId");
    const mode = String(data.mode || "");
    const reason = String(data.reason || "").trim();
    if (!["full", "answers-messages", "messages"].includes(mode)) {
      throw new HttpsError("invalid-argument", "mode is invalid");
    }
    if (reason.length < 3 || reason.length > 200) {
      throw new HttpsError("invalid-argument", "reason must contain 3 to 200 characters");
    }
    const roomRef = db.doc(`rooms/${roomId}`);
    const roomSnapshot = await roomRef.get();
    if (!roomSnapshot.exists) throw new HttpsError("not-found", "Room not found");
    if (["question", "reveal"].includes(roomSnapshot.data().stage)) {
      throw new HttpsError("failed-precondition", "Quiz data cannot be reset during an active question");
    }
    const collectionNames =
      mode === "full"
        ? ["players", "playerPrivate", "playerRegistrationKeys", "visitors", "answers", "messages"]
        : mode === "messages"
          ? ["messages"]
          : ["answers", "messages"];
    const snapshots = await Promise.all(
      collectionNames.map((name) => roomRef.collection(name).get())
    );
    const writer = db.bulkWriter();
    let deletedCount = 0;
    for (const snapshot of snapshots) {
      for (const document of snapshot.docs) {
        writer.delete(document.ref);
        deletedCount += 1;
      }
    }
    await writer.close();
    const operationRunId = runId();
    await roomRef.collection("auditLogs").doc().create({
      type: "reset-quiz-data",
      adminUid,
      targetId: roomId,
      mode,
      reason,
      runId: operationRunId,
      deletedCount,
      createdAt: serverTimestamp(),
    });
    return { success: true, status: "reset", mode, deletedCount, runId: operationRunId };
  };

  return {
    activateJoker,
    adjustPlayerScore,
    cancelJoker,
    controlQuestion,
    deletePlayer,
    getPlayerPrivateDetails,
    initializeQuiz,
    prepareQuestion,
    recoverPlayer,
    registerPlayer,
    resetPracticeScores,
    resetQuizData,
    startQuestion,
    submitAnswer,
    updatePlayerProfile,
  };
}

module.exports = { createSecureWriteHandlers, MAX_PLAYERS, QUIZ_INITIALIZATION };
