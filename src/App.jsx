import React, { useEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { initializeApp } from "firebase/app";
import {
  getFirestore,
  doc,
  setDoc,
  updateDoc,
  onSnapshot,
  collection,
  addDoc,
  getDocs,
  query,
  where,
  serverTimestamp,
  deleteDoc,
} from "firebase/firestore";
import "./App.css";

const firebaseConfig = {
  apiKey: "AIzaSyAMLo_Y6QnuyHfB-_XfFFcHmnun-sO4Mvc",
  authDomain: "family-quiz-b7960.firebaseapp.com",
  projectId: "family-quiz-b7960",
  storageBucket: "family-quiz-b7960.firebasestorage.app",
  messagingSenderId: "1002819143902",
  appId: "1:1002819143902:web:bc2b9becf69945d7485a4f",
  measurementId: "G-X2T4CPDNM0",
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

const ROOM_ID = "family-quiz-001";
const ADMIN_CODE = "1234";

const QUIZ_TITLE = "مسابقة عائلة المطرود";
const QUIZ_SUBTITLE = "من تقديم الأستاذ إبراهيم ال مطرود";

const REVEAL_OPTIONS_DELAY_MS = 3000;
const MEDIA_REVEAL_OPTIONS_DELAY_MS = 5000;
const SCORE_REVEAL_STEP_MS = 1300;
const SCORE_ANIMATION_HOLD_MS = 1400;

function getNow() {
  return Date.now();
}

function useNow(interval = 250) {
  const [now, setNow] = useState(getNow());

  useEffect(() => {
    const timer = setInterval(() => setNow(getNow()), interval);
    return () => clearInterval(timer);
  }, [interval]);

  return now;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function toMillis(value) {
  if (!value) return null;
  if (typeof value === "number") return value;
  if (typeof value.toMillis === "function") return value.toMillis();
  return null;
}

function getServerNow(room, localNow = getNow()) {
  return localNow - (room?.__serverOffsetMs || 0);
}

function getQuestionSentAt(room, question) {
  return (
    toMillis(room?.questionSentAt) ||
    toMillis(room?.updatedAt) ||
    question?.fallbackSentAt ||
    getNow()
  );
}

function isMediaQuestion(question) {
  return question?.type === "audio" || question?.type === "video";
}

function getQuestionMediaUrl(question) {
  return question?.mediaUrl || question?.audioUrl || question?.videoUrl || "";
}

function getQuestionTypeLabel(type) {
  if (type === "audio") return "سؤال صوتي";
  if (type === "video") return "سؤال فيديو";
  if (type === "image") return "سؤال صورة";
  if (type === "true_false") return "صح أو خطأ";
  return "اختيار من متعدد";
}

function getOptionText(option) {
  if (typeof option === "string") return option;
  return option?.text || "";
}

function getOptionImage(option, optionImageUrls = [], index = 0) {
  if (typeof option === "object" && option?.imageUrl) return option.imageUrl;
  return optionImageUrls?.[index] || "";
}

function getQuestionImageUrl(question) {
  return question?.imageUrl || question?.questionImageUrl || "";
}

function getAnswerStartAt(room, question) {
  if (isMediaQuestion(question)) {
    const mediaEndedAt =
      toMillis(room?.mediaEndedAt) ||
      toMillis(room?.audioEndedAt) ||
      question?.fallbackMediaEndedAt ||
      question?.fallbackAudioEndedAt ||
      null;

    if (!mediaEndedAt) return null;

    return mediaEndedAt + MEDIA_REVEAL_OPTIONS_DELAY_MS;
  }

  return getQuestionSentAt(room, question) + REVEAL_OPTIONS_DELAY_MS;
}

function getQuestionTimeLeft(question, room, localNow) {
  if (!question) return 0;

  const serverNow = getServerNow(room, localNow);
  const answerStartAt = getAnswerStartAt(room, question);

  if (!answerStartAt) return Number(question.seconds || 20);

  const seconds = Number(question.seconds || 20);
  const endAt = answerStartAt + seconds * 1000;

  return Math.max(0, Math.ceil((endAt - serverNow) / 1000));
}

function getRevealCountdown(question, room, localNow) {
  if (!question) return 0;

  const serverNow = getServerNow(room, localNow);
  const answerStartAt = getAnswerStartAt(room, question);

  if (!answerStartAt) {
    return isMediaQuestion(question) ? null : 0;
  }

  return Math.max(0, Math.ceil((answerStartAt - serverNow) / 1000));
}

function getPointsProgressPercent(question, room, localNow) {
  if (!question) return 0;

  const seconds = Number(question.seconds || 20);
  const serverNow = getServerNow(room, localNow);
  const answerStartAt = getAnswerStartAt(room, question);

  if (!answerStartAt) return 100;

  const elapsed = Math.max(0, serverNow - answerStartAt) / 1000;

  return clamp(((seconds - elapsed) / seconds) * 100, 0, 100);
}

function calculateBasePoints({ question, room, answeredAt }) {
  const maxPoints = Number(question.maxPoints || 1000);
  const minPoints = Number(question.minPoints || 100);
  const seconds = Number(question.seconds || 20);

  const answeredAtServer = getServerNow(room, answeredAt);
  const answerStartAt = getAnswerStartAt(room, question);

  if (!answerStartAt) return maxPoints;

  const elapsed = Math.max(0, answeredAtServer - answerStartAt) / 1000;
  const ratio = clamp((seconds - elapsed) / seconds, 0, 1);

  return Math.round(minPoints + ratio * (maxPoints - minPoints));
}

function calculateFinalPoints({ isCorrect, basePoints, jokerApplied }) {
  if (jokerApplied) {
    return isCorrect ? basePoints * 3 : -basePoints;
  }

  return isCorrect ? basePoints : 0;
}

/* Hooks */

function useRoom() {
  const [room, setRoom] = useState(null);

  useEffect(() => {
    const unsub = onSnapshot(doc(db, "rooms", ROOM_ID), (snap) => {
      if (!snap.exists()) {
        setRoom(null);
        return;
      }

      const data = snap.data();
      const updatedAtMs =
        toMillis(data.updatedAt) ||
        toMillis(data.mediaEndedAt) ||
        toMillis(data.mediaStartedAt) ||
        toMillis(data.audioStartedAt) ||
        toMillis(data.questionSentAt);

      const serverOffsetMs = updatedAtMs ? Date.now() - updatedAtMs : 0;

      setRoom({
        ...data,
        __serverOffsetMs: serverOffsetMs,
      });
    });

    return () => unsub();
  }, []);

  return room;
}

function usePlayers() {
  const [players, setPlayers] = useState([]);

  useEffect(() => {
    const unsub = onSnapshot(
      collection(db, "rooms", ROOM_ID, "players"),
      (snap) => {
        const list = snap.docs.map((d) => ({
          id: d.id,
          ...d.data(),
        }));

        list.sort((a, b) => (b.score || 0) - (a.score || 0));
        setPlayers(list);
      }
    );

    return () => unsub();
  }, []);

  return players;
}

function useQuestions() {
  const [questions, setQuestions] = useState([]);

  useEffect(() => {
    const unsub = onSnapshot(
      collection(db, "rooms", ROOM_ID, "questions"),
      (snap) => {
        const list = snap.docs.map((d) => ({
          id: d.id,
          ...d.data(),
        }));

        list.sort((a, b) => (a.order || 0) - (b.order || 0));
        setQuestions(list);
      }
    );

    return () => unsub();
  }, []);

  return questions;
}

function useAnswers(questionId) {
  const [answers, setAnswers] = useState([]);

  useEffect(() => {
    if (!questionId) {
      setAnswers([]);
      return;
    }

    const answersQuery = query(
      collection(db, "rooms", ROOM_ID, "answers"),
      where("questionId", "==", questionId)
    );

    const unsub = onSnapshot(answersQuery, (snap) => {
      setAnswers(
        snap.docs.map((d) => ({
          id: d.id,
          ...d.data(),
        }))
      );
    });

    return () => unsub();
  }, [questionId]);

  return answers;
}

function useAllAnswers() {
  const [answers, setAnswers] = useState([]);

  useEffect(() => {
    const unsub = onSnapshot(
      collection(db, "rooms", ROOM_ID, "answers"),
      (snap) => {
        setAnswers(
          snap.docs.map((d) => ({
            id: d.id,
            ...d.data(),
          }))
        );
      }
    );

    return () => unsub();
  }, []);

  return answers;
}

function useMessages() {
  const [messages, setMessages] = useState([]);

  useEffect(() => {
    const unsub = onSnapshot(
      collection(db, "rooms", ROOM_ID, "messages"),
      (snap) => {
        const list = snap.docs.map((d) => ({
          id: d.id,
          ...d.data(),
        }));

        list.sort((a, b) => (b.createdAtMs || 0) - (a.createdAtMs || 0));
        setMessages(list.slice(0, 20));
      }
    );

    return () => unsub();
  }, []);

  return messages;
}

/* Firebase actions */

async function createOrResetRoom() {
  await setDoc(doc(db, "rooms", ROOM_ID), {
    title: QUIZ_TITLE,
    subtitle: QUIZ_SUBTITLE,
    stage: "home",
    currentQuestion: null,
    currentQuestionIndex: -1,
    questionSentAt: null,
    audioStartedAt: null,
    mediaStartedAt: null,
    mediaEndedAt: null,
    questionIgnored: false,
    ignoredQuestionIds: {},
    processedQuestionId: null,
    collectingBonusByPlayer: {},
    collectingBonusJokerByPlayer: {},
    collectingBonusPlayerId: null,
    collectingBonusPoints: 0,
    rankMovementByPlayer: {},
    updatedAt: serverTimestamp(),
  });
}

async function clearCollection(pathSegments) {
  const snap = await getDocs(collection(db, ...pathSegments));
  await Promise.all(snap.docs.map((item) => deleteDoc(item.ref)));
}

async function resetPlayersAnswersMessages() {
  await clearCollection(["rooms", ROOM_ID, "players"]);
  await clearCollection(["rooms", ROOM_ID, "answers"]);
  await clearCollection(["rooms", ROOM_ID, "messages"]);
}

async function hardResetGame() {
  await resetPlayersAnswersMessages();
  await createOrResetRoom();
}

async function resetAndStartRegistration() {
  await resetPlayersAnswersMessages();

  await setDoc(
    doc(db, "rooms", ROOM_ID),
    {
      title: QUIZ_TITLE,
      subtitle: QUIZ_SUBTITLE,
      stage: "registration",
      currentQuestion: null,
      currentQuestionIndex: -1,
      questionSentAt: null,
      audioStartedAt: null,
      mediaStartedAt: null,
      mediaEndedAt: null,
      questionIgnored: false,
      ignoredQuestionIds: {},
      processedQuestionId: null,
      collectingBonusByPlayer: {},
      collectingBonusJokerByPlayer: {},
      collectingBonusPlayerId: null,
      collectingBonusPoints: 0,
      rankMovementByPlayer: {},
    updatedAt: serverTimestamp(),
    },
    { merge: true }
  );
}

async function sendQuestion(question, index) {
  await setDoc(
    doc(db, "rooms", ROOM_ID),
    {
      stage: "question",
      currentQuestion: {
        ...question,
        questionId: question.id,
        fallbackSentAt: getNow(),
        fallbackMediaStartedAt: null,
        fallbackMediaEndedAt: null,
      },
      currentQuestionIndex: index,
      questionSentAt: serverTimestamp(),
      audioStartedAt: null,
      mediaStartedAt: null,
      mediaEndedAt: null,
      questionIgnored: false,
      processedQuestionId: null,
      collectingBonusByPlayer: {},
      collectingBonusJokerByPlayer: {},
      collectingBonusPlayerId: null,
      collectingBonusPoints: 0,
      rankMovementByPlayer: {},
    updatedAt: serverTimestamp(),
    },
    { merge: true }
  );
}

async function startMediaQuestion() {
  const fallbackMediaStartedAt = getNow();

  await updateDoc(doc(db, "rooms", ROOM_ID), {
    mediaStartedAt: serverTimestamp(),
    audioStartedAt: serverTimestamp(),
    "currentQuestion.fallbackMediaStartedAt": fallbackMediaStartedAt,
    updatedAt: serverTimestamp(),
  });
}

async function finishMediaQuestion() {
  const fallbackMediaEndedAt = getNow();

  await updateDoc(doc(db, "rooms", ROOM_ID), {
    mediaEndedAt: serverTimestamp(),
    audioEndedAt: serverTimestamp(),
    "currentQuestion.fallbackMediaEndedAt": fallbackMediaEndedAt,
    updatedAt: serverTimestamp(),
  });
}

async function launchSystemCheck() {
  const ok = window.confirm("هل تريد طرح سؤال: هل كل شي تمام؟ للمتسابقين الآن؟");
  if (!ok) return;

  await setDoc(
    doc(db, "rooms", ROOM_ID),
    {
      healthCheck: {
        id: `check-${getNow()}`,
        active: true,
        question: "هل كل شي تمام؟",
        createdAtMs: getNow(),
      },
      updatedAt: serverTimestamp(),
    },
    { merge: true }
  );
}

async function answerSystemCheck({ playerId, playerName, answerText }) {
  await addDoc(collection(db, "rooms", ROOM_ID, "messages"), {
    playerId,
    playerName,
    text: `فحص النظام: ${answerText}`,
    createdAtMs: getNow(),
    createdAt: serverTimestamp(),
  });
}

async function ignoreCurrentQuestion(questionId, players = []) {
  const roomRef = doc(db, "rooms", ROOM_ID);
  const currentQuestionId = questionId;

  if (currentQuestionId) {
    const jokerPlayers = players.filter(
      (player) => player.jokerQuestionId === currentQuestionId
    );

    await Promise.all(
      jokerPlayers.map((player) =>
        updateDoc(doc(db, "rooms", ROOM_ID, "players", player.id), {
          pendingJoker: false,
          jokerUsed: false,
          jokerQuestionId: null,
          jokerQuestionNumber: null,
        })
      )
    );
  }

  if (currentQuestionId) {
    await updateDoc(roomRef, {
      [`ignoredQuestionIds.${currentQuestionId}`]: true,
    });
  }

  await setDoc(
    roomRef,
    {
      stage: "results",
      questionIgnored: true,
      processedQuestionId: currentQuestionId || null,
      collectingBonusByPlayer: {},
      collectingBonusJokerByPlayer: {},
      collectingBonusPlayerId: null,
      collectingBonusPoints: 0,
      rankMovementByPlayer: {},
      updatedAt: serverTimestamp(),
    },
    { merge: true }
  );
}

async function revealCorrectAnswer() {
  await setDoc(
    doc(db, "rooms", ROOM_ID),
    {
      stage: "reveal",
      updatedAt: serverTimestamp(),
    },
    { merge: true }
  );
}

async function showResults() {
  await setDoc(
    doc(db, "rooms", ROOM_ID),
    {
      stage: "results",
      questionIgnored: false,
      collectingBonusByPlayer: {},
      collectingBonusJokerByPlayer: {},
      collectingBonusPlayerId: null,
      collectingBonusPoints: 0,
      rankMovementByPlayer: {},
    updatedAt: serverTimestamp(),
    },
    { merge: true }
  );
}

async function archiveLastGame(players = [], questions = [], allAnswers = [], messages = []) {
  const sortedPlayers = [...players].sort((a, b) => (b.score || 0) - (a.score || 0));
  await setDoc(
    doc(db, "rooms", ROOM_ID),
    {
      lastGame: {
        savedAtMs: getNow(),
        savedAt: serverTimestamp(),
        players: sortedPlayers.map((player, index) => ({
          rank: index + 1,
          id: player.id,
          name: player.name || "",
          fullName: player.fullName || "",
          phone: player.phone || "",
          score: player.score || 0,
        })),
        questions: questions.map((question, index) => ({
          id: question.id,
          order: index + 1,
          text: question.text || "",
          type: question.type || "multiple_choice",
        })),
        answers: allAnswers.map((answer) => ({ ...answer })),
        messages: messages.map((message) => ({
          playerName: message.playerName || "",
          text: message.text || "",
          createdAtMs: message.createdAtMs || 0,
        })),
      },
    },
    { merge: true }
  );
}

async function finishGame(players = [], questions = [], allAnswers = [], messages = []) {
  await archiveLastGame(players, questions, allAnswers, messages);
  await setDoc(
    doc(db, "rooms", ROOM_ID),
    {
      stage: "finished",
      updatedAt: serverTimestamp(),
    },
    { merge: true }
  );
}


async function goBackOneStep(room, questions = []) {
  if (!room) return;

  const stage = room.stage || "home";
  const index = room.currentQuestionIndex ?? -1;

  if (stage === "finished") {
    await setDoc(
      doc(db, "rooms", ROOM_ID),
      { stage: "results", updatedAt: serverTimestamp() },
      { merge: true }
    );
    return;
  }

  if (stage === "results") {
    await setDoc(
      doc(db, "rooms", ROOM_ID),
      {
        stage: "reveal",
        processedQuestionId: null,
        collectingBonusByPlayer: {},
        collectingBonusJokerByPlayer: {},
        rankMovementByPlayer: {},
        updatedAt: serverTimestamp(),
      },
      { merge: true }
    );
    return;
  }

  if (stage === "reveal") {
    await setDoc(
      doc(db, "rooms", ROOM_ID),
      { stage: "question", updatedAt: serverTimestamp() },
      { merge: true }
    );
    return;
  }

  if (stage === "question") {
    if (index > 0 && questions[index - 1]) {
      await sendQuestion(questions[index - 1], index - 1);
      return;
    }

    await setDoc(
      doc(db, "rooms", ROOM_ID),
      {
        stage: "registration",
        currentQuestion: null,
        currentQuestionIndex: -1,
        questionSentAt: null,
        updatedAt: serverTimestamp(),
      },
      { merge: true }
    );
    return;
  }

  if (stage === "registration") {
    await createOrResetRoom();
  }
}

async function giveJokerToPlayer(playerId) {
  if (!playerId) return;

  await updateDoc(doc(db, "rooms", ROOM_ID, "players", playerId), {
    pendingJoker: false,
    jokerUsed: false,
    jokerQuestionId: null,
    jokerQuestionNumber: null,
    jokerLockedAt: null,
  });
}

async function adjustPlayerScore(player, delta) {
  if (!player?.id || !Number.isFinite(delta) || delta === 0) return;

  await updateDoc(doc(db, "rooms", ROOM_ID, "players", player.id), {
    score: (player.score || 0) + delta,
    manualScoreAdjustedAt: serverTimestamp(),
  });
}

/* Automation */

function AutoRevealCorrectAnswer({ room }) {
  const now = useNow(500);
  const question = room?.currentQuestion;
  const timeLeft = getQuestionTimeLeft(question, room, now);
  const revealCountdown = getRevealCountdown(question, room, now);
  const [doneQuestionId, setDoneQuestionId] = useState(null);

  useEffect(() => {
    if (!room || room.stage !== "question" || !question) return;
    if (doneQuestionId === question.questionId) return;
    if (revealCountdown === null) return;

    if (revealCountdown <= 0 && timeLeft <= 0) {
      setDoneQuestionId(question.questionId);
      revealCorrectAnswer();
    }
  }, [room, question, timeLeft, revealCountdown, doneQuestionId]);

  useEffect(() => {
    setDoneQuestionId(null);
  }, [question?.questionId]);

  return null;
}

function AutoLockJokers({ room, players }) {
  const [lockedQuestionId, setLockedQuestionId] = useState(null);

  useEffect(() => {
    async function lockJokers() {
      const questionId = room?.currentQuestion?.questionId;
      const questionNumber = (room?.currentQuestionIndex ?? -1) + 1;

      if (!room || room.stage !== "question" || !questionId) return;
      if (lockedQuestionId === questionId) return;

      setLockedQuestionId(questionId);

      const playersToLock = players.filter(
        (player) =>
          player.pendingJoker &&
          !player.jokerUsed &&
          player.jokerQuestionId !== questionId
      );

      await Promise.all(
        playersToLock.map((player) =>
          updateDoc(doc(db, "rooms", ROOM_ID, "players", player.id), {
            pendingJoker: false,
            jokerUsed: true,
            jokerQuestionId: questionId,
            jokerQuestionNumber: questionNumber,
            jokerLockedAt: serverTimestamp(),
          })
        )
      );
    }

    lockJokers();
  }, [room, players, lockedQuestionId]);

  useEffect(() => {
    if (room?.stage !== "question") {
      setLockedQuestionId(null);
    }
  }, [room?.stage]);

  return null;
}

function AutoProcessResults({ room, answers, players }) {
  const [processingQuestionId, setProcessingQuestionId] = useState(null);

  useEffect(() => {
    async function processScores() {
      const questionId = room?.currentQuestion?.questionId;

      if (!room || room.stage !== "results" || !questionId) return;
      if (room.processedQuestionId === questionId) return;
      if (processingQuestionId === questionId) return;

      setProcessingQuestionId(questionId);

      if (room.questionIgnored) {
        await setDoc(
          doc(db, "rooms", ROOM_ID),
          {
            processedQuestionId: questionId,
            collectingBonusByPlayer: {},
            collectingBonusJokerByPlayer: {},
            collectingBonusPlayerId: null,
            collectingBonusPoints: 0,
            rankMovementByPlayer: {},
            updatedAt: serverTimestamp(),
          },
          { merge: true }
        );
        return;
      }

      const answersToProcess = [...answers].sort(
        (a, b) => (a.answeredAt || 0) - (b.answeredAt || 0)
      );

      const bonusByPlayer = answersToProcess.reduce((acc, answer) => {
        acc[answer.playerId] = answer.points || 0;
        return acc;
      }, {});

      const jokerByPlayer = answersToProcess.reduce((acc, answer) => {
        if (answer.jokerApplied) acc[answer.playerId] = true;
        return acc;
      }, {});

      const sortedBefore = [...players].sort(
        (a, b) => (b.score || 0) - (a.score || 0)
      );

      const previousRankByPlayer = sortedBefore.reduce((acc, player, index) => {
        acc[player.id] = index + 1;
        return acc;
      }, {});

      const finalPlayers = players.map((player) => ({
        ...player,
        __finalScore: (player.score || 0) + (bonusByPlayer[player.id] || 0),
      }));

      const sortedAfter = [...finalPlayers].sort(
        (a, b) => (b.__finalScore || 0) - (a.__finalScore || 0)
      );

      const rankMovementByPlayer = sortedAfter.reduce((acc, player, index) => {
        const previousRank = previousRankByPlayer[player.id] || index + 1;
        const newRank = index + 1;
        acc[player.id] = previousRank - newRank;
        return acc;
      }, {});

      await setDoc(
        doc(db, "rooms", ROOM_ID),
        {
          collectingBonusByPlayer: bonusByPlayer,
          collectingBonusJokerByPlayer: jokerByPlayer,
          collectingBonusPlayerId: null,
          collectingBonusPoints: 0,
          rankMovementByPlayer,
          updatedAt: serverTimestamp(),
        },
        { merge: true }
      );

      await new Promise((resolve) => setTimeout(resolve, 900));

      await Promise.all(
        players.map(async (latestPlayer) => {
          const answer = answersToProcess.find((item) => item.playerId === latestPlayer.id);
          const points = answer?.points || 0;

          await updateDoc(doc(db, "rooms", ROOM_ID, "players", latestPlayer.id), {
            score: (latestPlayer.score || 0) + points,
            answeredCount: (latestPlayer.answeredCount || 0) + (answer ? 1 : 0),
            lastQuestionPoints: points,
            lastQuestionId: questionId,
            lastAnswerAt: answer ? serverTimestamp() : latestPlayer.lastAnswerAt || null,
          });
        })
      );

      await new Promise((resolve) => setTimeout(resolve, SCORE_REVEAL_STEP_MS));

      await setDoc(
        doc(db, "rooms", ROOM_ID),
        {
          processedQuestionId: questionId,
          collectingBonusByPlayer: bonusByPlayer,
          collectingBonusJokerByPlayer: jokerByPlayer,
          collectingBonusPlayerId: null,
          collectingBonusPoints: 0,
          rankMovementByPlayer,
          updatedAt: serverTimestamp(),
        },
        { merge: true }
      );
    }

    processScores();
  }, [room, answers, players, processingQuestionId]);

  useEffect(() => {
    if (room?.stage !== "results") {
      setProcessingQuestionId(null);
    }
  }, [room?.stage]);

  return null;
}

/* Shared UI */

function RankMovementBadge({ movement }) {
  if (movement > 0) {
    return (
      <span
        title={`صعد ${movement} مركز`}
        style={{
          minWidth: "42px",
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          color: "#18733a",
          fontWeight: 900,
          whiteSpace: "nowrap",
        }}
      >
        ↑ {movement}
      </span>
    );
  }

  if (movement < 0) {
    return (
      <span
        title={`نزل ${Math.abs(movement)} مركز`}
        style={{
          minWidth: "42px",
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          color: "#a51f1f",
          fontWeight: 900,
          whiteSpace: "nowrap",
        }}
      >
        ↓ {Math.abs(movement)}
      </span>
    );
  }

  return (
    <span
      title="لم يتغير ترتيبه"
      style={{
        minWidth: "42px",
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        color: "#6b7280",
        fontWeight: 900,
      }}
    >
      -
    </span>
  );
}

function PlayerJokerBadge({ player, currentQuestionId }) {
  if (!player?.jokerUsed) return null;

  const usedInCurrentQuestion =
    !!currentQuestionId && player?.jokerQuestionId === currentQuestionId;

  return (
    <span
      className="joker-name-badge"
      title="استخدم الجوكر"
      style={
        usedInCurrentQuestion
          ? {
              background: "#e8f8ea",
              borderColor: "#6cc276",
              color: "#18733a",
            }
          : undefined
      }
    >
      🃏
    </span>
  );
}

function Leaderboard({
  players,
  compact = false,
  isCollecting = false,
  bonusPlayerId = null,
  bonusPoints = 0,
  bonusPointsByPlayer = {},
  bonusJokerByPlayer = {},
  currentQuestionId = null,
  rankMovementByPlayer = {},
}) {
  const visiblePlayers = players.slice(0, compact ? 8 : 20);
  const hasMovement = Object.keys(rankMovementByPlayer || {}).length > 0;

  function getLastDelta(player) {
    const fromRoom = bonusPointsByPlayer?.[player.id];
    if (typeof fromRoom === "number") return fromRoom;
    if (typeof player.lastQuestionPoints === "number") return player.lastQuestionPoints;
    return 0;
  }

  function renderDelta(player) {
    const delta = getLastDelta(player);
    const isJokerDelta = !!bonusJokerByPlayer?.[player.id] || player.lastQuestionId === currentQuestionId && player.jokerQuestionId === currentQuestionId;
    const text = delta > 0 ? `+${delta}` : `${delta}`;

    return (
      <span
        className={
          delta > 0
            ? "last-question-delta positive"
            : delta < 0
            ? "last-question-delta negative"
            : "last-question-delta same"
        }
        title="نقاط آخر سؤال"
      >
        {isJokerDelta ? "🃏 " : ""}{text}
      </span>
    );
  }

  return (
    <div className="card leaderboard-card">
      <div className="leaderboard-title-row">
        <h2>🏆 لوحة المتصدرين</h2>

        {isCollecting && (
          <span className="collecting-small-badge">تجميع النتائج</span>
        )}
      </div>

      {visiblePlayers.length === 0 ? (
        <p className="muted">لم ينضم أي مشارك بعد.</p>
      ) : (
        <motion.div className="leaderboard" layout>
          <AnimatePresence initial={false}>
            {visiblePlayers.map((player, index) => {
              const rankMovement = rankMovementByPlayer?.[player.id] || 0;

              return (
                <motion.div
                  layout
                  key={player.id}
                  className="leaderboard-row animated-leaderboard-row"
                  initial={{ opacity: 0, scale: 0.96 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.96 }}
                  transition={{
                    layout: {
                      duration: 1.05,
                      type: "spring",
                      bounce: 0.18,
                    },
                    opacity: { duration: 0.25 },
                    scale: { duration: 0.25 },
                  }}
                >
                  <div className="leaderboard-name">
                    {hasMovement && <RankMovementBadge movement={rankMovement} />}
                    <span className="rank">{index + 1}</span>
                    <span>{player.name}</span>
                    <PlayerJokerBadge
                      player={player}
                      currentQuestionId={currentQuestionId}
                    />
                  </div>

                  <div className="leaderboard-score-wrap">
                    {renderDelta(player)}
                    <motion.strong
                      key={player.score || 0}
                      initial={{ scale: 1.16 }}
                      animate={{ scale: 1 }}
                      transition={{ duration: 0.35 }}
                    >
                      {player.score || 0}
                    </motion.strong>
                  </div>
                </motion.div>
              );
            })}
          </AnimatePresence>
        </motion.div>
      )}
    </div>
  );
}

function MessagesPanel({ messages }) {
  return (
    <div className="card messages-card">
      <h2>💬 رسائل المتسابقين</h2>

      {messages.length === 0 ? (
        <p className="muted">لا توجد رسائل بعد.</p>
      ) : (
        <div className="messages-list">
          {messages.map((message) => (
            <div className="message-item" key={message.id}>
              <strong>{message.playerName}</strong>
              <span>{message.text}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function buildAnswerStats(question, answers) {
  if (!question?.options) return [];
  const total = Math.max(answers.length, 1);

  return question.options.map((option, index) => {
    const selectedAnswers = answers.filter(
      (answer) => answer.selectedIndex === index
    );
    const count = selectedAnswers.length;
    const jokerCount = selectedAnswers.filter((answer) => answer.jokerApplied).length;

    return {
      option: getOptionText(option),
      optionImage: getOptionImage(option, question?.optionImageUrls || [], index),
      index,
      count,
      jokerCount,
      correct: index === question.correctIndex,
      percent: (count / total) * 100,
    };
  });
}

function LiveAnswerStats({ question, answers, showCorrect = false }) {
  const stats = buildAnswerStats(question, answers);

  return (
    <div className="live-answer-stats">
      {stats.map((item) => {
        const resultStyle = showCorrect
          ? item.correct
            ? {
                background: "#e8f8ea",
                borderColor: "#6cc276",
                color: "#18733a",
              }
            : {
                background: "#ffe9e9",
                borderColor: "#d85c5c",
                color: "#a51f1f",
              }
          : undefined;

        return (
          <div className="result-item" key={item.index} style={resultStyle}>
            <div className="result-top">
              <span>
                {showCorrect ? (item.correct ? "✅ " : "❌ ") : ""}
                {item.option}
              </span>

              <div style={{ display: "inline-flex", alignItems: "center", gap: "8px", whiteSpace: "nowrap" }}>
                <span style={{ background: "rgba(255,255,255,0.72)", border: "1px solid rgba(31,41,51,0.12)", borderRadius: "999px", padding: "6px 11px", fontWeight: 900 }}>
                  {item.count} إجابة
                </span>
                <span style={{ background: "#fff7df", border: "1px solid #ead69c", color: "#7a4f18", borderRadius: "999px", padding: "6px 11px", fontWeight: 900 }}>
                  🃏 {item.jokerCount}
                </span>
              </div>
            </div>

            <div className="bar">
              <div
                className="bar-fill"
                style={{
                  width: `${item.percent}%`,
                  background: showCorrect
                    ? item.correct
                      ? "#18733a"
                      : "#a51f1f"
                    : undefined,
                }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}

function AnsweredCountBadge({ answersCount, playersCount }) {
  const allAnswered = playersCount > 0 && answersCount >= playersCount;

  return (
    <div
      className="answered-count-badge"
      style={
        allAnswered
          ? {
              background: "#e8f8ea",
              borderColor: "#6cc276",
              color: "#18733a",
            }
          : undefined
      }
    >
      أجاب {answersCount} من أصل {playersCount}
    </div>
  );
}

function ImageZoomModal({ imageUrl, onClose }) {
  if (!imageUrl) return null;

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 9999,
        background: "rgba(17,24,39,0.82)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "22px",
      }}
    >
      <img
        src={imageUrl}
        alt="تكبير الصورة"
        style={{
          maxWidth: "96vw",
          maxHeight: "92vh",
          objectFit: "contain",
          borderRadius: "18px",
          background: "white",
        }}
      />
    </div>
  );
}

function ZoomableImage({ src, alt = "صورة", className = "", style = {} }) {
  const [zoomed, setZoomed] = useState(false);
  if (!src) return null;

  return (
    <>
      <button
        type="button"
        className={className}
        onClick={() => setZoomed(true)}
        style={{
          padding: 0,
          background: "transparent",
          border: "none",
          width: "100%",
          color: "inherit",
          ...style,
        }}
        title="اضغط للتكبير"
      >
        <img
          src={src}
          alt={alt}
          style={{
            width: "100%",
            maxHeight: "260px",
            objectFit: "contain",
            borderRadius: "18px",
            background: "#fff",
            border: "1px solid #e4d8c8",
          }}
        />
      </button>
      {zoomed && <ImageZoomModal imageUrl={src} onClose={() => setZoomed(false)} />}
    </>
  );
}

function MediaQuestionPlayer({ question, room, isAdmin, displayMode }) {
  const mediaRef = useRef(null);
  const mediaUrl = getQuestionMediaUrl(question);
  const isVideo = question?.type === "video";
  const mediaStarted =
    !!toMillis(room?.mediaStartedAt) || !!question?.fallbackMediaStartedAt;
  const mediaEnded =
    !!toMillis(room?.mediaEndedAt) || !!question?.fallbackMediaEndedAt;

  async function handleStartMedia() {
    await startMediaQuestion();

    if (mediaRef.current) {
      mediaRef.current.currentTime = 0;
      mediaRef.current.play().catch(() => {});
    }
  }

  async function handleEnded() {
    if (isAdmin && displayMode && !mediaEnded) {
      await finishMediaQuestion();
    }
  }

  if (!mediaUrl) return null;

  const canParticipantPlay = !isAdmin && mediaEnded;
  const showControls = (isAdmin && displayMode) || canParticipantPlay;

  return (
    <div className="reveal-box" style={{ marginBottom: "18px" }}>
      {isVideo ? (
        <video
          ref={mediaRef}
          controls={showControls}
          src={mediaUrl}
          onEnded={handleEnded}
          style={{ width: "100%", maxHeight: displayMode ? "34vh" : "220px", borderRadius: "16px" }}
        />
      ) : (
        <audio
          ref={mediaRef}
          controls={showControls}
          src={mediaUrl}
          onEnded={handleEnded}
          style={{ width: "100%" }}
        />
      )}

      {isAdmin && displayMode && !mediaStarted && (
        <button
          type="button"
          onClick={handleStartMedia}
          style={{ marginTop: "14px", width: "100%" }}
        >
          تشغيل {isVideo ? "الفيديو" : "الصوت"}
        </button>
      )}

      {isAdmin && displayMode && mediaStarted && !mediaEnded && (
        <button
          type="button"
          onClick={finishMediaQuestion}
          style={{ marginTop: "14px", width: "100%", background: "#7a6646" }}
        >
          إرسال الإجابات الآن
        </button>
      )}

      {!isAdmin && !mediaEnded && (
        <p className="muted" style={{ margin: "12px 0 0", textAlign: "center" }}>
          سيظهر لك تشغيل {isVideo ? "الفيديو" : "الصوت"} بعد انتهاء المقطع عند المقدم.
        </p>
      )}

      {mediaEnded && (
        <p className="muted" style={{ margin: "6px 0 0", textAlign: "center", fontSize: "12px", lineHeight: 1.4 }}>
          انتهى المقطع، ستظهر الإجابات بعد العد التنازلي.
        </p>
      )}
    </div>
  );
}

function QuestionScreen({
  question,
  room,
  answers = [],
  playersCount = 0,
  isAdmin = false,
  onAnswer,
  selectedIndex,
  answerMessage,
  displayMode = false,
  frozenProgressPercent = null,
  currentPlayer = null,
}) {
  const now = useNow();
  const revealCountdown = getRevealCountdown(question, room, now);
  const mediaQuestion = isMediaQuestion(question);
  const questionImageUrl = getQuestionImageUrl(question);
  const mediaEnded =
    !mediaQuestion ||
    !!toMillis(room?.mediaEndedAt) ||
    !!question?.fallbackMediaEndedAt;

  const optionsVisible = mediaQuestion
    ? mediaEnded && revealCountdown !== null && revealCountdown <= 0
    : revealCountdown <= 0;

  const timeLeft = getQuestionTimeLeft(question, room, now);
  const isQuestionEnded = room?.stage === "reveal" || room?.stage === "results";

  const canAnswer = !isAdmin && optionsVisible && room?.stage === "question";
  const liveProgressPercent = getPointsProgressPercent(question, room, now);

  const progressPercent =
    selectedIndex !== null && frozenProgressPercent !== null
      ? frozenProgressPercent
      : liveProgressPercent;

  const jokerAppliedToThisQuestion =
    !!currentPlayer?.jokerUsed &&
    currentPlayer?.jokerQuestionId === question?.questionId;

  if (!question) return null;

  return (
    <div
      className={
        displayMode
          ? "display-panel question-stage-card"
          : "card question-stage-card"
      }
    >
      <div className="question-status-row">
        <span className="pill">
          السؤال رقم {(room?.currentQuestionIndex ?? 0) + 1}
        </span>

        {displayMode && (
          <AnsweredCountBadge
            answersCount={answers.length}
            playersCount={playersCount}
          />
        )}

        {optionsVisible && !isQuestionEnded ? (
          <span className="timer">⏱ {timeLeft} ثانية</span>
        ) : null}
      </div>

      <h2 className="big-question">{question.text}</h2>

      {questionImageUrl && (
        <div style={{ width: "min(520px, 100%)", margin: "0 auto 16px" }}>
          <ZoomableImage src={questionImageUrl} alt="صورة السؤال" />
        </div>
      )}

      {mediaQuestion && (
        <MediaQuestionPlayer
          question={question}
          room={room}
          isAdmin={isAdmin}
          displayMode={displayMode}
        />
      )}

      {!optionsVisible ? (
        <div className="reveal-box big-countdown-only">
          {revealCountdown === null ? (question?.type === "video" ? "🎬" : "🎧") : revealCountdown}
        </div>
      ) : isAdmin && displayMode ? (
        <LiveAnswerStats
          question={question}
          answers={answers}
          showCorrect={isQuestionEnded}
        />
      ) : (
        <>
          {!isAdmin && (
            <div
              className={
                jokerAppliedToThisQuestion
                  ? "points-progress-wrap joker-active-progress"
                  : "points-progress-wrap"
              }
            >
              {jokerAppliedToThisQuestion && (
                <div className="joker-progress-icon">🃏</div>
              )}

              <div className="points-progress-values">
                <span>
                  {jokerAppliedToThisQuestion
                    ? `${Number(question.minPoints || 100) * 3} نقطة`
                    : `${question.minPoints} نقطة`}
                </span>

                <span>
                  {jokerAppliedToThisQuestion
                    ? `${Number(question.maxPoints || 1000) * 3} نقطة`
                    : `${question.maxPoints} نقطة`}
                </span>
              </div>

              <div
                className={
                  jokerAppliedToThisQuestion
                    ? "points-progress-track joker-progress-track"
                    : "points-progress-track"
                }
              >
                <div
                  className={
                    jokerAppliedToThisQuestion
                      ? "points-progress-fill joker-progress-fill"
                      : "points-progress-fill"
                  }
                  style={{ width: `${progressPercent}%` }}
                />
              </div>
            </div>
          )}

          <div
            className="answer-list"
            style={
              !isAdmin
                ? {
                    gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
                    gap: "10px",
                  }
                : undefined
            }
          >
            {question.options.map((option, index) => {
              const optionImage = getOptionImage(option, question.optionImageUrls || [], index);
              const optionText = getOptionText(option);

              return (
                <button
                  key={index}
                  className={
                    selectedIndex === index
                      ? "answer-button selected"
                      : "answer-button"
                  }
                  disabled={!canAnswer || selectedIndex !== null}
                  onClick={() => onAnswer?.(index)}
                  style={
                    !isAdmin
                      ? {
                          minHeight: optionImage ? "82px" : "58px",
                          fontSize: "clamp(14px, 4vw, 18px)",
                          padding: "10px",
                          display: "grid",
                          gap: "6px",
                          justifyItems: "center",
                        }
                      : displayMode
                      ? {
                          fontSize: "clamp(15px, 1.25vw, 24px)",
                          lineHeight: 1.35,
                          padding: "14px",
                        }
                      : undefined
                  }
                >
                  {optionImage && (
                    <span
                      onClick={(e) => e.stopPropagation()}
                      style={{ width: "100%", maxWidth: "180px" }}
                    >
                      <ZoomableImage src={optionImage} alt={`صورة الخيار ${index + 1}`} />
                    </span>
                  )}
                  <span>{optionText}</span>
                </button>
              );
            })}
          </div>
        </>
      )}

      {answerMessage && <div className="message-box">{answerMessage}</div>}
    </div>
  );
}

function ResultsDisplay({ room, players, messages }) {
  const isCollecting =
    room?.processedQuestionId !== room?.currentQuestion?.questionId;

  return (
    <div className="results-display-grid">
      <div className="results-main-area">
        {room?.questionIgnored && (
          <div className="card" style={{ marginBottom: "14px", textAlign: "center", background: "#fff7df", borderColor: "#ead69c" }}>
            <strong>تم تجاهل هذا السؤال، ولم تُحتسب أي نقاط.</strong>
          </div>
        )}
        <Leaderboard
          players={players}
          compact
          isCollecting={isCollecting}
          bonusPlayerId={room?.collectingBonusPlayerId}
          bonusPoints={room?.collectingBonusPoints || 0}
          bonusPointsByPlayer={room?.collectingBonusByPlayer || {}}
          bonusJokerByPlayer={room?.collectingBonusJokerByPlayer || {}}
          currentQuestionId={room?.currentQuestion?.questionId}
          rankMovementByPlayer={room?.rankMovementByPlayer || {}}
        />
      </div>

      <div className="results-messages-area">
        <MessagesPanel messages={messages} />
      </div>
    </div>
  );
}

function FinishedDisplay({ players, messages = [] }) {
  const first = players[0];
  const second = players[1];
  const third = players[2];
  const restPlayers = players.slice(3);

  const mainCardStyle = {
    height: "100%",
    background: "rgba(255,255,255,0.96)",
    border: "1px solid #e4d8c8",
    borderRadius: "32px",
    padding: "36px",
    boxShadow: "0 16px 40px rgba(31,41,51,0.09)",
    display: "flex",
    flexDirection: "column",
    justifyContent: "center",
    alignItems: "center",
    textAlign: "center",
    overflow: "hidden",
  };

  function WinnerCard({ player, place, bg, border, size = "normal" }) {
    if (!player) return <div />;

    return (
      <div
        style={{
          minHeight: size === "first" ? "210px" : size === "second" ? "165px" : "135px",
          background: bg,
          border: `1px solid ${border}`,
          borderRadius: "24px",
          padding: "20px 14px",
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          alignItems: "center",
          gap: "8px",
          overflow: "hidden",
          textAlign: "center",
        }}
      >
        <span style={{ color: "#6b7280", fontWeight: 900, fontSize: "18px" }}>
          {place}
        </span>

        <strong
          style={{
            maxWidth: "100%",
            fontSize: size === "first" ? "42px" : size === "second" ? "34px" : "28px",
            lineHeight: 1.1,
            color: "#1f2933",
            fontWeight: 900,
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {player.name}
        </strong>

        <b style={{ fontSize: "22px", color: "#1f2933", fontWeight: 900 }}>
          {player.score || 0} نقطة
        </b>
      </div>
    );
  }

  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "grid",
        gridTemplateColumns: "minmax(0, 1.45fr) minmax(260px, 0.55fr)",
        gap: "24px",
      }}
    >
      <div style={mainCardStyle}>
        <div style={{ fontSize: "54px", lineHeight: 1, marginBottom: "10px" }}>
          🎉
        </div>

        <h1
          style={{
            margin: "0 0 12px 0",
            padding: 0,
            fontSize: "64px",
            lineHeight: "1.05",
            fontWeight: 900,
            color: "#1f2933",
            whiteSpace: "nowrap",
          }}
        >
          انتهت المسابقة
        </h1>

        <p
          style={{
            margin: "0 0 34px 0",
            fontSize: "26px",
            lineHeight: "1.35",
            fontWeight: 800,
            color: "#6b7280",
          }}
        >
          مبروك للفائزين وشكرًا لجميع المشاركين
        </p>

        <div
          style={{
            width: "100%",
            display: "grid",
            gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
            gap: "18px",
            alignItems: "end",
          }}
        >
          <WinnerCard
            player={second}
            place="المركز الثاني"
            size="second"
            bg="#f3f4f6"
            border="#d1d5db"
          />

          <WinnerCard
            player={first}
            place="المركز الأول"
            bg="#fff7df"
            border="#ead69c"
            size="first"
          />

          <WinnerCard
            player={third}
            place="المركز الثالث"
            size="third"
            bg="#fff1e6"
            border="#f0c9a8"
          />
        </div>
      </div>

      <div style={{ height: "100%", overflow: "hidden", display: "grid", gap: "14px", gridTemplateRows: "1fr 1fr" }}>
        <div className="card" style={{ overflow: "hidden" }}>
          <h2>بقية الترتيب</h2>
          <div className="leaderboard">
            {restPlayers.length === 0 ? (
              <p className="muted">لا يوجد متسابقون بعد المركز الثالث.</p>
            ) : (
              restPlayers.map((player, index) => (
                <div className="leaderboard-row" key={player.id}>
                  <div className="leaderboard-name">
                    <span className="rank">{index + 4}</span>
                    <span>{player.name}</span>
                  </div>
                  <strong>{player.score || 0}</strong>
                </div>
              ))
            )}
          </div>
        </div>
        <MessagesPanel messages={messages} />
      </div>
    </div>
  );
}

/* Joker controls */

function JokerControl({ player, stage }) {
  const canChooseJoker =
    !player?.jokerUsed && stage !== "finished";

  async function activateJoker() {
    if (!player?.id || player.jokerUsed) return;

    await updateDoc(doc(db, "rooms", ROOM_ID, "players", player.id), {
      pendingJoker: true,
    });
  }

  async function cancelJoker() {
    if (!player?.id || player.jokerUsed) return;

    await updateDoc(doc(db, "rooms", ROOM_ID, "players", player.id), {
      pendingJoker: false,
    });
  }

  const availableCount = player?.jokerUsed ? 0 : 1;

  if (!canChooseJoker && !player?.jokerUsed) return null;

  if (player?.jokerUsed) {
    return (
      <div className="joker-token joker-token-used">
        <div className="joker-count">{availableCount}</div>
        <div className="joker-icon">🃏</div>
        <span>الجوكر مستخدم</span>
      </div>
    );
  }

  if (player?.pendingJoker) {
    return (
      <button
        type="button"
        className="joker-token joker-token-active"
        onClick={cancelJoker}
        style={{ background: "#e8f8ea", borderColor: "#6cc276", color: "#18733a" }}
      >
        <div className="joker-count">{availableCount}</div>
        <div className="joker-icon">🃏</div>
        <span>الجوكر مفعل</span>
        <small style={{ fontWeight: 900, opacity: 0.78 }}>اضغط للإلغاء</small>
      </button>
    );
  }

  return (
    <button type="button" className="joker-token joker-token-available" onClick={activateJoker} style={{ background: "#fff1d6", borderColor: "#f59e0b", color: "#9a5b00" }}>
      <div className="joker-count">{availableCount}</div>
      <div className="joker-icon">🃏</div>
      <span>الجوكر</span>
    </button>
  );
}

/* Settings */

function QuestionSettings({ questions }) {
  const [editingId, setEditingId] = useState(null);
  const [showForm, setShowForm] = useState(false);
  const [type, setType] = useState("multiple_choice");
  const [text, setText] = useState("");
  const [mediaUrl, setMediaUrl] = useState("");
  const [imageUrl, setImageUrl] = useState("");
  const [optionImageUrls, setOptionImageUrls] = useState(["", ""]);
  const [options, setOptions] = useState(["", ""]);
  const [correctIndex, setCorrectIndex] = useState(0);
  const [maxPoints, setMaxPoints] = useState(1000);
  const [minPoints, setMinPoints] = useState(100);
  const [seconds, setSeconds] = useState(20);
  const [saving, setSaving] = useState(false);

  function resetForm() {
    setEditingId(null);
    setShowForm(false);
    setType("multiple_choice");
    setText("");
    setMediaUrl("");
    setImageUrl("");
    setOptionImageUrls(["", ""]);
    setOptions(["", ""]);
    setCorrectIndex(0);
    setMaxPoints(1000);
    setMinPoints(100);
    setSeconds(20);
  }

  function startCreate() {
    resetForm();
    setShowForm(true);
  }

  function startEdit(question) {
    setEditingId(question.id);
    setShowForm(true);
    setType(question.type || "multiple_choice");
    setText(question.text || "");
    setMediaUrl(getQuestionMediaUrl(question));
    setImageUrl(getQuestionImageUrl(question));
    setOptions(question.options?.length ? question.options.map(getOptionText) : ["", ""]);
    setOptionImageUrls(question.optionImageUrls?.length ? question.optionImageUrls : (question.options?.length ? question.options.map((option, index) => getOptionImage(option, question.optionImageUrls || [], index)) : ["", ""]));
    setCorrectIndex(Number(question.correctIndex || 0));
    setMaxPoints(Number(question.maxPoints || 1000));
    setMinPoints(Number(question.minPoints || 100));
    setSeconds(Number(question.seconds || 20));
  }

  function updateOption(index, value) {
    const copy = [...options];
    copy[index] = value;
    setOptions(copy);
  }

  function updateOptionImage(index, value) {
    const copy = [...optionImageUrls];
    copy[index] = value;
    setOptionImageUrls(copy);
  }

  function addOption() {
    setOptions([...options, ""]);
    setOptionImageUrls([...optionImageUrls, ""]);
  }

  function removeOption(indexToRemove) {
    if (type === "true_false") return;
    if (options.length <= 2) return;

    const nextOptions = options.filter((_, index) => index !== indexToRemove);
    const nextOptionImages = optionImageUrls.filter((_, index) => index !== indexToRemove);
    setOptions(nextOptions);
    setOptionImageUrls(nextOptionImages);

    if (correctIndex === indexToRemove) {
      setCorrectIndex(0);
    } else if (correctIndex > indexToRemove) {
      setCorrectIndex(correctIndex - 1);
    }
  }

  function handleTypeChange(value) {
    setType(value);

    if (value === "true_false") {
      setOptions(["صح", "خطأ"]);
      setOptionImageUrls(["", ""]);
      setCorrectIndex(0);
      setMediaUrl("");
      setImageUrl("");
    } else {
      setOptions(["", ""]);
      setOptionImageUrls(["", ""]);
      setCorrectIndex(0);
      if (value !== "image") setImageUrl("");
      if (value !== "audio" && value !== "video") setMediaUrl("");
    }
  }

  async function saveQuestion() {
    const cleanText = text.trim();
    const cleanMediaUrl = mediaUrl.trim();
    const cleanImageUrl = imageUrl.trim();
    const cleanOptionImageUrls = optionImageUrls.map((url) => url.trim());
    const cleanOptions = options.map((o, index) => ({ text: o.trim(), imageUrl: cleanOptionImageUrls[index] || "" })).filter((item) => item.text || item.imageUrl);

    if (!cleanText || cleanOptions.length < 2) {
      alert("اكتب السؤال وخيارين على الأقل.");
      return;
    }

    if (type === "image" && !cleanImageUrl && !cleanOptions.some((item) => item.imageUrl)) {
      alert("ضع صورة للسؤال أو صورة لواحد من الخيارات على الأقل.");
      return;
    }

    if ((type === "audio" || type === "video") && !cleanMediaUrl) {
      alert(type === "video" ? "ضع رابط مقطع الفيديو." : "ضع رابط المقطع الصوتي.");
      return;
    }

    if (correctIndex < 0 || correctIndex >= cleanOptions.length) {
      alert("اختر الإجابة الصحيحة.");
      return;
    }

    setSaving(true);

    const payload = {
      type,
      text: cleanText,
      mediaUrl: type === "audio" || type === "video" ? cleanMediaUrl : "",
      audioUrl: type === "audio" ? cleanMediaUrl : "",
      videoUrl: type === "video" ? cleanMediaUrl : "",
      imageUrl: type === "image" ? cleanImageUrl : "",
      optionImageUrls: cleanOptions.map((item) => item.imageUrl || ""),
      options: cleanOptions.map((item) => item.text || "صورة"),
      correctIndex: Number(correctIndex),
      maxPoints: Number(maxPoints),
      minPoints: Number(minPoints),
      seconds: Number(seconds),
      updatedAt: serverTimestamp(),
    };

    if (editingId) {
      await updateDoc(doc(db, "rooms", ROOM_ID, "questions", editingId), payload);
    } else {
      await addDoc(collection(db, "rooms", ROOM_ID, "questions"), {
        ...payload,
        order: questions.length + 1,
        createdAt: serverTimestamp(),
      });
    }

    resetForm();
    setSaving(false);
  }

  async function moveQuestion(question, direction) {
    const currentIndex = questions.findIndex((item) => item.id === question.id);
    const targetIndex = currentIndex + direction;
    if (currentIndex < 0 || targetIndex < 0 || targetIndex >= questions.length) return;

    const targetQuestion = questions[targetIndex];
    await Promise.all([
      updateDoc(doc(db, "rooms", ROOM_ID, "questions", question.id), { order: targetIndex + 1 }),
      updateDoc(doc(db, "rooms", ROOM_ID, "questions", targetQuestion.id), { order: currentIndex + 1 }),
    ]);
  }

  async function deleteQuestion(questionId) {
    if (!window.confirm("حذف السؤال؟")) return;
    await deleteDoc(doc(db, "rooms", ROOM_ID, "questions", questionId));
  }

  return (
    <div className="control-page">
      <style>{`
        .admin-bordered-table th,
        .admin-bordered-table td {
          border: 1px solid #e4d8c8;
          padding: 10px 12px;
          vertical-align: middle;
        }
        .admin-bordered-table th {
          background: #f3eadc;
          font-weight: 900;
        }
        .admin-bordered-table td {
          background: #fffaf2;
        }
      `}</style>
      <div className="card control-hero">
        <div>
          <h2>إعدادات الأسئلة</h2>
          <p className="muted">راجع الأسئلة المضافة وقيمتها ووقتها، ثم عدّل أو احذف ما تريد.</p>
        </div>
        <button onClick={startCreate}>إضافة سؤال جديد</button>
      </div>

      <div className="card">
        <h2>الأسئلة المضافة</h2>

        {questions.length === 0 ? (
          <p className="muted">لم تضف أي سؤال بعد.</p>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table className="admin-bordered-table" style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr style={{ color: "#6b7280", textAlign: "right" }}>
                  <th>رقم</th>
                  <th>السؤال</th>
                  <th>النوع</th>
                  <th>القيمة</th>
                  <th>الوقت</th>
                  <th>الإجابات</th>
                  <th>إجراء</th>
                </tr>
              </thead>
              <tbody>
                {questions.map((q, index) => (
                  <tr key={q.id} style={{ background: "#fbf7ef" }}>
                    <td style={{ padding: "14px", borderRadius: "16px 0 0 16px", fontWeight: 900 }}>{index + 1}</td>
                    <td style={{ padding: "14px", fontWeight: 900, minWidth: "260px" }}>{q.text}</td>
                    <td style={{ padding: "14px", whiteSpace: "nowrap" }}>{getQuestionTypeLabel(q.type)}</td>
                    <td style={{ padding: "14px", whiteSpace: "nowrap" }}>{q.minPoints || 100} - {q.maxPoints || 1000}</td>
                    <td style={{ padding: "14px", whiteSpace: "nowrap" }}>{q.seconds || 20} ثانية</td>
                    <td style={{ padding: "14px", color: "#6b7280", minWidth: "220px" }}>{q.options?.join(" - ")}</td>
                    <td style={{ padding: "14px", borderRadius: "0 16px 16px 0", whiteSpace: "nowrap" }}>
                      <button className="small-button" onClick={() => moveQuestion(q, -1)} disabled={index === 0}>↑</button>{" "}
                      <button className="small-button" onClick={() => moveQuestion(q, 1)} disabled={index === questions.length - 1}>↓</button>{" "}
                      <button className="small-button" onClick={() => startEdit(q)}>تعديل</button>{" "}
                      <button className="danger small-button" onClick={() => deleteQuestion(q.id)}>حذف</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {showForm && (
        <div className="card form-card">
          <h2>{editingId ? "تعديل السؤال" : "إضافة سؤال"}</h2>

          <label>نوع السؤال</label>
          <select value={type} onChange={(e) => handleTypeChange(e.target.value)}>
            <option value="multiple_choice">اختيار من متعدد</option>
            <option value="true_false">صح أو خطأ</option>
            <option value="audio">سؤال صوتي</option>
            <option value="video">سؤال فيديو</option>
            <option value="image">سؤال صورة</option>
          </select>

          <label>نص السؤال</label>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="اكتب السؤال هنا"
          />

          {(type === "audio" || type === "video") && (
            <>
              <label>{type === "video" ? "رابط مقطع الفيديو" : "رابط المقطع الصوتي"}</label>
              <input
                value={mediaUrl}
                onChange={(e) => setMediaUrl(e.target.value)}
                placeholder={type === "video" ? "ضع رابط الفيديو هنا" : "ضع رابط الصوت هنا"}
              />
            </>
          )}

          {type === "image" && (
            <>
              <label>رابط صورة السؤال</label>
              <input
                value={imageUrl}
                onChange={(e) => setImageUrl(e.target.value)}
                placeholder="ضع رابط صورة السؤال هنا، أو اتركه فارغًا إذا الصور في الخيارات"
              />
            </>
          )}

          <label>الإجابات</label>
          <div className="options-editor">
            {options.map((option, index) => (
              <div className="option-editor-row" key={index}>
                <div style={{ display: "grid", gap: "8px" }}>
                  <input
                    value={option}
                    onChange={(e) => updateOption(index, e.target.value)}
                    placeholder={`الإجابة ${index + 1}`}
                    disabled={type === "true_false"}
                  />
                  {type === "image" && (
                    <input
                      value={optionImageUrls[index] || ""}
                      onChange={(e) => updateOptionImage(index, e.target.value)}
                      placeholder={`رابط صورة الخيار ${index + 1} - اختياري`}
                    />
                  )}
                </div>

                <label className="radio-label">
                  <input
                    type="radio"
                    name="correct"
                    checked={correctIndex === index}
                    onChange={() => setCorrectIndex(index)}
                  />
                  الصحيحة
                </label>

                {type !== "true_false" && options.length > 2 && (
                  <button
                    type="button"
                    className="danger small-button option-delete-button"
                    onClick={() => removeOption(index)}
                  >
                    حذف
                  </button>
                )}
              </div>
            ))}
          </div>

          {type !== "true_false" && (
            <button type="button" className="small-button" onClick={addOption}>
              إضافة خيار آخر
            </button>
          )}

          <div className="settings-grid">
            <div>
              <label>أعلى نقاط</label>
              <input type="number" value={maxPoints} onChange={(e) => setMaxPoints(e.target.value)} />
            </div>

            <div>
              <label>أقل نقاط</label>
              <input type="number" value={minPoints} onChange={(e) => setMinPoints(e.target.value)} />
            </div>

            <div>
              <label>وقت الإجابة بالثواني</label>
              <input type="number" value={seconds} onChange={(e) => setSeconds(e.target.value)} />
            </div>
          </div>

          <button onClick={saveQuestion} disabled={saving}>
            {saving ? "جاري الحفظ..." : editingId ? "حفظ التعديل" : "حفظ السؤال"}
          </button>

          <button type="button" onClick={resetForm}>إلغاء</button>
        </div>
      )}
    </div>
  );
}

/* Admin */

function downloadExcelFile(filename, sheets) {
  const sheetHtml = sheets
    .map(
      (sheet) => `
        <h2>${sheet.name}</h2>
        <table border="1">
          <thead><tr>${sheet.headers.map((h) => `<th>${h}</th>`).join("")}</tr></thead>
          <tbody>
            ${sheet.rows
              .map(
                (row) =>
                  `<tr>${row
                    .map((cell) => `<td>${String(cell ?? "").replace(/</g, "&lt;").replace(/>/g, "&gt;")}</td>`)
                    .join("")}</tr>`
              )
              .join("")}
          </tbody>
        </table>`
    )
    .join("<br/><br/>");

  const html = `
    <html dir="rtl">
      <head><meta charset="utf-8" /></head>
      <body>${sheetHtml}</body>
    </html>`;

  const blob = new Blob([html], { type: "application/vnd.ms-excel;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

function AdminControl({ room, players, questions, messages, allAnswers }) {
  const stage = room?.stage || "home";
  const currentQuestionIndex = room?.currentQuestionIndex ?? -1;
  const [expandedQuestions, setExpandedQuestions] = useState({});

  const stageArabic =
    {
      home: "الصفحة الرئيسية",
      registration: "تسجيل اللاعبين",
      question: "السؤال معروض",
      reveal: "إظهار الإجابة الصحيحة",
      results: room?.processedQuestionId === room?.currentQuestion?.questionId ? "عرض النتائج" : "تجميع النتائج",
      finished: "انتهت المسابقة",
    }[stage] || stage;

  const answersByQuestion = questions.map((question, index) => {
    const rows = allAnswers
      .filter((answer) => answer.questionId === question.id || answer.questionId === question.questionId)
      .map((answer) => {
        const player = players.find((p) => p.id === answer.playerId);
        return {
          question,
          questionNumber: index + 1,
          answer,
          player,
          selectedText: getOptionText(question.options?.[answer.selectedIndex]) || "—",
        };
      });

    return {
      question,
      questionNumber: index + 1,
      ignored: !!room?.ignoredQuestionIds?.[question.id],
      rows,
    };
  });

  const sortedWinners = [...players].sort((a, b) => (b.score || 0) - (a.score || 0)).slice(0, 3);

  function exportPlayersExcel() {
    downloadExcelFile("family-quiz-players.xls", [
      {
        name: "المراكز الثلاثة الأولى",
        headers: ["المركز", "الاسم المستعار", "الاسم الثلاثي", "رقم الجوال", "النقاط"],
        rows: sortedWinners.map((player, index) => [
          index + 1,
          player.name || "",
          player.fullName || "",
          player.phone || "",
          player.score || 0,
        ]),
      },
      {
        name: "بيانات المتسابقين",
        headers: ["الاسم المستعار", "الاسم الثلاثي", "رقم الجوال", "النقاط", "حالة الجوكر", "نقاط آخر سؤال"],
        rows: players.map((player) => [
          player.name || "",
          player.fullName || "",
          player.phone || "",
          player.score || 0,
          player.jokerUsed ? "مستخدم" : player.pendingJoker ? "مفعل للسؤال القادم" : "متاح",
          player.lastQuestionPoints ?? 0,
        ]),
      },
    ]);
  }

  function exportAnswersExcel() {
    const answerRows = [];

    questions.forEach((question, index) => {
      allAnswers
        .filter((answer) => answer.questionId === question.id || answer.questionId === question.questionId)
        .forEach((answer) => {
          const player = players.find((p) => p.id === answer.playerId);
          answerRows.push([
            index + 1,
            question.text,
            getQuestionTypeLabel(question.type),
            player?.name || answer.playerName || "",
            player?.fullName || answer.fullName || "",
            player?.phone || answer.phone || "",
            getOptionText(question.options?.[answer.selectedIndex]) || "—",
            answer.isCorrect ? "صح" : "خطأ",
            answer.basePoints || 0,
            answer.points || 0,
            answer.jokerApplied ? "نعم" : "لا",
            room?.ignoredQuestionIds?.[question.id] ? "نعم" : "لا",
          ]);
        });
    });

    downloadExcelFile("family-quiz-answers-report.xls", [
      {
        name: "المراكز الثلاثة الأولى",
        headers: ["المركز", "الاسم المستعار", "الاسم الثلاثي", "رقم الجوال", "النقاط"],
        rows: sortedWinners.map((player, index) => [
          index + 1,
          player.name || "",
          player.fullName || "",
          player.phone || "",
          player.score || 0,
        ]),
      },
      {
        name: "تقرير الإجابات",
        headers: [
          "رقم السؤال",
          "السؤال",
          "النوع",
          "الاسم المستعار",
          "الاسم الثلاثي",
          "رقم الجوال",
          "الإجابة المختارة",
          "النتيجة",
          "النقاط الأصلية",
          "النقاط المحتسبة",
          "جوكر",
          "سؤال متجاهل",
        ],
        rows: answerRows,
      },
    ]);
  }

  async function handleGiveJoker(player) {
    if (!window.confirm(`إضافة جوكر جديد للمتسابق ${player.name}؟`)) return;
    await giveJokerToPlayer(player.id);
  }

  async function handleAdjustScore(player, direction) {
    const raw = window.prompt(direction > 0 ? "كم نقطة تريد إضافتها؟" : "كم نقطة تريد خصمها؟", "100");
    if (raw === null) return;

    const value = Number(raw);
    if (!Number.isFinite(value) || value <= 0) {
      alert("اكتب رقمًا صحيحًا أكبر من صفر.");
      return;
    }

    await adjustPlayerScore(player, direction > 0 ? value : -value);
  }

  function toggleQuestion(questionId) {
    setExpandedQuestions((prev) => ({
      ...prev,
      [questionId]: !prev[questionId],
    }));
  }

  return (
    <div className="control-page">
      <div className="card control-hero">
        <div>
          <h2>لوحة التحكم</h2>
          <p className="muted">إدارة بيانات المتسابقين والتقارير. إدارة سير المسابقة تتم من صفحة العرض.</p>
        </div>

        <div className="control-links">
          <a href={`/?admin=${ADMIN_CODE}&view=display`} target="_blank" rel="noreferrer">فتح صفحة العرض</a>
          <a href={`/?admin=${ADMIN_CODE}&view=settings`}>إعدادات الأسئلة</a>
        </div>
      </div>

      <div className="card">
        <h2>تهيئة وإعادة المسابقة</h2>
        <p className="muted">استخدم هذه الأزرار قبل بداية المسابقة أو عند الحاجة لإعادة التهيئة.</p>
        <div className="control-links">
          <button onClick={createOrResetRoom}>الصفحة الرئيسية</button>
          <button onClick={resetAndStartRegistration}>فتح تسجيل جديد وتصفير البيانات</button>
          <button className="danger" onClick={hardResetGame}>إعادة المسابقة من البداية</button>
        </div>
      </div>

      <div className="control-stats-grid">
        <div className="card stat-box control-stat"><span>المرحلة الحالية</span><strong>{stageArabic}</strong></div>
        <div className="card stat-box control-stat"><span>عدد اللاعبين</span><strong>{players.length}</strong></div>
        <div className="card stat-box control-stat"><span>عدد الأسئلة</span><strong>{questions.length}</strong></div>
        <div className="card stat-box control-stat"><span>السؤال الحالي</span><strong>{currentQuestionIndex + 1 > 0 ? currentQuestionIndex + 1 : "—"}</strong></div>
      </div>

      <div className="card">
        <div className="report-section-title">
          <h2>بيانات آخر مسابقة</h2>
        </div>
        {!room?.lastGame?.players?.length ? (
          <p className="muted">لا توجد بيانات محفوظة لآخر مسابقة حتى الآن.</p>
        ) : (
          <div className="question-list">
            {room.lastGame.players.map((player) => (
              <div className="leaderboard-row" key={`${player.id}-${player.rank}`}>
                <div className="leaderboard-name">
                  <span className="rank">{player.rank}</span>
                  <span>{player.name}</span>
                </div>
                <strong>{player.score || 0}</strong>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="card">
        <div className="report-section-title">
          <h2>المتسابقون المسجلون</h2>
          <button className="small-button" onClick={exportPlayersExcel}>استخراج Excel</button>
        </div>

        {players.length === 0 ? (
          <p className="muted">لا يوجد متسابقون حتى الآن.</p>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table className="admin-bordered-table" style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr style={{ color: "#6b7280", textAlign: "right" }}>
                  <th>الاسم المستعار</th>
                  <th>الاسم الثلاثي</th>
                  <th>رقم الجوال</th>
                  <th>النقاط</th>
                  <th>آخر سؤال</th>
                  <th>الجوكر</th>
                  <th>تحكم</th>
                </tr>
              </thead>
              <tbody>
                {players.map((player) => (
                  <tr key={player.id} style={{ background: "#fbf7ef" }}>
                    <td style={{ padding: "14px", borderRadius: "16px 0 0 16px", fontWeight: 900 }}>{player.name}</td>
                    <td style={{ padding: "14px" }}>{player.fullName || "—"}</td>
                    <td style={{ padding: "14px", direction: "ltr", textAlign: "right" }}>{player.phone || "—"}</td>
                    <td style={{ padding: "14px", fontWeight: 900 }}>{player.score || 0}</td>
                    <td style={{ padding: "14px", fontWeight: 900 }}>{player.lastQuestionPoints > 0 ? `+${player.lastQuestionPoints}` : player.lastQuestionPoints ?? 0}</td>
                    <td style={{ padding: "14px" }}>{player.jokerUsed ? "🃏 مستخدم" : player.pendingJoker ? "🟠 مفعل" : "متاح"}</td>
                    <td style={{ padding: "14px", borderRadius: "0 16px 16px 0", whiteSpace: "nowrap" }}>
                      <button className="small-button" onClick={() => handleGiveJoker(player)}>إضافة جوكر</button>{" "}
                      <button className="small-button" onClick={() => handleAdjustScore(player, 1)}>+ نقاط</button>{" "}
                      <button className="danger small-button" onClick={() => handleAdjustScore(player, -1)}>- نقاط</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="card">
        <div className="report-section-title">
          <h2>تقرير إجابات الأسئلة</h2>
          <button className="small-button" onClick={exportAnswersExcel}>استخراج Excel</button>
        </div>

        {answersByQuestion.every((item) => item.rows.length === 0) ? (
          <p className="muted">لا توجد إجابات محفوظة حتى الآن.</p>
        ) : (
          <div className="question-list">
            {answersByQuestion.map(({ question, questionNumber, ignored, rows }) => {
              const expanded = !!expandedQuestions[question.id];
              const correctCount = rows.filter((row) => row.answer.isCorrect).length;
              const wrongCount = rows.filter((row) => !row.answer.isCorrect).length;
              const jokerCount = rows.filter((row) => row.answer.jokerApplied).length;

              return (
                <div className="saved-question" key={question.id}>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "12px", flexWrap: "wrap" }}>
                    <strong>{questionNumber}. {question.text} {ignored ? "— متجاهل" : ""}</strong>
                    <div style={{ display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap" }}>
                      <span className="question-admin-meta">صح: {correctCount}</span>
                      <span className="question-admin-meta">خطأ: {wrongCount}</span>
                      <span className="question-admin-meta">🃏 {jokerCount}</span>
                      <button className="small-button" onClick={() => toggleQuestion(question.id)}>
                        {expanded ? "إخفاء التفاصيل" : "عرض التفاصيل"}
                      </button>
                    </div>
                  </div>

                  {expanded && (
                    rows.length === 0 ? (
                      <span>لا توجد إجابات لهذا السؤال.</span>
                    ) : (
                      <div style={{ overflowX: "auto" }}>
                        <table className="admin-bordered-table" style={{ width: "100%", borderCollapse: "collapse", marginTop: "8px" }}>
                          <thead>
                            <tr style={{ color: "#6b7280", textAlign: "right" }}>
                              <th>المتسابق</th>
                              <th>الاسم الثلاثي</th>
                              <th>الجوال</th>
                              <th>الإجابة</th>
                              <th>النتيجة</th>
                              <th>النقاط</th>
                              <th>جوكر</th>
                            </tr>
                          </thead>
                          <tbody>
                            {rows.map(({ answer, player, selectedText }) => (
                              <tr key={answer.id}>
                                <td style={{ padding: "8px", fontWeight: 900 }}>{player?.name || answer.playerName}</td>
                                <td style={{ padding: "8px" }}>{player?.fullName || answer.fullName || "—"}</td>
                                <td style={{ padding: "8px", direction: "ltr", textAlign: "right" }}>{player?.phone || answer.phone || "—"}</td>
                                <td style={{ padding: "8px" }}>{selectedText}</td>
                                <td style={{ padding: "8px", color: answer.isCorrect ? "#18733a" : "#a51f1f", fontWeight: 900 }}>{answer.isCorrect ? "صح" : "خطأ"}</td>
                                <td style={{ padding: "8px", fontWeight: 900 }}>{answer.points || 0}</td>
                                <td style={{ padding: "8px" }}>{answer.jokerApplied ? "🃏" : "—"}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function DisplayScreen({ room, players, questions, messages, answers, allAnswers }) {
  if (!room) {
    return (
      <div className="display-frame">
        <div className="display-panel display-home">
          <h1>جاري تحميل المسابقة...</h1>
        </div>
      </div>
    );
  }

  const stage = room.stage || "home";
  const [previewStage, setPreviewStage] = useState(null);
  const displayStage = previewStage || stage;
  const currentQuestion = room?.currentQuestion;
  const currentQuestionIndex = room?.currentQuestionIndex ?? -1;
  const nextQuestion = questions[currentQuestionIndex + 1];

  const currentProcessed =
    room?.processedQuestionId === room?.currentQuestion?.questionId;

  useEffect(() => {
    setPreviewStage(null);
  }, [stage, room?.currentQuestion?.questionId]);

  function previewPreviousStep() {
    const previousByStage = {
      registration: "home",
      question: "registration",
      reveal: "question",
      results: "reveal",
      finished: "results",
    };
    setPreviewStage(previousByStage[displayStage] || null);
  }

  async function startCompetition() {
    if (!questions.length) {
      alert("أضف سؤالًا واحدًا على الأقل قبل بدء المسابقة.");
      return;
    }

    await sendQuestion(questions[0], 0);
  }

  async function goNextQuestion() {
    if (!nextQuestion) {
      await finishGame(players, questions, allAnswers || [], messages);
      return;
    }

    await sendQuestion(nextQuestion, currentQuestionIndex + 1);
  }

  function renderDisplayButton() {
    let mainButton = null;

    if (stage === "home") {
      mainButton = <button onClick={resetAndStartRegistration}>فتح التسجيل للمتسابقين</button>;
    } else if (stage === "registration") {
      mainButton = (
        <button onClick={startCompetition} disabled={questions.length === 0 || players.length === 0}>
          بدء المسابقة
        </button>
      );
    } else if (stage === "question") {
      mainButton = <button onClick={revealCorrectAnswer}>إنهاء السؤال الآن وإظهار الإجابة الصحيحة</button>;
    } else if (stage === "reveal") {
      mainButton = <button onClick={showResults}>إظهار النتائج</button>;
    } else if (stage === "results") {
      mainButton = (
        <button onClick={goNextQuestion} disabled={!currentProcessed}>
          {currentProcessed ? (nextQuestion ? "السؤال التالي" : "إنهاء المسابقة") : "جاري تجميع النتائج..."}
        </button>
      );
    } else if (stage === "finished") {
      mainButton = <button onClick={createOrResetRoom}>العودة للصفحة الرئيسية</button>;
    }

    return (
      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: "10px", flexWrap: "wrap" }}>
        <button
          onClick={previewPreviousStep}
          style={{ minWidth: "auto", padding: "10px 18px", fontSize: "14px", background: "#6b7280" }}
        >
          العودة
        </button>
        <button
          onClick={launchSystemCheck}
          style={{ minWidth: "auto", padding: "10px 18px", fontSize: "14px", background: "#18733a" }}
        >
          هل كل شي تمام؟
        </button>
        {mainButton}
        {previewStage && (
          <button
            onClick={() => setPreviewStage(null)}
            style={{ minWidth: "auto", padding: "10px 18px", fontSize: "14px", background: "#7a6646" }}
          >
            الرجوع للمرحلة الحالية
          </button>
        )}
      </div>
    );
  }

  function renderBottomDisplayActions() {
    if (stage === "home" || stage === "finished") return null;

    return (
      <div
        style={{
          position: "absolute",
          left: "2.2vw",
          right: "2.2vw",
          bottom: "0.8vw",
          display: "flex",
          justifyContent: "center",
          gap: "8px",
          zIndex: 5,
          pointerEvents: "auto",
        }}
      >
        {currentQuestion && (stage === "question" || stage === "reveal") && (
          <button
            onClick={() => ignoreCurrentQuestion(currentQuestion.questionId, players)}
            style={{ minWidth: "auto", padding: "8px 13px", fontSize: "12px", borderRadius: "999px", background: "#7a6646" }}
          >
            تجاهل هذا السؤال
          </button>
        )}
        <button
          className="danger"
          onClick={() => finishGame(players, questions, allAnswers || [], messages)}
          style={{ minWidth: "auto", padding: "8px 13px", fontSize: "12px", borderRadius: "999px" }}
        >
          إنهاء المسابقة الآن
        </button>
      </div>
    );
  }

  return (
    <div className="display-frame">
      <AutoRevealCorrectAnswer room={room} />
      <AutoLockJokers room={room} players={players} />
      <AutoProcessResults room={room} answers={answers} players={players} />

      <div className="display-control-bar">{renderDisplayButton()}</div>

      <div className="display-content-area">
        {displayStage === "home" && (
          <div className="display-panel display-home">
            <h1>{QUIZ_TITLE}</h1>
            <p>{QUIZ_SUBTITLE}</p>
          </div>
        )}

        {displayStage === "registration" && (
          <div className="display-grid-main">
            <div className="display-panel registration-screen">
              <h2>تسجيل اللاعبين</h2>
              <p className="muted">افتح رابط المسابقة من الجوال واكتب اسمك</p>

              <div className="players-grid display-players-grid">
                {players.length === 0 ? (
                  <p className="muted">بانتظار دخول اللاعبين...</p>
                ) : (
                  players.map((player) => (
                    <div className="player-chip" key={player.id}>
                      {player.name}
                    </div>
                  ))
                )}
              </div>
            </div>

            <MessagesPanel messages={messages} />
          </div>
        )}

        {displayStage === "question" && (
          <div className="display-grid-main">
            <QuestionScreen
              question={currentQuestion}
              room={room}
              answers={answers}
              playersCount={players.length}
              isAdmin
              displayMode
            />

            <MessagesPanel messages={messages} />
          </div>
        )}

        {displayStage === "reveal" && (
          <div className="display-grid-main">
            <QuestionScreen
              question={currentQuestion}
              room={room}
              answers={answers}
              playersCount={players.length}
              isAdmin
              displayMode
            />

            <MessagesPanel messages={messages} />
          </div>
        )}

        {displayStage === "results" && (
          <ResultsDisplay room={room} players={players} messages={messages} />
        )}

        {displayStage === "finished" && <FinishedDisplay players={players} messages={messages} />}
      </div>

      {renderBottomDisplayActions()}
    </div>
  );
}

function AdminPanel({ initialView = "control" }) {
  const room = useRoom();
  const players = usePlayers();
  const questions = useQuestions();
  const messages = useMessages();
  const answers = useAnswers(room?.currentQuestion?.questionId);
  const allAnswers = useAllAnswers();

  if (initialView === "settings") {
    return (
      <>
        <div className="admin-toolbar card">
          <a className="link-button" href={`/?admin=${ADMIN_CODE}&view=control`}>
            لوحة التحكم
          </a>

          <a
            className="link-button"
            href={`/?admin=${ADMIN_CODE}&view=display`}
            target="_blank"
            rel="noreferrer"
          >
            صفحة العرض
          </a>

          <button onClick={createOrResetRoom}>تهيئة المسابقة</button>
        </div>

        <QuestionSettings questions={questions} />
      </>
    );
  }

  if (initialView === "display") {
    return (
      <DisplayScreen
        room={room}
        players={players}
        questions={questions}
        messages={messages}
        answers={answers}
        allAnswers={allAnswers}
      />
    );
  }

  if (!room) {
    return (
      <div className="card center-card">
        <h2>تهيئة المسابقة</h2>
        <p className="muted">اضغط الزر لإنشاء غرفة المسابقة لأول مرة.</p>
        <button onClick={createOrResetRoom}>إنشاء المسابقة</button>
      </div>
    );
  }

  return (
    <AdminControl
      room={room}
      players={players}
      questions={questions}
      messages={messages}
      allAnswers={allAnswers}
    />
  );
}

/* Player */

function PlayerTopBar({ player }) {
  if (!player?.name) return null;
  return (
    <div className="card player-identity-bar" style={{ maxWidth: "760px", margin: "0 auto 10px", padding: "12px 16px", display: "flex", justifyContent: "center", alignItems: "center", gap: "10px" }}>
      <strong>👤 {player.name}</strong>
    </div>
  );
}

function JoinForm({ onJoined, room }) {
  const [nickname, setNickname] = useState("");
  const [fullName, setFullName] = useState("");
  const [phone, setPhone] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function join() {
    const cleanNickname = nickname.trim();
    const cleanFullName = fullName.trim();
    const cleanPhone = phone.trim();

    if (!cleanNickname || !cleanFullName || !cleanPhone || loading) return;

    if (room?.stage !== "registration") {
      setError("لم يبدأ تسجيل اللاعبين بعد.");
      return;
    }

    setLoading(true);
    setError("");

    try {
      const duplicateQuery = query(
        collection(db, "rooms", ROOM_ID, "players"),
        where("name", "==", cleanNickname)
      );
      const duplicateSnap = await getDocs(duplicateQuery);

      if (!duplicateSnap.empty) {
        setError("الاسم المستعار مستخدم بالفعل. اختر اسمًا آخر.");
        setLoading(false);
        return;
      }

      const playerRef = await addDoc(collection(db, "rooms", ROOM_ID, "players"), {
        name: cleanNickname,
        fullName: cleanFullName,
        phone: cleanPhone,
        score: 0,
        answeredCount: 0,
        pendingJoker: false,
        jokerUsed: false,
        jokerQuestionId: null,
        jokerQuestionNumber: null,
        joinedAt: serverTimestamp(),
      });

      localStorage.setItem("familyQuizPlayerId", playerRef.id);
      localStorage.setItem("familyQuizPlayerName", cleanNickname);
      localStorage.setItem("familyQuizPlayerFullName", cleanFullName);
      localStorage.setItem("familyQuizPlayerPhone", cleanPhone);

      onJoined(playerRef.id, cleanNickname);
    } catch (err) {
      console.error(err);
      setError("تعذر الانضمام. تأكد من إعداد Firebase وقواعد Firestore.");
    } finally {
      setLoading(false);
    }
  }

  if (room?.stage !== "registration") {
    return (
      <div className="join-card card">
        <h2>بانتظار فتح التسجيل</h2>
        <p className="muted">عندما يفتح المقدم التسجيل، سيظهر لك نموذج الدخول هنا.</p>
      </div>
    );
  }

  return (
    <div className="join-card card">
      <h2>انضم للمسابقة</h2>
      <p className="muted">اكتب بياناتك. الاسم المستعار هو الذي سيظهر أثناء البث.</p>

      <input
        value={nickname}
        onChange={(event) => setNickname(event.target.value)}
        placeholder="الاسم المستعار"
      />

      <input
        value={fullName}
        onChange={(event) => setFullName(event.target.value)}
        placeholder="الاسم الثلاثي"
        style={{ marginTop: "10px" }}
      />

      <input
        value={phone}
        onChange={(event) => setPhone(event.target.value)}
        onKeyDown={(event) => event.key === "Enter" && join()}
        placeholder="رقم الجوال"
        inputMode="tel"
        style={{ marginTop: "10px", direction: "ltr", textAlign: "right" }}
      />

      {error && <div className="error-box">{error}</div>}

      <button onClick={join} disabled={loading || !nickname.trim() || !fullName.trim() || !phone.trim()}>
        {loading ? "جاري الدخول..." : "دخول"}
      </button>
    </div>
  );
}

function PlayerChat({ playerId, playerName }) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);

  async function sendMessage() {
    const cleanText = text.trim();

    if (!cleanText || sending) return;

    setSending(true);

    await addDoc(collection(db, "rooms", ROOM_ID, "messages"), {
      playerId,
      playerName,
      text: cleanText,
      createdAtMs: getNow(),
      createdAt: serverTimestamp(),
    });

    setText("");
    setSending(false);
  }

  return (
    <div className="player-chat card">
      <div className="chat-input-area" style={{ marginTop: 0 }}>
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && sendMessage()}
          placeholder="اكتب رسالة تظهر عند المقدم"
        />

        <button onClick={sendMessage} disabled={!text.trim() || sending}>
          {sending ? "جاري الإرسال..." : "إرسال"}
        </button>
      </div>
    </div>
  );
}

function PlayerWaiting({ room, player, players, setPlayerName, hasNextQuestion = false }) {
  const stage = room?.stage;
  const [editingInfo, setEditingInfo] = useState(false);
  const [newNickname, setNewNickname] = useState(player?.name || "");
  const [newFullName, setNewFullName] = useState(player?.fullName || "");
  const [newPhone, setNewPhone] = useState(player?.phone || "");
  const [editError, setEditError] = useState("");

  const rank = players.findIndex((p) => p.id === player?.id) + 1;

  useEffect(() => {
    setNewNickname(player?.name || "");
    setNewFullName(player?.fullName || "");
    setNewPhone(player?.phone || "");
  }, [player?.name, player?.fullName, player?.phone]);

  async function savePlayerInfo() {
    const cleanNickname = newNickname.trim();
    const cleanFullName = newFullName.trim();
    const cleanPhone = newPhone.trim();

    if (!cleanNickname || !cleanFullName || !cleanPhone || !player?.id) {
      setEditError("عبّئ البيانات الثلاثة.");
      return;
    }

    const nicknameUsed = players.some(
      (item) =>
        item.id !== player.id &&
        String(item.name || "").trim().toLowerCase() === cleanNickname.toLowerCase()
    );

    if (nicknameUsed) {
      setEditError("هذا الاسم المستعار مستخدم، اختر اسمًا آخر.");
      return;
    }

    await updateDoc(doc(db, "rooms", ROOM_ID, "players", player.id), {
      name: cleanNickname,
      fullName: cleanFullName,
      phone: cleanPhone,
    });

    localStorage.setItem("familyQuizPlayerName", cleanNickname);
    localStorage.setItem("familyQuizPlayerFullName", cleanFullName);
    localStorage.setItem("familyQuizPlayerPhone", cleanPhone);
    setPlayerName(cleanNickname);
    setEditError("");
    setEditingInfo(false);
  }

  let title = "تم التسجيل بنجاح";
  let text = "انتظر حتى يتم إرسال السؤال من المقدم.";

  if (stage === "results") {
    title = "انتظر السؤال التالي";
    text = "يمكنك استخدام الجوكر للسؤال القادم إذا لم تستخدمه بعد.";
  }

  if (stage === "finished") {
    if (rank >= 1 && rank <= 3) {
      title = `مبروك فزت بالمركز ${rank}`;
      text = `نقاطك النهائية: ${player?.score || 0}`;
    } else {
      title = "انتهت المسابقة";
      text = "شكرًا لمشاركتك.";
    }
  }

  return (
    <div className="main-column">
      <div className="waiting-card card">
        <div className="big-icon">⏳</div>

        <h2>{title}</h2>
        <p className="muted">{text}</p>

        {stage === "registration" && (
          <div className="edit-name-box">
            {editingInfo ? (
              <>
                <input
                  value={newNickname}
                  onChange={(e) => setNewNickname(e.target.value)}
                  placeholder="الاسم المستعار"
                />
                <input
                  value={newFullName}
                  onChange={(e) => setNewFullName(e.target.value)}
                  placeholder="الاسم الثلاثي"
                />
                <input
                  value={newPhone}
                  onChange={(e) => setNewPhone(e.target.value)}
                  placeholder="رقم الجوال"
                  inputMode="tel"
                  style={{ direction: "ltr", textAlign: "right" }}
                />
                {editError && <div className="error-box">{editError}</div>}
                <button onClick={savePlayerInfo}>حفظ التعديل</button>
                <button onClick={() => { setEditingInfo(false); setEditError(""); }}>إلغاء</button>
              </>
            ) : (
              <button onClick={() => setEditingInfo(true)}>تعديل البيانات</button>
            )}
          </div>
        )}

        {(stage === "registration" || (stage === "results" && hasNextQuestion)) && (
          <JokerControl player={player} stage={stage} />
        )}

        <div className="score-box">
          <span>نقاطك الحالية</span>
          <strong>{player?.score || 0}</strong>
        </div>
      </div>

      <PlayerChat playerId={player.id} playerName={player.name} />
    </div>
  );
}

function PlayerResultSummary({ player, players, lastAnswer, stage, hasNextQuestion = false }) {
  const rank = players.findIndex((p) => p.id === player?.id) + 1;
  const points = lastAnswer?.points || 0;
  const basePoints = lastAnswer?.basePoints || 0;
  const isCorrect = !!lastAnswer?.isCorrect;
  const jokerApplied = !!lastAnswer?.jokerApplied;
  const isResults = stage === "results";

  return (
    <div className="main-column">
      <div className="waiting-card card">
        <div className="big-icon">{isCorrect ? "✅" : "❌"}</div>

        <h2>{isCorrect ? "إجابتك صحيحة" : "إجابتك خاطئة"}</h2>

        {isResults ? (
          <div
            className={
              points < 0
                ? "player-points-animation negative"
                : "player-points-animation"
            }
          >
            <span>نقاط هذا السؤال</span>
            <strong>
              {jokerApplied ? "🃏 " : ""}
              {points > 0 ? "+" : ""}
              {points} نقطة
            </strong>
            {jokerApplied && isCorrect && (
              <small style={{ fontWeight: 900, opacity: 0.82 }}>{basePoints} ×3</small>
            )}
            {jokerApplied && !isCorrect && (
              <small style={{ fontWeight: 900, opacity: 0.82 }}>خصم قيمة السؤال الأصلية: {basePoints}</small>
            )}
          </div>
        ) : (
          <p className="muted">سيتم حساب نقاطك عند إظهار النتائج.</p>
        )}

        <div className="score-box">
          <span>مجموع نقاطك</span>
          <strong>{player?.score || 0}</strong>
        </div>

        {isResults && (
          <p className="muted">
            ترتيبك الحالي بين المتسابقين: {rank || "—"}
          </p>
        )}

        {stage === "results" && hasNextQuestion && (
          <JokerControl player={player} stage={stage} />
        )}
      </div>

      <PlayerChat playerId={player.id} playerName={player.name} />
    </div>
  );
}

function PlayerFinalScreen({ player, players }) {
  const rank = players.findIndex((item) => item.id === player?.id) + 1;
  const isWinner = rank >= 1 && rank <= 3;

  return (
    <div className="main-column">
      <div className="waiting-card card" style={{ textAlign: "center", background: isWinner ? "#fff7df" : undefined }}>
        <div className="big-icon">{isWinner ? "🏆" : "🎉"}</div>
        <h2>{isWinner ? `مبروك! فزت بالمركز ${rank}` : "حظ أوفر"}</h2>
        {!isWinner && <p className="muted">ترتيبك النهائي: {rank || "—"}</p>}
        <div className="score-box">
          <span>نقاطك النهائية</span>
          <strong>{player?.score || 0}</strong>
        </div>
      </div>

      <PlayerChat playerId={player.id} playerName={player.name} />
    </div>
  );
}


function PlayerHealthCheck({ room, player }) {
  const check = room?.healthCheck;
  const [answered, setAnswered] = useState(() =>
    localStorage.getItem("familyQuizLastHealthCheck") === check?.id
  );

  useEffect(() => {
    setAnswered(localStorage.getItem("familyQuizLastHealthCheck") === check?.id);
  }, [check?.id]);

  if (!check?.active || !player?.id || answered) return null;

  async function submitHealth(answerText) {
    await answerSystemCheck({
      playerId: player.id,
      playerName: player.name,
      answerText,
    });
    localStorage.setItem("familyQuizLastHealthCheck", check.id);
    setAnswered(true);
  }

  return (
    <div className="card" style={{ maxWidth: "760px", margin: "0 auto 10px", textAlign: "center", background: "#fff7df", borderColor: "#ead69c" }}>
      <strong>{check.question || "هل كل شي تمام؟"}</strong>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "8px", marginTop: "10px" }}>
        <button onClick={() => submitHealth("كل شي تمام")}>كل شي تمام</button>
        <button className="danger" onClick={() => submitHealth("في مشكلة")}>في مشكلة</button>
      </div>
    </div>
  );
}

function PlayerPanel() {
  const room = useRoom();
  const players = usePlayers();
  const questions = useQuestions();
  const answers = useAnswers(room?.currentQuestion?.questionId);

  const [playerId, setPlayerId] = useState(() =>
    localStorage.getItem("familyQuizPlayerId")
  );

  const [playerName, setPlayerName] = useState(() =>
    localStorage.getItem("familyQuizPlayerName")
  );

  const [answeredQuestionId, setAnsweredQuestionId] = useState(null);
  const [selectedIndex, setSelectedIndex] = useState(null);
  const [answerMessage, setAnswerMessage] = useState("");
  const [frozenProgressPercent, setFrozenProgressPercent] = useState(null);

  const player = players.find((item) => item.id === playerId);
  const currentQuestion = room?.currentQuestion;
  const stage = room?.stage || "home";
  const currentQuestionIndex = room?.currentQuestionIndex ?? -1;
  const hasNextQuestion = !!questions[currentQuestionIndex + 1];
  const lastAnswer = answers.find((answer) => answer.playerId === playerId);

  useEffect(() => {
    setSelectedIndex(null);
    setAnswerMessage("");
    setFrozenProgressPercent(null);
    setAnsweredQuestionId(null);
  }, [currentQuestion?.questionId]);


  async function submitAnswer(index) {
    if (!playerId || !playerName || !currentQuestion || !player) return;
    if (answeredQuestionId === currentQuestion.questionId) return;
    if (lastAnswer) return;

    const answeredAt = getNow();
    const revealCountdown = getRevealCountdown(currentQuestion, room, answeredAt);

    if (stage !== "question" || revealCountdown === null || revealCountdown > 0) return;

    const isCorrect = index === currentQuestion.correctIndex;
    const frozenPercent = getPointsProgressPercent(
      currentQuestion,
      room,
      answeredAt
    );

    const basePoints = calculateBasePoints({
      question: currentQuestion,
      room,
      answeredAt,
    });

    const jokerApplied =
      !!player.jokerUsed && player.jokerQuestionId === currentQuestion.questionId;

    const points = calculateFinalPoints({
      isCorrect,
      basePoints,
      jokerApplied,
    });

    setSelectedIndex(index);
    setFrozenProgressPercent(frozenPercent);
    setAnsweredQuestionId(currentQuestion.questionId);
    setAnswerMessage("تم إرسال إجابتك");

    await addDoc(collection(db, "rooms", ROOM_ID, "answers"), {
      playerId,
      playerName: player?.name || playerName,
      fullName: player?.fullName || "",
      phone: player?.phone || "",
      questionId: currentQuestion.questionId,
      selectedIndex: index,
      isCorrect,
      basePoints,
      jokerApplied,
      points,
      answeredAt,
      createdAt: serverTimestamp(),
    });
  }

  if (!playerId || !player) {
    return (
      <JoinForm
        room={room}
        onJoined={(id, name) => {
          setPlayerId(id);
          setPlayerName(name);
        }}
      />
    );
  }

  if (stage === "finished") {
    return (
      <>
        <PlayerTopBar player={player} />
        <PlayerHealthCheck room={room} player={player} />
        <PlayerFinalScreen player={player} players={players} />
      </>
    );
  }

  if ((stage === "reveal" || stage === "results") && currentQuestion) {
    return (
      <>
        <PlayerTopBar player={player} />
        <PlayerHealthCheck room={room} player={player} />
        <PlayerResultSummary
        player={player}
        players={players}
        lastAnswer={lastAnswer}
        stage={stage}
        hasNextQuestion={hasNextQuestion}
      />
      </>
    );
  }

  if (stage !== "question" || !currentQuestion) {
    return (
      <>
        <PlayerTopBar player={player} />
        <PlayerHealthCheck room={room} player={player} />
        <PlayerWaiting
        room={room}
        player={player}
        players={players}
        setPlayerName={setPlayerName}
        hasNextQuestion={hasNextQuestion}
      />
      </>
    );
  }

  return (
    <>
      <PlayerTopBar player={player} />
      <PlayerHealthCheck room={room} player={player} />
      <div className="main-column">
        <QuestionScreen
        question={currentQuestion}
        room={room}
        onAnswer={submitAnswer}
        selectedIndex={selectedIndex ?? lastAnswer?.selectedIndex ?? null}
        answerMessage={answerMessage || (lastAnswer ? "تم إرسال إجابتك" : "")}
        frozenProgressPercent={frozenProgressPercent}
        currentPlayer={player}
      />

        <PlayerChat playerId={playerId} playerName={player?.name || playerName} />
      </div>
    </>
  );
}

/* App */

export default function App() {
  const searchParams = new URLSearchParams(window.location.search);
  const isAdmin = searchParams.get("admin") === ADMIN_CODE;
  const viewParam = searchParams.get("view");

  const adminView =
    viewParam === "settings" || viewParam === "display" || viewParam === "control"
      ? viewParam
      : "control";

  if (isAdmin && adminView === "display") {
    return (
      <div className="display-app" dir="rtl">
        <AdminPanel initialView="display" />
      </div>
    );
  }

  return (
    <div className="app" dir="rtl">
      <header className="app-header">
        <div>
          <h1>{QUIZ_TITLE}</h1>
          <p>{QUIZ_SUBTITLE}</p>
        </div>

        {isAdmin ? (
          <span className="admin-badge">
            {adminView === "settings" ? "صفحة الإعداد" : "لوحة التحكم"}
          </span>
        ) : null}
      </header>

      {isAdmin ? <AdminPanel initialView={adminView} /> : <PlayerPanel />}
    </div>
  );
}
