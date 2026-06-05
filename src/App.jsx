import { Fragment, useEffect, useRef, useState } from "react";
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
  arrayUnion,
  runTransaction,
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
const SCORE_ANIMATION_HOLD_MS = 850;
const QUESTION_START_SYNC_BUFFER_MS = 300;
const DEFAULT_PACKAGE_ID = "default";
const DEFAULT_PACKAGE_NAME = "المسابقة الحالية";

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

function vibrateDevice(pattern) {
  try {
    navigator.vibrate?.(pattern);
  } catch {
    // Some devices and browsers intentionally do not expose vibration.
  }
}

function playCountdownBeep(timeLeft = 3) {
  try {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) return;
    const audioContext = new AudioContextClass();
    const now = audioContext.currentTime;

    function bellStrike({ start, base = 880, duration = 0.34, volume = 0.11 }) {
      const begin = now + start;
      const master = audioContext.createGain();
      master.gain.setValueAtTime(0.001, begin);
      master.gain.exponentialRampToValueAtTime(volume, begin + 0.008);
      master.gain.exponentialRampToValueAtTime(0.001, begin + duration);
      master.connect(audioContext.destination);

      [1, 2.01, 2.72].forEach((ratio, index) => {
        const oscillator = audioContext.createOscillator();
        const gain = audioContext.createGain();
        oscillator.type = index === 0 ? "triangle" : "sine";
        oscillator.frequency.setValueAtTime(base * ratio, begin);
        oscillator.frequency.exponentialRampToValueAtTime(base * ratio * 0.985, begin + duration);
        gain.gain.setValueAtTime(index === 0 ? 0.95 : 0.28, begin);
        gain.gain.exponentialRampToValueAtTime(0.001, begin + duration * (index === 0 ? 0.92 : 0.68));
        oscillator.connect(gain);
        gain.connect(master);
        oscillator.start(begin);
        oscillator.stop(begin + duration + 0.03);
      });
    }

    if (timeLeft <= 1) {
      bellStrike({ start: 0, base: 1040, duration: 0.28, volume: 0.13 });
      bellStrike({ start: 0.24, base: 1240, duration: 0.36, volume: 0.15 });
    } else if (timeLeft === 2) {
      bellStrike({ start: 0, base: 940, duration: 0.32, volume: 0.12 });
    } else {
      bellStrike({ start: 0, base: 820, duration: 0.3, volume: 0.105 });
    }

    setTimeout(() => audioContext.close?.(), timeLeft <= 1 ? 820 : 560);
  } catch {
    // Browsers can block audio until the page has received a user gesture.
  }
}

function useCountdownBeeps({ active, timeLeft, questionId }) {
  const lastBeepRef = useRef("");

  useEffect(() => {
    if (!active || !questionId || timeLeft < 1 || timeLeft > 3) return;
    const beepKey = `${questionId}-${timeLeft}`;
    if (lastBeepRef.current === beepKey) return;
    lastBeepRef.current = beepKey;
    playCountdownBeep(timeLeft);
    vibrateDevice(timeLeft <= 1 ? [50, 35, 70, 35, 150] : timeLeft === 2 ? [45, 30, 70] : [55]);
  }, [active, timeLeft, questionId]);

  useEffect(() => {
    lastBeepRef.current = "";
  }, [questionId]);
}

function getAccuracyColor(percent) {
  const hue = Math.round(clamp(Number(percent) || 0, 0, 100) * 1.2);
  return `hsl(${hue} 72% 34%)`;
}

function toMillis(value) {
  if (!value) return null;
  if (typeof value === "number") return value;
  if (typeof value.toMillis === "function") return value.toMillis();
  return null;
}

function getRoomQuestionSentAt(room) {
  return (
    Number(room?.questionStartedAtMs) ||
    Number(room?.currentQuestion?.questionStartedAtMs) ||
    Number(room?.currentQuestion?.sentAtMs) ||
    toMillis(room?.questionSentAt) ||
    null
  );
}

function getQuestionStartAt(room, question = null) {
  return (
    Number(room?.questionStartedAtMs) ||
    Number(room?.currentQuestion?.questionStartedAtMs) ||
    Number(question?.questionStartedAtMs) ||
    Number(question?.sentAtMs) ||
    null
  );
}

function getServerNow(_room, localNow = getNow()) {
  return localNow;
}

function isMediaQuestion(question) {
  return question?.type === "audio" || question?.type === "video";
}

function getQuestionMediaUrl(question) {
  return question?.mediaUrl || question?.audioUrl || question?.videoUrl || "";
}

function hasMediaEnded(room, question = null) {
  return !!(
    toMillis(room?.mediaEndedAt) ||
    toMillis(room?.audioEndedAt) ||
    Number(room?.currentQuestion?.mediaEndedAtMs) ||
    Number(question?.mediaEndedAtMs) ||
    question?.fallbackMediaEndedAt
  );
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
  const revealDelayMs = getRevealDelayMs(question);
  const explicitAnswerStartAt =
    Number(room?.answerRevealAtMs) ||
    Number(room?.currentQuestion?.answerRevealAtMs) ||
    Number(room?.currentQuestion?.answerStartAtMs) ||
    Number(question?.answerRevealAtMs) ||
    Number(question?.answerStartAtMs) ||
    null;
  const mediaEndedAtMs =
    toMillis(room?.mediaEndedAt) ||
    toMillis(room?.audioEndedAt) ||
    Number(room?.currentQuestion?.mediaEndedAtMs) ||
    Number(question?.mediaEndedAtMs) ||
    null;

  if (isMediaQuestion(question) && mediaEndedAtMs) {
    return mediaEndedAtMs + revealDelayMs;
  }

  const questionSentAtMs = getRoomQuestionSentAt(room);
  if (!isMediaQuestion(question) && questionSentAtMs) {
    return explicitAnswerStartAt || questionSentAtMs + revealDelayMs;
  }

  return explicitAnswerStartAt;
}


function getQuestionTimeLeft(question, room, localNow) {
  if (!question) return 0;

  const serverNow = getServerNow(room, localNow);
  const answerStartAt = getAnswerStartAt(room, question);

  if (!answerStartAt) return 0;

  const seconds = Number(question.seconds || 20);
  const endAt =
    Number(room?.answerEndAtMs) ||
    Number(room?.currentQuestion?.answerEndAtMs) ||
    Number(question?.answerEndAtMs) ||
    answerStartAt + seconds * 1000;

  return Math.max(0, Math.ceil((endAt - serverNow) / 1000));
}

async function extendQuestionTime(room, seconds = 10) {
  const question = room?.currentQuestion;
  if (!question || room?.stage !== "question") return;

  const answerStartAt = getAnswerStartAt(room, question);
  if (!answerStartAt) return;

  const currentEndAt =
    Number(room?.answerEndAtMs) ||
    Number(question?.answerEndAtMs) ||
    answerStartAt + Number(question.seconds || 20) * 1000;
  const nextEndAt = Math.max(currentEndAt, getNow()) + seconds * 1000;

  await updateDoc(doc(db, "rooms", ROOM_ID), {
    answerEndAtMs: nextEndAt,
    "currentQuestion.answerEndAtMs": nextEndAt,
    updatedAt: serverTimestamp(),
  });
}

function getRevealCountdown(question, room, localNow) {
  if (!question) return null;

  const serverNow = getServerNow(room, localNow);
  const answerStartAt = getAnswerStartAt(room, question);

  if (!answerStartAt) return null;

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

function calculateFinalPoints({ isCorrect, basePoints, jokerApplied, jokerMultiplier = 3 }) {
  if (jokerApplied) {
    const multiplier = Number(jokerMultiplier || 3);
    return isCorrect ? basePoints * multiplier : -basePoints;
  }

  return isCorrect ? basePoints : 0;
}

function getJokerMultiplier(player, question) {
  if (!player || !question) return 1;
  if (question.isPractice) {
    const samePracticeQuestion =
      player.practiceJokerQuestionId === question.questionId ||
      player.practiceJokerQuestionId === question.id;
    if (!samePracticeQuestion) return 1;
    return Number(player.practiceJokerMultiplier || (player.practiceJokerTiming === "during" ? 2 : 3) || 1);
  }
  const sameQuestion = player.jokerQuestionId === question.questionId || player.jokerQuestionId === question.id;
  if (!player.jokerUsed || !sameQuestion) return 1;
  return Number(player.jokerMultiplier || (player.jokerTiming === "during" ? 2 : 3) || 3);
}

function getJokerTimingLabel(multiplier) {
  return Number(multiplier) === 2 ? "x2" : "x3";
}

function getMainQuestions(questions = []) {
  return questions.filter((question) => !question.isPractice);
}

function getPracticeQuestions(questions = []) {
  return questions.filter((question) => !!question.isPractice).slice(0, 3);
}

const PLAYER_EMOJIS = [
  "\u{1F600}",
  "\u{1F60E}",
  "\u{1F929}",
  "\u{1F973}",
  "\u{1F914}",
  "\u{1F642}",
  "\u{1F525}",
  "\u{2B50}",
  "\u{1F3AF}",
  "\u{1F680}",
  "\u{1F451}",
  "\u{1F340}",
];

function normalizePhoneDigits(value = "") {
  return String(value)
    .replace(/[\u0660-\u0669]/g, (d) => "٠١٢٣٤٥٦٧٨٩".indexOf(d))
    .replace(/[\u06f0-\u06f9]/g, (d) => "۰۱۲۳۴۵۶۷۸۹".indexOf(d))
    .replace(/\D/g, "");
}

function isValidSaudiMobile(value = "") {
  return normalizePhoneDigits(value).length === 10;
}

function getRevealDelayMs(question) {
  const seconds = Number(question?.answerRevealDelaySeconds ?? question?.revealDelaySeconds);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  return isMediaQuestion(question) ? MEDIA_REVEAL_OPTIONS_DELAY_MS : REVEAL_OPTIONS_DELAY_MS;
}

function AnimatedNumber({ value = 0, duration = 700 }) {
  const [displayValue, setDisplayValue] = useState(Number(value) || 0);
  const displayValueRef = useRef(Number(value) || 0);

  useEffect(() => {
    const start = Number(displayValueRef.current) || 0;
    const end = Number(value) || 0;
    if (start === end) return;

    const startedAt = performance.now();
    let frameId;

    function tick(now) {
      const progress = clamp((now - startedAt) / duration, 0, 1);
      const eased = 1 - Math.pow(1 - progress, 3);
      const nextValue = Math.round(start + (end - start) * eased);
      displayValueRef.current = nextValue;
      setDisplayValue(nextValue);
      if (progress < 1) frameId = requestAnimationFrame(tick);
    }

    frameId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frameId);
  }, [duration, value]);

  return <>{displayValue}</>;
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
        const list = snap.docs
          .map((d) => ({
            id: d.id,
            ...d.data(),
          }))
          .filter((player) => !isVisitorRecord(player));

        list.sort((a, b) => (b.score || 0) - (a.score || 0));
        setPlayers(list);
      }
    );

    return () => unsub();
  }, []);

  return players;
}

function useQuestions(activePackageId = DEFAULT_PACKAGE_ID) {
  const [questions, setQuestions] = useState([]);

  useEffect(() => {
    const packageId = activePackageId || DEFAULT_PACKAGE_ID;
    const questionsRef = collection(db, "rooms", ROOM_ID, "questions");
    const questionsSource =
      packageId === DEFAULT_PACKAGE_ID
        ? questionsRef
        : query(questionsRef, where("packageId", "==", packageId));

    const unsub = onSnapshot(
      questionsSource,
      (snap) => {
        const list = snap.docs.map((d) => ({
          id: d.id,
          ...d.data(),
        }));

        const filtered = list.filter((question) => {
          const questionPackageId = question.packageId || DEFAULT_PACKAGE_ID;
          return questionPackageId === packageId;
        });

        filtered.sort((a, b) => (a.order || 0) - (b.order || 0));
        setQuestions(filtered);
      }
    );

    return () => unsub();
  }, [activePackageId]);

  return questions;
}

function useQuestionPackages() {
  const [packages, setPackages] = useState([]);

  useEffect(() => {
    const unsub = onSnapshot(doc(db, "rooms", ROOM_ID), (snap) => {
      const data = snap.exists() ? snap.data() : {};
      const savedPackages = Array.isArray(data.questionPackages) ? data.questionPackages : [];
      const cleanedPackages = savedPackages
        .filter((item) => item?.id && item.id !== DEFAULT_PACKAGE_ID)
        .map((item) => ({
          id: item.id,
          name: item.name || DEFAULT_PACKAGE_NAME,
          createdAtMs: Number(item.createdAtMs || 0),
        }))
        .sort((a, b) => Number(a.createdAtMs || 0) - Number(b.createdAtMs || 0));

      setPackages([
        { id: DEFAULT_PACKAGE_ID, name: DEFAULT_PACKAGE_NAME, createdAtMs: 0 },
        ...cleanedPackages,
      ]);
    });

    return () => unsub();
  }, []);

  return packages;
}

function useAllQuestions() {
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

function useVisitors() {
  const [visitors, setVisitors] = useState([]);

  useEffect(() => {
    const unsub = onSnapshot(
      collection(db, "rooms", ROOM_ID, "players"),
      (snap) => {
        setVisitors(
          snap.docs
            .map((d) => ({
              id: d.id,
              ...d.data(),
            }))
            .filter((item) => isVisitorRecord(item))
        );
      }
    );

    return () => unsub();
  }, []);

  return visitors;
}

function getOrCreateVisitorId() {
  const storageKey = "familyQuizVisitorId";
  const existing = localStorage.getItem(storageKey);
  if (existing) return existing;
  const id = `visitor-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
  localStorage.setItem(storageKey, id);
  return id;
}

function isVisitorRecord(item) {
  return !!item?.isVisitorOnly || String(item?.id || "").startsWith("visitor-");
}

/* Firebase actions */

async function createOrResetRoom() {
  await setDoc(
    doc(db, "rooms", ROOM_ID),
    {
      title: QUIZ_TITLE,
      subtitle: QUIZ_SUBTITLE,
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
      collectingBonusByPlayer: {},
      collectingBonusJokerByPlayer: {},
      collectingBonusPlayerId: null,
      collectingBonusPoints: 0,
      rankMovementByPlayer: {},
      activePackageId: DEFAULT_PACKAGE_ID,
      activePackageName: DEFAULT_PACKAGE_NAME,
      updatedAt: serverTimestamp(),
    },
    { merge: true }
  );
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

async function clearAnswersAndMessages() {
  await clearCollection(["rooms", ROOM_ID, "answers"]);
  await clearCollection(["rooms", ROOM_ID, "messages"]);
  await createOrResetRoom();
}

async function clearMessagesOnly() {
  await clearCollection(["rooms", ROOM_ID, "messages"]);
}

async function hardResetGame() {
  await resetPlayersAnswersMessages();
  await createOrResetRoom();
}

async function showInstructionsPage() {
  await setDoc(
    doc(db, "rooms", ROOM_ID),
    {
      title: QUIZ_TITLE,
      subtitle: QUIZ_SUBTITLE,
      stage: "instructions",
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
      healthCheck: { active: false },
      practiceMode: false,
      updatedAt: serverTimestamp(),
    },
    { merge: true }
  );
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
      healthCheck: { active: false },
      practiceMode: false,
      practiceFinished: false,
      updatedAt: serverTimestamp(),
    },
    { merge: true }
  );
}

function buildQuestionPayload(question, questionStartedAtMs = getNow() + QUESTION_START_SYNC_BUFFER_MS) {
  const revealDelayMs = getRevealDelayMs(question);
  const answerRevealAtMs = isMediaQuestion(question) ? null : questionStartedAtMs + revealDelayMs;
  const answerEndAtMs = answerRevealAtMs
    ? answerRevealAtMs + Number(question.seconds || question.time || 20) * 1000
    : null;

  const cleanQuestion = {
    ...question,
    questionId: question.id,
    questionStartedAtMs,
    sentAtMs: questionStartedAtMs,
    answerRevealAtMs,
    answerStartAtMs: answerRevealAtMs,
    answerEndAtMs,
    fallbackSentAt: null,
    fallbackMediaStartedAt: null,
    fallbackMediaEndedAt: null,
    imageUrl: question.type === "image" ? question.imageUrl || "" : "",
    questionImageUrl: question.type === "image" ? question.questionImageUrl || question.imageUrl || "" : "",
    optionImageUrls: question.type === "image" ? question.optionImageUrls || [] : [],
    mediaUrl: isMediaQuestion(question) ? getQuestionMediaUrl(question) : "",
    audioUrl: question.type === "audio" ? getQuestionMediaUrl(question) : "",
    videoUrl: question.type === "video" ? getQuestionMediaUrl(question) : "",
    isPractice: !!question.isPractice,
    practiceNote: question.isPractice ? "هذا السؤال للتدريب فقط ولا يؤثر على النقاط أو الترتيب." : "",
  };

  return {
    cleanQuestion,
    questionStartedAtMs,
    answerRevealAtMs,
    answerStartAtMs: answerRevealAtMs,
    answerEndAtMs,
  };
}

async function preloadQuestionForReady(question, index, readyUntilMs) {
  const stageStartedAtMs = getNow();
  const {
    cleanQuestion,
    questionStartedAtMs,
    answerRevealAtMs,
    answerStartAtMs,
    answerEndAtMs,
  } = buildQuestionPayload(question, readyUntilMs);

  await updateDoc(doc(db, "rooms", ROOM_ID), {
    stage: "ready",
    currentQuestion: cleanQuestion,
    currentQuestionIndex: index,
    questionStartedAtMs,
    answerRevealAtMs,
    answerStartAtMs,
    answerEndAtMs,
    questionSentAt: null,
    audioStartedAt: null,
    audioEndedAt: null,
    mediaStartedAt: null,
    mediaEndedAt: null,
    questionIgnored: false,
    isPractice: !!question.isPractice,
    processedQuestionId: null,
    processingQuestionId: null,
    processingStartedAtMs: null,
    collectingBonusByPlayer: {},
    collectingBonusJokerByPlayer: {},
    collectingBonusPlayerId: null,
    collectingBonusPoints: 0,
    rankMovementByPlayer: {},
    nextQuestionReadyUntilMs: readyUntilMs,
    nextQuestionReadyQuestionIndex: index,
    stageStartedAtMs,
    readyStartedAtMs: stageStartedAtMs,
    revealStartedAtMs: null,
    resultsStartedAtMs: null,
    updatedAt: serverTimestamp(),
  });
}

async function activatePreloadedQuestion() {
  const stageStartedAtMs = getNow();
  await updateDoc(doc(db, "rooms", ROOM_ID), {
    stage: "question",
    questionSentAt: serverTimestamp(),
    nextQuestionReadyUntilMs: null,
    nextQuestionReadyQuestionIndex: null,
    stageStartedAtMs,
    questionStageStartedAtMs: stageStartedAtMs,
    revealStartedAtMs: null,
    resultsStartedAtMs: null,
    updatedAt: serverTimestamp(),
  });
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

async function finishMediaQuestion(question = null) {
  const mediaEndedAtMs = getNow();
  const answerRevealAtMs = mediaEndedAtMs + getRevealDelayMs(question);
  const answerEndAtMs = answerRevealAtMs + Number(question?.seconds || question?.time || 20) * 1000;

  await updateDoc(doc(db, "rooms", ROOM_ID), {
    mediaEndedAt: serverTimestamp(),
    audioEndedAt: serverTimestamp(),
    answerRevealAtMs,
    answerEndAtMs,
    "currentQuestion.mediaEndedAtMs": mediaEndedAtMs,
    "currentQuestion.answerRevealAtMs": answerRevealAtMs,
    "currentQuestion.answerStartAtMs": answerRevealAtMs,
    "currentQuestion.answerEndAtMs": answerEndAtMs,
    "currentQuestion.fallbackMediaEndedAt": null,
    updatedAt: serverTimestamp(),
  });
}

async function endQuestionAndReveal(room, { allowUndo = false } = {}) {
  if (isMediaQuestion(room?.currentQuestion) && !hasMediaEnded(room, room.currentQuestion)) {
    await finishMediaQuestion(room.currentQuestion);
  }

  await revealCorrectAnswer({ allowUndo });
}



async function launchSystemCheck({ question = "هل كل شي تمام؟", okText = "كل شي تمام", problemText = "في مشكلة", title = "استفتاء", kind = "general" } = {}) {
  await setDoc(
    doc(db, "rooms", ROOM_ID),
    {
      healthCheck: {
        id: `check-${getNow()}`,
        active: true,
        title,
        kind,
        question,
        okText,
        problemText,
        createdAtMs: getNow(),
        responses: {},
      },
      updatedAt: serverTimestamp(),
    },
    { merge: true }
  );
}

async function launchInstructionsClarityPoll() {
  await launchSystemCheck({
    title: "تصويت",
    kind: "instructions",
    question: "هل طريقة المسابقة واضحة؟",
    okText: "نعم، واضحة",
    problemText: "لا، أحتاج توضيح",
  });
}

async function stopSystemCheck() {
  await setDoc(
    doc(db, "rooms", ROOM_ID),
    {
      healthCheck: { active: false },
      updatedAt: serverTimestamp(),
    },
    { merge: true }
  );
}

async function answerSystemCheck({ playerId, playerName, answerText }) {
  const answeredAtMs = getNow();
  await updateDoc(doc(db, "rooms", ROOM_ID), {
    [`healthCheck.responses.${playerId}`]: {
      playerId,
      playerName,
      answerText,
      answeredAtMs,
    },
    updatedAt: serverTimestamp(),
  });
}

async function revealCorrectAnswer({ allowUndo = false } = {}) {
  const stageStartedAtMs = getNow();
  await setDoc(
    doc(db, "rooms", ROOM_ID),
    {
      stage: "reveal",
      stageStartedAtMs,
      revealStartedAtMs: stageStartedAtMs,
      resultsStartedAtMs: null,
      revealUndoUntilMs: allowUndo ? getNow() + 3000 : null,
      updatedAt: serverTimestamp(),
    },
    { merge: true }
  );
}

async function reopenQuestion(room) {
  if (room?.stage !== "reveal" || getQuestionTimeLeft(room?.currentQuestion, room, getNow()) <= 0) return;
  const stageStartedAtMs = getNow();
  await setDoc(
    doc(db, "rooms", ROOM_ID),
    {
      stage: "question",
      stageStartedAtMs,
      questionStageStartedAtMs: stageStartedAtMs,
      revealStartedAtMs: null,
      resultsStartedAtMs: null,
      revealUndoUntilMs: null,
      updatedAt: serverTimestamp(),
    },
    { merge: true }
  );
}

async function showResults() {
  const stageStartedAtMs = getNow();
  await setDoc(
    doc(db, "rooms", ROOM_ID),
    {
      stage: "results",
      stageStartedAtMs,
      resultsStartedAtMs: stageStartedAtMs,
      revealUndoUntilMs: null,
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

async function toggleDisplayVideoSlot(enabled) {
  await setDoc(
    doc(db, "rooms", ROOM_ID),
    {
      displayVideoSlotEnabled: !!enabled,
      updatedAt: serverTimestamp(),
    },
    { merge: true }
  );
}

async function archiveLastGame(players = [], questions = [], allAnswers = [], messages = []) {
  const sortedPlayers = [...players].sort((a, b) => (b.score || 0) - (a.score || 0));
  const savedAtMs = getNow();
  const archivedGame = {
    id: `game-${savedAtMs}`,
    savedAtMs,
    title: `${QUIZ_TITLE} - ${new Date(savedAtMs).toLocaleDateString("ar-SA")}`,
    players: sortedPlayers.map((player, index) => ({
      rank: index + 1,
      id: player.id,
      name: player.name || "",
      fullName: player.fullName || "",
      phone: player.phone || "",
      score: player.score || 0,
      jokerUsed: !!player.jokerUsed,
      jokerQuestionNumber: player.jokerQuestionNumber || null,
    })),
    questions: questions.map((question, index) => ({
      id: question.id,
      questionId: question.questionId || question.id,
      order: index + 1,
      text: question.text || "",
      type: question.type || "multiple_choice",
      options: (question.options || []).map(getOptionText),
      correctIndex: Number(question.correctIndex || 0),
      maxPoints: Number(question.maxPoints || 0),
      minPoints: Number(question.minPoints || 0),
      seconds: Number(question.seconds || 0),
      answerRevealDelaySeconds: Number(question.answerRevealDelaySeconds || 0),
    })),
    answers: allAnswers.filter((answer) => !answer.isPractice).map((answer) => ({ ...answer })),
    messages: messages.map((message) => ({
      playerName: message.playerName || "",
      text: message.text || "",
      createdAtMs: message.createdAtMs || 0,
    })),
  };

  await setDoc(
    doc(db, "rooms", ROOM_ID),
    {
      gameHistory: arrayUnion(archivedGame),
      updatedAt: serverTimestamp(),
    },
    { merge: true }
  );
}

async function finishGame(players = [], questions = [], allAnswers = [], messages = []) {
  try {
    await archiveLastGame(players, questions, allAnswers, messages);
  } catch (error) {
    console.error("Could not archive the finished game.", error);
  }
  await setDoc(
    doc(db, "rooms", ROOM_ID),
    {
      stage: "finished",
      updatedAt: serverTimestamp(),
    },
    { merge: true }
  );
}

async function claimQuestionProcessing(questionId) {
  if (!questionId) return false;
  const roomRef = doc(db, "rooms", ROOM_ID);

  return runTransaction(db, async (transaction) => {
    const roomSnap = await transaction.get(roomRef);
    const roomData = roomSnap.exists() ? roomSnap.data() : {};

    if (
      roomData.processedQuestionId === questionId ||
      roomData.processingQuestionId === questionId
    ) {
      return false;
    }

    transaction.set(
      roomRef,
      {
        processingQuestionId: questionId,
        processingStartedAtMs: getNow(),
        updatedAt: serverTimestamp(),
      },
      { merge: true }
    );

    return true;
  });
}


// Called by admin when display page is not open and scores are stuck.
// Reads the current answers and players directly from Firestore and processes them.
async function forceProcessResults(room, players = [], answers = []) {
  const questionId = room?.currentQuestion?.questionId;
  if (!questionId) return;
  if (!(await claimQuestionProcessing(questionId))) return;

  const roomRef = doc(db, "rooms", ROOM_ID);

  try {
    const safeAnswers = Array.isArray(answers) ? answers : [];
    const safePlayers = Array.isArray(players) ? players : [];

    if (room?.currentQuestion?.isPractice) {
      const bonusByPlayer = {};
      const jokerByPlayer = {};
      safeAnswers.filter((answer) => answer && answer.playerId).forEach((answer) => {
        bonusByPlayer[answer.playerId] = Number(answer.points || 0);
        if (answer.jokerApplied) jokerByPlayer[answer.playerId] = getJokerTimingLabel(answer.jokerMultiplier || 3);
      });

      await setDoc(
        roomRef,
        {
          processedQuestionId: questionId,
          collectingBonusByPlayer: bonusByPlayer,
          collectingBonusJokerByPlayer: jokerByPlayer,
          collectingBonusPlayerId: null,
          collectingBonusPoints: 0,
          rankMovementByPlayer: {},
          resultsAnimationPhase: "done",
          processingQuestionId: null,
          processingStartedAtMs: null,
          updatedAt: serverTimestamp(),
        },
        { merge: true }
      );
      return;
    }

    const answersToProcess = [...safeAnswers]
      .filter((a) => a && a.playerId)
      .sort((a, b) => Number(a.answeredAt || 0) - Number(b.answeredAt || 0));

    const bonusByPlayer = {};
    const jokerByPlayer = {};

    answersToProcess.forEach((answer) => {
      bonusByPlayer[answer.playerId] = Number(answer.points || 0);
      if (answer.jokerApplied) jokerByPlayer[answer.playerId] = true;
    });

    const sortedBefore = [...safePlayers].sort(
      (a, b) => Number(b.score || 0) - Number(a.score || 0)
    );
    const previousRankByPlayer = {};
    sortedBefore.forEach((p, i) => { previousRankByPlayer[p.id] = i + 1; });

    const finalPlayers = safePlayers.map((p) => ({
      ...p,
      __finalScore: Number(p.score || 0) + Number(bonusByPlayer[p.id] || 0),
    }));
    const sortedAfter = [...finalPlayers].sort(
      (a, b) => Number(b.__finalScore || 0) - Number(a.__finalScore || 0)
    );
    const rankMovementByPlayer = {};
    sortedAfter.forEach((p, i) => {
      rankMovementByPlayer[p.id] = (previousRankByPlayer[p.id] || i + 1) - (i + 1);
    });

    await Promise.all(
      safePlayers.map(async (player) => {
        const answer = answersToProcess.find((a) => a.playerId === player.id);
        const points = Number(answer?.points || 0);
        await updateDoc(doc(db, "rooms", ROOM_ID, "players", player.id), {
          score: Number(player.score || 0) + points,
          answeredCount: Number(player.answeredCount || 0) + (answer ? 1 : 0),
          lastQuestionPoints: points,
          lastQuestionId: questionId,
          lastAnswerAt: answer ? serverTimestamp() : player.lastAnswerAt || null,
        });
      })
    );

    await setDoc(
      roomRef,
      {
        processedQuestionId: questionId,
        collectingBonusByPlayer: bonusByPlayer,
        collectingBonusJokerByPlayer: jokerByPlayer,
        collectingBonusPlayerId: null,
        collectingBonusPoints: 0,
        rankMovementByPlayer,
        resultsAnimationPhase: "done",
        processingQuestionId: null,
        processingStartedAtMs: null,
        updatedAt: serverTimestamp(),
      },
      { merge: true }
    );
  } catch (error) {
    console.error("forceProcessResults failed:", error);
    // Even on error, unblock the admin so the game can continue
    await setDoc(
      roomRef,
      {
        processedQuestionId: questionId,
        collectingBonusByPlayer: {},
        collectingBonusJokerByPlayer: {},
        collectingBonusPlayerId: null,
        collectingBonusPoints: 0,
        rankMovementByPlayer: {},
        resultsAnimationPhase: "done",
        processingQuestionId: null,
        processingStartedAtMs: null,
        updatedAt: serverTimestamp(),
      },
      { merge: true }
    );
  }
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

      if (!room || !["ready", "question"].includes(room.stage) || !questionId) return;
      if (lockedQuestionId === questionId) return;

      setLockedQuestionId(questionId);

      const playersToLock = players.filter(
        (player) =>
          player.pendingJoker &&
          !player.jokerUsed &&
          player.jokerQuestionId !== questionId
      );
      const practicePlayersToLock = players.filter(
        (player) =>
          room.currentQuestion?.isPractice &&
          player.practicePendingJoker &&
          player.practiceJokerQuestionId !== questionId
      );

      await Promise.all(
        [
          ...playersToLock.map((player) =>
            updateDoc(doc(db, "rooms", ROOM_ID, "players", player.id), {
              pendingJoker: false,
              jokerUsed: true,
              jokerQuestionId: questionId,
              jokerQuestionNumber: questionNumber,
              jokerTiming: "before",
              jokerMultiplier: 3,
              jokerLockedAt: serverTimestamp(),
            })
          ),
          ...practicePlayersToLock.map((player) =>
            updateDoc(doc(db, "rooms", ROOM_ID, "players", player.id), {
              practicePendingJoker: false,
              practiceJokerQuestionId: questionId,
              practiceJokerTiming: "before",
              practiceJokerMultiplier: 3,
              practiceJokerLockedAt: serverTimestamp(),
            })
          ),
        ]
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

function AutoProcessResults({ room, answers = [], players = [] }) {
  const [processingQuestionId, setProcessingQuestionId] = useState(null);

  useEffect(() => {
    async function processScores() {
      const questionId = room?.currentQuestion?.questionId;

      if (!room || room.stage !== "results" || !questionId) return;
      if (room.processedQuestionId === questionId) return;
      if (room.processingQuestionId === questionId) return;
      if (processingQuestionId === questionId) return;

      setProcessingQuestionId(questionId);

      const roomRef = doc(db, "rooms", ROOM_ID);

      try {
        if (!(await claimQuestionProcessing(questionId))) return;

        if (room.currentQuestion?.isPractice) {
          const safeAnswers = Array.isArray(answers) ? answers : [];
          const safePlayers = Array.isArray(players) ? players : [];
          const answersToProcess = [...safeAnswers]
            .filter((answer) => answer && answer.playerId)
            .sort((a, b) => Number(a.answeredAt || 0) - Number(b.answeredAt || 0));
          const bonusByPlayer = {};
          const jokerByPlayer = {};
          answersToProcess.forEach((answer) => {
            bonusByPlayer[answer.playerId] = Number(answer.points || 0);
            if (answer.jokerApplied) jokerByPlayer[answer.playerId] = getJokerTimingLabel(answer.jokerMultiplier || 3);
          });
          const sortedBefore = [...safePlayers].sort((a, b) => Number(b.score || 0) - Number(a.score || 0));
          const previousRankByPlayer = {};
          sortedBefore.forEach((player, index) => {
            previousRankByPlayer[player.id] = index + 1;
          });
          const finalPlayers = safePlayers.map((player) => ({
            ...player,
            __finalScore: Number(player.score || 0) + Number(bonusByPlayer[player.id] || 0),
          }));
          const rankMovementByPlayer = {};
          [...finalPlayers]
            .sort((a, b) => Number(b.__finalScore || 0) - Number(a.__finalScore || 0))
            .forEach((player, index) => {
              rankMovementByPlayer[player.id] = (previousRankByPlayer[player.id] || index + 1) - (index + 1);
            });

          await setDoc(
            roomRef,
            {
              collectingBonusByPlayer: bonusByPlayer,
              collectingBonusJokerByPlayer: jokerByPlayer,
              collectingBonusPlayerId: null,
              collectingBonusPoints: 0,
              rankMovementByPlayer: {},
              resultsAnimationPhase: "showPoints",
              updatedAt: serverTimestamp(),
            },
            { merge: true }
          );

          await new Promise((resolve) => setTimeout(resolve, SCORE_ANIMATION_HOLD_MS || 900));

          await Promise.all(
            safePlayers.map(async (player) => {
              const answer = answersToProcess.find((item) => item.playerId === player.id);
              const points = Number(answer?.points || 0);
              await updateDoc(doc(db, "rooms", ROOM_ID, "players", player.id), {
                score: Number(player.score || 0) + points,
                answeredCount: Number(player.answeredCount || 0) + (answer ? 1 : 0),
                lastQuestionPoints: points,
                lastQuestionId: questionId,
                lastAnswerAt: answer ? serverTimestamp() : player.lastAnswerAt || null,
              });
            })
          );

          await new Promise((resolve) => setTimeout(resolve, 450));

          await setDoc(
            roomRef,
            {
              processedQuestionId: questionId,
              collectingBonusByPlayer: bonusByPlayer,
              collectingBonusJokerByPlayer: jokerByPlayer,
              collectingBonusPlayerId: null,
              collectingBonusPoints: 0,
              rankMovementByPlayer,
              resultsAnimationPhase: "done",
              processingQuestionId: null,
              processingStartedAtMs: null,
              updatedAt: serverTimestamp(),
            },
            { merge: true }
          );
          return;
        }

        if (room.questionIgnored) {
          await setDoc(
            roomRef,
            {
              processedQuestionId: questionId,
              collectingBonusByPlayer: {},
              collectingBonusJokerByPlayer: {},
              collectingBonusPlayerId: null,
              collectingBonusPoints: 0,
              rankMovementByPlayer: {},
              resultsAnimationPhase: "done",
              processingQuestionId: null,
              processingStartedAtMs: null,
              updatedAt: serverTimestamp(),
            },
            { merge: true }
          );
          return;
        }

        const safeAnswers = Array.isArray(answers) ? answers : [];
        const safePlayers = Array.isArray(players) ? players : [];

        const answersToProcess = [...safeAnswers]
          .filter((answer) => answer && answer.playerId)
          .sort((a, b) => Number(a.answeredAt || 0) - Number(b.answeredAt || 0));

        const bonusByPlayer = {};
        const jokerByPlayer = {};

        answersToProcess.forEach((answer) => {
          bonusByPlayer[answer.playerId] = Number(answer.points || 0);
          if (answer.jokerApplied) {
            jokerByPlayer[answer.playerId] = getJokerTimingLabel(answer.jokerMultiplier || 3);
          }
        });

        const sortedBefore = [...safePlayers].sort(
          (a, b) => Number(b.score || 0) - Number(a.score || 0)
        );

        const previousRankByPlayer = {};
        sortedBefore.forEach((player, index) => {
          previousRankByPlayer[player.id] = index + 1;
        });

        const finalPlayers = safePlayers.map((player) => ({
          ...player,
          __finalScore:
            Number(player.score || 0) + (room?.currentQuestion?.isPractice ? 0 : Number(bonusByPlayer[player.id] || 0)),
        }));

        const sortedAfter = [...finalPlayers].sort(
          (a, b) => Number(b.__finalScore || 0) - Number(a.__finalScore || 0)
        );

        const rankMovementByPlayer = {};
        sortedAfter.forEach((player, index) => {
          const previousRank = previousRankByPlayer[player.id] || index + 1;
          const newRank = index + 1;
          rankMovementByPlayer[player.id] = previousRank - newRank;
        });

        await setDoc(
          roomRef,
          {
            collectingBonusByPlayer: bonusByPlayer,
            collectingBonusJokerByPlayer: jokerByPlayer,
            rankMovementByPlayer: {},
            resultsAnimationPhase: "showPoints",
            updatedAt: serverTimestamp(),
          },
          { merge: true }
        );

        await new Promise((resolve) =>
          setTimeout(resolve, SCORE_ANIMATION_HOLD_MS || 900)
        );

        await Promise.all(
          safePlayers.map(async (player) => {
            const answer = answersToProcess.find(
              (item) => item.playerId === player.id
            );

            const points = Number(answer?.points || 0);

            await updateDoc(doc(db, "rooms", ROOM_ID, "players", player.id), {
              score: room?.currentQuestion?.isPractice ? Number(player.score || 0) : Number(player.score || 0) + points,
              answeredCount: Number(player.answeredCount || 0) + (room?.currentQuestion?.isPractice ? 0 : (answer ? 1 : 0)),
              lastQuestionPoints: points,
              lastQuestionId: questionId,
              lastAnswerAt: answer ? serverTimestamp() : player.lastAnswerAt || null,
            });
          })
        );

        await new Promise((resolve) => setTimeout(resolve, 450));

        await setDoc(
          roomRef,
          {
            processedQuestionId: questionId,
            collectingBonusByPlayer: bonusByPlayer,
            collectingBonusJokerByPlayer: jokerByPlayer,
            collectingBonusPlayerId: null,
            collectingBonusPoints: 0,
            rankMovementByPlayer,
            resultsAnimationPhase: "done",
            processingQuestionId: null,
            processingStartedAtMs: null,
            updatedAt: serverTimestamp(),
          },
          { merge: true }
        );
      } catch (error) {
        console.error("AutoProcessResults failed:", error);

        await setDoc(
          roomRef,
          {
            processedQuestionId: questionId,
            collectingBonusByPlayer: {},
            collectingBonusJokerByPlayer: {},
            collectingBonusPlayerId: null,
            collectingBonusPoints: 0,
            rankMovementByPlayer: {},
            resultsAnimationPhase: "done",
            resultsError: String(error?.message || error),
            processingQuestionId: null,
            processingStartedAtMs: null,
            updatedAt: serverTimestamp(),
          },
          { merge: true }
        );
      }
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

function Leaderboard({
  players,
  compact = false,
  isCollecting = false,
  bonusPointsByPlayer = {},
  rankMovementByPlayer = {},
  currentQuestionId = null,
  showRankMovement = true,
  resultLabel = "",
}) {
  const visiblePlayers = players;

  function renderFlashBadges(player) {
    const delta = Number(bonusPointsByPlayer?.[player.id] || 0);
    const movement = showRankMovement ? Number(rankMovementByPlayer?.[player.id] || 0) : 0;

    if (delta === 0 && movement === 0) return null;

    return (
      <div className="leaderboard-flash-row">
        {delta !== 0 && (
          <span className={delta > 0 ? "leaderboard-flash-badge positive" : "leaderboard-flash-badge negative"}>
            {delta > 0 ? `+${delta}` : delta}
          </span>
        )}
        {movement !== 0 && (
          <span className={movement > 0 ? "leaderboard-flash-badge movement-up" : "leaderboard-flash-badge movement-down"}>
            {movement > 0 ? `↑${movement}` : `↓${Math.abs(movement)}`}
          </span>
        )}
      </div>
    );
  }

  return (
    <div className="card leaderboard-card">
      <div className="leaderboard-title-row">
        <h2>{"\u{1F3C6}"} لوحة المتصدرين</h2>
        {resultLabel && <span className="leaderboard-result-chip">{resultLabel}</span>}
        {isCollecting && !resultLabel && <span className="collecting-small-badge">تجميع النتائج</span>}
      </div>

      {visiblePlayers.length === 0 ? (
        <p className="muted">لم ينضم أي مشارك بعد.</p>
      ) : (
        <motion.div className="leaderboard" layout>
          <AnimatePresence initial={false}>
            {visiblePlayers.map((player, index) => {
              const jokerUsedInCurrentQuestion =
                player.jokerUsed &&
                currentQuestionId &&
                player.jokerQuestionId === currentQuestionId;

              return (
                <motion.div
                  layout
                  key={player.id}
                  className={`leaderboard-row animated-leaderboard-row rank-${index + 1} ${compact ? "compact" : ""}`}
                  initial={{ opacity: 0, scale: 0.96 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.96 }}
                  transition={{
                    layout: { duration: 0.58, type: "spring", bounce: 0.12 },
                    opacity: { duration: 0.18 },
                    scale: { duration: 0.18 },
                  }}
                >
                  <div className="leaderboard-rank-cell">
                    <span className="rank">{index + 1}</span>
                  </div>

                  <div className="leaderboard-name">
                    <span className="leaderboard-player-name">{player.emoji || ""} {player.name}</span>
                    {player.jokerUsed && (
                      <span
                        className={jokerUsedInCurrentQuestion ? "leaderboard-joker-status current" : "leaderboard-joker-status previous"}
                        title={jokerUsedInCurrentQuestion ? "استخدم الجوكر في هذا السؤال" : "استخدم الجوكر سابقًا"}
                      >
                        <span className="leaderboard-joker-icon">🃏</span>
                        <span className="leaderboard-joker-multiplier">{getJokerTimingLabel(player.jokerMultiplier || 3)}</span>
                      </span>
                    )}
                  </div>

                  <div className="leaderboard-score-wrap">
                    <span className="leaderboard-score-label">النقاط</span>
                    <motion.strong
                      className="leaderboard-total-score"
                      initial={{ scale: 1.06 }}
                      animate={{ scale: 1 }}
                      transition={{ duration: 0.35 }}
                    >
                      <AnimatedNumber value={player.score || 0} duration={1200} />
                    </motion.strong>
                    {renderFlashBadges(player)}
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

function DisplayVideoSlot() {
  return (
    <div className="display-video-slot" aria-label="مساحة الفيديو">
      <div>
        <span>مساحة الفيديو</span>
        <strong>ضع الكاميرا هنا في برنامج البث</strong>
      </div>
    </div>
  );
}

function DisplaySidePanel({ messages, videoEnabled }) {
  return (
    <div className={videoEnabled ? "display-side-panel has-video-slot" : "display-side-panel"}>
      <MessagesPanel messages={messages} />
      {videoEnabled && <DisplayVideoSlot />}
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
        const resultClass = showCorrect
          ? item.correct
            ? "result-item modern-answer-card answer-correct"
            : "result-item modern-answer-card answer-wrong"
          : "result-item modern-answer-card";
        const optionLetter = ["أ", "ب", "ج", "د", "هـ", "و"][item.index] || item.index + 1;
        const percent = Math.round(item.percent);

        return (
          <div className={resultClass} key={item.index}>
            <div className="result-top">
              <b className="answer-option-letter">{optionLetter}</b>
              <span>
                {item.option}
              </span>

              <div className="result-count-boxes" aria-label="إحصائيات الإجابة">
                <span className="answer-count-box"><small>إجابات</small><b>{item.count}</b></span>
                {item.jokerCount > 0 && <span className="joker-answer-count-box"><small>{"\u{1F0CF}"}</small><b>{item.jokerCount}</b></span>}
                <span className="answer-percent-box" style={{ "--percent": percent }}>
                  {percent}%
                </span>
              </div>
            </div>

            <div className="bar">
              <div className="bar-fill" style={{ "--percent": percent, width: `${item.percent}%` }} />
            </div>
          </div>
        );
      })}
    </div>
  );
}



function InstructionsPage({ isAdmin = false, room = null, players = [], onOpenRegistration = null }) {
  return (
    <div className={isAdmin ? "display-panel instructions-page" : "card instructions-page"}>
      <div className="instructions-hero">
        <span>✦</span>
        <div>
          <h1>طريقة المسابقة</h1>
          <p>معلومات سريعة قبل بداية اللعب.</p>
        </div>
      </div>

      <div className="instructions-board" aria-label="طريقة المسابقة">
        <div className="instruction-mini-card speed">
          <span>⚡</span>
          <strong>السؤال يوصلك على جوالك</strong>
          <p>يرسله المقدم، وكلما جاوبت أسرع أخذت نقاطًا أكثر.</p>
          <small>الصحيح يرفع نقاطك، والخطأ لا ينقصك.</small>
        </div>

        <div className="instruction-joker-card">
          <div className="joker-card-head">
            <span>{"\u{1F0CF}"}</span>
            <div>
              <strong>لك جوكر واحد طول المسابقة</strong>
              <p>استخدمه في الوقت المناسب.</p>
            </div>
          </div>
          <div className="joker-focus-card" aria-label="شرح الجوكر">
            <div className="joker-use-note">
              <span>لو استخدمته</span>
            </div>
            <div className="joker-multiplier-pair">
              <div className="joker-multiplier-option before">
                <small>قبل ما تشوف السؤال</small>
                <b>x3</b>
              </div>
              <div className="joker-multiplier-option after">
                <small>بعد ما تشوف السؤال</small>
                <b>x2</b>
              </div>
            </div>
            <div className="joker-result-note">
              <span className="negative">↘ الخطأ يخصم قيمة السؤال</span>
            </div>
          </div>
        </div>

        <div className="instruction-mini-card results">
          <span>🏆</span>
          <strong>النتائج بعد كل جواب</strong>
          <p>تعرف نقاطك وترتيبك مباشرة.</p>
        </div>
      </div>

      {isAdmin ? (
        <div className="instructions-admin-actions">
          <button type="button" className="secondary-action" onClick={launchInstructionsClarityPoll}>تصويت</button>
          {onOpenRegistration && <button type="button" onClick={onOpenRegistration}>فتح التسجيل للمتسابقين</button>}
          <HealthCheckResultsPanel room={room} players={players} />
        </div>
      ) : (
        <div className="instructions-waiting">بانتظار المقدم للخطوة التالية</div>
      )}
    </div>
  );
}

function PracticeBadge() {
  return (
    <div className="practice-badge">
      <strong>سؤال تجريبي</strong>
      <span>هذا السؤال للتدريب فقط ولا يؤثر على النقاط أو الترتيب.</span>
    </div>
  );
}

function AnsweredCountBadge({ answersCount, playersCount }) {
  const allAnswered = playersCount > 0 && answersCount >= playersCount;

  return (
    <div className={`answered-count-badge ${allAnswered ? "all-answered" : ""}`}>
      <span>الإجابات</span>
      <strong>{answersCount}</strong>
      <small>من {playersCount}</small>
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
            maxHeight: "180px",
            objectFit: "contain",
            borderRadius: "18px",
            background: "#fff",
            border: "1px solid #b9deeb",
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
  const mediaEnded = hasMediaEnded(room, question);

  async function handleStartMedia() {
    await startMediaQuestion();

    if (mediaRef.current) {
      mediaRef.current.currentTime = 0;
      mediaRef.current.play().catch(() => {});
    }
  }

  async function handleEnded() {
    if (isAdmin && displayMode && !mediaEnded) {
      await finishMediaQuestion(question);
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

      {isAdmin && displayMode && !mediaEnded && (
        <button
          type="button"
          onClick={() => finishMediaQuestion(question)}
          className="send-answers-now-button" style={{ marginTop: "14px", width: "100%" }}
        >
          {mediaStarted ? "إنهاء المقطع وإظهار الخيارات" : "تجاوز المقطع وإظهار الخيارات"}
        </button>
      )}

      {!isAdmin && !mediaEnded && (
        <p className="muted" style={{ margin: "12px 0 0", textAlign: "center" }}>
          سيظهر لك تشغيل {isVideo ? "الفيديو" : "الصوت"} بعد انتهاء المقطع عند المقدم.
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
  visualStage = null,
  showTimer = true,
}) {
  const now = useNow();
  const revealCountdown = getRevealCountdown(question, room, now);
  const mediaQuestion = isMediaQuestion(question);
  const questionImageUrl = question?.type === "image" ? getQuestionImageUrl(question) : "";
  const mediaEnded =
    !mediaQuestion ||
    hasMediaEnded(room, question);

  const optionsVisible = mediaQuestion
    ? mediaEnded && revealCountdown !== null && revealCountdown <= 0
    : revealCountdown !== null && revealCountdown <= 0;

  const timeLeft = getQuestionTimeLeft(question, room, now);
  const activeStage = visualStage || room?.stage;
  const isQuestionEnded = activeStage === "reveal" || activeStage === "results";
  const questionStartAt = getQuestionStartAt(room, question);
  const waitingForQuestionStart = activeStage === "question" && questionStartAt && now < questionStartAt;

  const canAnswer = !isAdmin && !waitingForQuestionStart && optionsVisible && activeStage === "question";
  const liveProgressPercent = getPointsProgressPercent(question, room, now);
  useCountdownBeeps({
    active: activeStage === "question" && optionsVisible && !isQuestionEnded,
    timeLeft,
    questionId: question?.questionId,
  });

  const progressPercent =
    selectedIndex !== null && frozenProgressPercent !== null
      ? frozenProgressPercent
      : liveProgressPercent;

  const jokerAppliedToThisQuestion =
    question?.isPractice
      ? currentPlayer?.practiceJokerQuestionId === question?.questionId
      : !!currentPlayer?.jokerUsed &&
        currentPlayer?.jokerQuestionId === question?.questionId;
  const jokerMultiplier = getJokerMultiplier(currentPlayer, question);
  const jokerMultiplierLabel = getJokerTimingLabel(jokerMultiplier);
  const showLegacyPlayerTimer = false;
  const practiceQuestionIndex = room?.currentQuestionIndex ?? 0;
  const shouldShowPracticeJoker =
    !question?.isPractice ||
    (practiceQuestionIndex === 1 && currentPlayer?.practiceJokerQuestionId === question?.questionId) ||
    (practiceQuestionIndex === 2 && optionsVisible);
  const canUsePracticeJokerInQuestion =
    !question?.isPractice ||
    !currentPlayer?.practiceJokerQuestionId ||
    currentPlayer.practiceJokerQuestionId === room?.currentQuestion?.questionId ||
    practiceQuestionIndex === 2;
  const realJokerAvailableForThisQuestion =
    !question?.isPractice &&
    currentPlayer &&
    (!currentPlayer.jokerUsed ||
      (currentPlayer.jokerQuestionId === room?.currentQuestion?.questionId &&
        selectedIndex === null));
  const canShowQuestionJoker =
    !isAdmin &&
    currentPlayer &&
    activeStage === "question" &&
    shouldShowPracticeJoker &&
    (question?.isPractice
      ? canUsePracticeJokerInQuestion
      : realJokerAvailableForThisQuestion);

  if (!question) return null;

  if (waitingForQuestionStart) {
    return (
      <div
        className={
          displayMode
            ? "display-panel question-stage-card sync-start-placeholder"
            : "card question-stage-card sync-start-placeholder"
        }
        aria-hidden="true"
      />
    );
  }

  return (
    <div
      className={
        displayMode
          ? questionImageUrl
            ? "display-panel question-stage-card has-image image-question-card"
            : "display-panel question-stage-card"
          : questionImageUrl
          ? "card question-stage-card has-image image-question-card"
          : "card question-stage-card"
      }
    >
      {question?.isPractice && <PracticeBadge />}
      <div className="question-status-row">
        <span className={displayMode ? "pill display-question-number" : "pill"}>
          {question?.isPractice ? "سؤال تجريبي" : `السؤال رقم ${(room?.currentQuestionIndex ?? 0) + 1}`}
        </span>

        {displayMode && (
          <AnsweredCountBadge
            answersCount={answers.length}
            playersCount={playersCount}
          />
        )}

        {isAdmin && showTimer && optionsVisible && !isQuestionEnded ? (
          <span className={jokerAppliedToThisQuestion ? "timer joker-active" : "timer"}>⏱ {timeLeft} ثانية</span>
        ) : null}

        {!isAdmin && optionsVisible && !isQuestionEnded ? (
          <span className={jokerAppliedToThisQuestion ? "player-time-left joker-active" : timeLeft <= 5 ? "player-time-left danger" : timeLeft <= 10 ? "player-time-left warning" : "player-time-left"}>
            &#9201; {timeLeft}
          </span>
        ) : null}
      </div>

      {canShowQuestionJoker && (
        <div className="question-top-joker-wrap">
          {question?.isPractice && practiceQuestionIndex === 2 && currentPlayer?.practiceJokerQuestionId !== question?.questionId && (
            <PracticeJokerHint room={room} player={currentPlayer} inline />
          )}
          <JokerControl
            player={currentPlayer}
            stage="question"
            room={room}
            compact
            locked={selectedIndex !== null}
            beforeQuestionMode={question?.isPractice && practiceQuestionIndex === 1 && !optionsVisible}
          />
        </div>
      )}

      <h2 className="big-question">{question.text}</h2>

      {questionImageUrl && (
        <div style={{ width: displayMode ? "min(340px, 100%)" : "min(420px, 100%)", margin: "0 auto 10px" }}>
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
        displayMode ? (
          <div className="display-answer-countdown">
            <strong>{revealCountdown === null ? (mediaQuestion ? (question?.type === "video" ? "\u{1F3AC}" : "\u{1F3A7}") : "...") : revealCountdown}</strong>
            <span>{revealCountdown === null ? "بانتظار تشغيل/إنهاء المقطع" : "ثواني حتى تظهر الأجوبة"}</span>
          </div>
        ) : (
          <div className="reveal-box big-countdown-only">
            {revealCountdown === null ? (mediaQuestion ? (question?.type === "video" ? "\u{1F3AC}" : "\u{1F3A7}") : "...") : revealCountdown}
          </div>
        )
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
                <div className="joker-progress-icon">
                  <b>{"\u{1F0CF}"}</b>
                  <span>الجوكر {jokerMultiplierLabel}</span>
                </div>
              )}

              <div className="points-progress-values">
                <span>
                  {jokerAppliedToThisQuestion
                    ? `${Number(question.minPoints || 100) * jokerMultiplier} نقطة`
                    : `${question.minPoints} نقطة`}
                </span>

                <span>
                  {jokerAppliedToThisQuestion
                    ? `${Number(question.maxPoints || 1000) * jokerMultiplier} نقطة`
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

          {showLegacyPlayerTimer && !isAdmin && optionsVisible && !isQuestionEnded && (
            <div className={jokerAppliedToThisQuestion ? "player-time-left joker-active" : timeLeft <= 5 ? "player-time-left danger" : timeLeft <= 10 ? "player-time-left warning" : "player-time-left"}>
              ⏱ الوقت المتبقي: {timeLeft} ثانية
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
                      style={{ width: "100%", maxWidth: displayMode ? "120px" : "180px" }}
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
  const questionNumber = (room?.currentQuestionIndex ?? 0) + 1;
  const videoEnabled = !!room?.displayVideoSlotEnabled;

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
          bonusPointsByPlayer={room?.collectingBonusByPlayer || {}}
          rankMovementByPlayer={room?.rankMovementByPlayer || {}}
          currentQuestionId={room?.currentQuestion?.questionId}
          showRankMovement={(room?.currentQuestionIndex ?? 0) > 0}
          resultLabel={`نتائج السؤال ${questionNumber}`}
        />
      </div>

      <div className="results-messages-area">
        <DisplaySidePanel messages={messages} videoEnabled={videoEnabled} />
      </div>
    </div>
  );
}

function PodiumWinnerCard({ player, place, variant }) {
  if (!player) {
    return <div className={`podium-winner-card ${variant || ""}`} />;
  }

  const medal = variant === "first" ? "1" : variant === "second" ? "2" : "3";

  return (
    <div className={`podium-winner-card ${variant || ""}`}>
      <i className="podium-medal">{medal}</i>
      <span>{place}</span>
      <strong>{player.name}</strong>
      <b><AnimatedNumber value={player.score || 0} /> نقطة</b>
    </div>
  );
}

function FallingConfetti() {
  return (
    <div className="falling-confetti" aria-hidden="true">
      {Array.from({ length: 30 }, (_, index) => (
        <i
          key={index}
          style={{
            left: `${(index * 37) % 100}%`,
            animationDelay: `${(index % 10) * -0.48}s`,
            animationDuration: `${3.4 + (index % 6) * 0.42}s`,
            backgroundColor: `hsl(${(index * 47) % 360} 72% 56%)`,
          }}
        />
      ))}
    </div>
  );
}

function FinishedDisplay({ players, messages = [] }) {
  const first = players[0];
  const second = players[1];
  const third = players[2];
  const restPlayers = players.slice(3);

  return (
    <div className="final-winners-layout">
      <div className="final-messages-side">
        <MessagesPanel messages={messages} />
      </div>

      <div className="final-winners-main">
        <FallingConfetti />
        <div className="final-title">
          <h1>انتهت المسابقة</h1>
          <p>مبروك للفائزين وشكرًا لجميع المشاركين</p>
        </div>

        <div className="podium-top-three">
          <PodiumWinnerCard player={second} place="المركز الثاني" variant="second" />
          <PodiumWinnerCard player={first} place="المركز الأول" variant="first" />
          <PodiumWinnerCard player={third} place="المركز الثالث" variant="third" />
        </div>

        <div className="final-rankings-card">
          {restPlayers.length === 0 ? (
            <p className="muted" style={{ textAlign: "center" }}>لا يوجد متسابقون بعد المركز الثالث.</p>
          ) : (
            <div className="final-rankings-list">
              {restPlayers.map((player, index) => (
                <div className="final-ranking-row" key={player.id}>
                  <span className="rank">{index + 4}</span>
                  <strong>{player.name}</strong>
                  <b><AnimatedNumber value={player.score || 0} /> نقطة</b>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/* Joker controls */

function JokerControl({ player, stage, room = null, compact = false, locked = false, beforeQuestionMode = false }) {
  const isPracticeJoker = !!room?.practiceMode || !!room?.currentQuestion?.isPractice;
  const activeQuestionId = room?.currentQuestion?.questionId;
  const practiceJokerUsedForQuestion =
    isPracticeJoker &&
    activeQuestionId &&
    player?.practiceJokerQuestionId === activeQuestionId;
  const realJokerUsedForQuestion =
    !isPracticeJoker &&
    activeQuestionId &&
    player?.jokerQuestionId === activeQuestionId;
  const jokerAlreadyUsed = isPracticeJoker ? false : !!player?.jokerUsed;
  const canChooseJoker =
    !jokerAlreadyUsed && (stage === "registration" || stage === "practiceComplete" || stage === "results" || stage === "question");
  const isDuringQuestion = stage === "question" && activeQuestionId && !beforeQuestionMode;
  const isBeforeCurrentQuestion = stage === "question" && activeQuestionId && beforeQuestionMode;

  async function activateJoker() {
    if (!player?.id || jokerAlreadyUsed) return;

    if (isBeforeCurrentQuestion) {
      if (isPracticeJoker) {
        await updateDoc(doc(db, "rooms", ROOM_ID, "players", player.id), {
          practicePendingJoker: false,
          practiceJokerQuestionId: activeQuestionId,
          practiceJokerTiming: "before",
          practiceJokerMultiplier: 3,
          practiceJokerLockedAt: serverTimestamp(),
        });
      } else {
        await updateDoc(doc(db, "rooms", ROOM_ID, "players", player.id), {
          pendingJoker: false,
          jokerUsed: true,
          jokerQuestionId: activeQuestionId,
          jokerQuestionNumber: (room?.currentQuestionIndex ?? -1) + 1,
          jokerTiming: "before",
          jokerMultiplier: 3,
          jokerLockedAt: serverTimestamp(),
        });
      }
      return;
    }

    if (isDuringQuestion) {
      if (isPracticeJoker) {
        await updateDoc(doc(db, "rooms", ROOM_ID, "players", player.id), {
          practicePendingJoker: false,
          practiceJokerQuestionId: activeQuestionId,
          practiceJokerTiming: "during",
          practiceJokerMultiplier: 2,
          practiceJokerLockedAt: serverTimestamp(),
        });
      } else {
        await updateDoc(doc(db, "rooms", ROOM_ID, "players", player.id), {
          pendingJoker: false,
          jokerUsed: true,
          jokerQuestionId: activeQuestionId,
          jokerQuestionNumber: (room?.currentQuestionIndex ?? -1) + 1,
          jokerTiming: "during",
          jokerMultiplier: 2,
          jokerLockedAt: serverTimestamp(),
        });
      }
      return;
    }

    if (isPracticeJoker) {
      await updateDoc(doc(db, "rooms", ROOM_ID, "players", player.id), {
        practicePendingJoker: true,
        practiceJokerTiming: "before",
        practiceJokerMultiplier: 3,
      });
    } else {
      await updateDoc(doc(db, "rooms", ROOM_ID, "players", player.id), {
        pendingJoker: true,
        jokerTiming: "before",
        jokerMultiplier: 3,
      });
    }
  }

  async function cancelJoker() {
    if (!player?.id) return;

    if (isPracticeJoker && practiceJokerUsedForQuestion && isDuringQuestion) {
      await updateDoc(doc(db, "rooms", ROOM_ID, "players", player.id), {
        practiceJokerQuestionId: null,
        practiceJokerTiming: null,
        practiceJokerMultiplier: null,
      });
      return;
    }

    if (!isPracticeJoker && player.jokerUsed && isDuringQuestion && player.jokerQuestionId === activeQuestionId) {
      await updateDoc(doc(db, "rooms", ROOM_ID, "players", player.id), {
        jokerUsed: false,
        jokerQuestionId: null,
        jokerQuestionNumber: null,
        jokerTiming: null,
        jokerMultiplier: null,
      });
      return;
    }

    if (isPracticeJoker) {
      await updateDoc(doc(db, "rooms", ROOM_ID, "players", player.id), {
        practicePendingJoker: false,
        practiceJokerTiming: null,
        practiceJokerMultiplier: null,
      });
      return;
    }

    if (player.jokerUsed) return;

    await updateDoc(doc(db, "rooms", ROOM_ID, "players", player.id), {
      pendingJoker: false,
      jokerTiming: null,
      jokerMultiplier: null,
    });
  }

  const availableCount = jokerAlreadyUsed ? 0 : 1;

  const usedInThisQuestion =
    isPracticeJoker
      ? practiceJokerUsedForQuestion
      : player?.jokerUsed && realJokerUsedForQuestion;
  if (!canChooseJoker && !usedInThisQuestion && !player?.jokerUsed) return null;

  if (usedInThisQuestion) {
    const activeTiming = isPracticeJoker ? player.practiceJokerTiming : player.jokerTiming;
    const activeMultiplier = isPracticeJoker ? player.practiceJokerMultiplier : player.jokerMultiplier;
    const activeLabel = getJokerTimingLabel(activeMultiplier || (activeTiming === "before" ? 3 : 2));
    const activatedBeforeQuestion = activeLabel === "x3" || activeTiming === "before";
    const showAsUsed = activatedBeforeQuestion || locked || stage !== "question";
    return (
      <button
        type="button"
        className={`${compact ? `joker-token ${showAsUsed ? "joker-token-used" : "joker-token-active"} compact-joker-token` : `joker-token ${showAsUsed ? "joker-token-used" : "joker-token-active"}`}${showAsUsed ? " joker-token-before-used" : ""}`}
        onClick={showAsUsed ? undefined : cancelJoker}
        disabled={showAsUsed}
      >
        <b className="joker-multiplier-badge">{activeLabel}</b>
        <div className="joker-icon">{"\u{1F0CF}"}</div>
        <span>{showAsUsed ? "تم استخدامه" : "الجوكر"}</span>
        {!showAsUsed && <small>اضغط للإلغاء</small>}
      </button>
    );
  }

  if (!isPracticeJoker && player?.jokerUsed) {
    return (
      <div className={compact ? "joker-token joker-token-used compact-joker-token" : "joker-token joker-token-used"}>
        <b className="joker-multiplier-badge">{getJokerTimingLabel(player.jokerMultiplier || 3)}</b>
        <div className="joker-icon">{"\u{1F0CF}"}</div>
        <span>تم استخدامه</span>
      </div>
    );
  }

  if (isPracticeJoker ? player?.practicePendingJoker : player?.pendingJoker) {
    const pendingLockedByQuestion = stage === "question";
    return (
      <button
        type="button"
        className={`${compact ? "joker-token joker-token-active compact-joker-token" : "joker-token joker-token-active"}${pendingLockedByQuestion ? " joker-token-before-used" : ""}`}
        onClick={pendingLockedByQuestion ? undefined : cancelJoker}
        disabled={pendingLockedByQuestion}
        style={pendingLockedByQuestion ? undefined : { background: "#e8f8ea", borderColor: "#6cc276", color: "#18733a" }}
      >
        <b className="joker-multiplier-badge">x3</b>
        <div className="joker-count">{availableCount}</div>
        <div className="joker-icon">{"\u{1F0CF}"}</div>
        <span>الجوكر مفعل</span>
        <small style={{ fontWeight: 900, opacity: 0.78 }}>{pendingLockedByQuestion ? "مفعل قبل السؤال" : "اضغط للإلغاء"}</small>
      </button>
    );
  }

  if (locked && stage === "question") {
    return null;
  }

  return (
    <button type="button" className={compact ? "joker-token joker-token-available compact-joker-token" : "joker-token joker-token-available"} onClick={activateJoker} style={{ background: "#fff1d6", borderColor: "#f59e0b", color: "#9a5b00" }}>
      <b className="joker-multiplier-badge">{isDuringQuestion ? "x2" : "x3"}</b>
      <div className="joker-count">{availableCount}</div>
      <div className="joker-icon">{"\u{1F0CF}"}</div>
      <span>الجوكر</span>
    </button>
  );
}

/* Settings */

function QuestionSettings({ questions, room = null, questionPackages = [], allQuestions = [], embedded = false }) {
  const [editingId, setEditingId] = useState(null);
  const [showForm, setShowForm] = useState(false);
  const [type, setType] = useState("multiple_choice");
  const [text, setText] = useState("");
  const [mediaUrl, setMediaUrl] = useState("");
  const [imageUrl, setImageUrl] = useState("");
  const [optionImageUrls, setOptionImageUrls] = useState(["", ""]);
  const [options, setOptions] = useState(["", ""]);
  const [visibleOptionImages, setVisibleOptionImages] = useState({});
  const [correctIndex, setCorrectIndex] = useState(0);
  const [maxPoints, setMaxPoints] = useState(1000);
  const [minPoints, setMinPoints] = useState(100);
  const [seconds, setSeconds] = useState(20);
  const [answerRevealDelaySeconds, setAnswerRevealDelaySeconds] = useState(3);
  const [isPractice, setIsPractice] = useState(false);
  const [saving, setSaving] = useState(false);
  const [bulkField, setBulkField] = useState("maxPoints");
  const [bulkValue, setBulkValue] = useState("");
  const [bulkSaving, setBulkSaving] = useState(false);
  const [bulkScope, setBulkScope] = useState("main");
  const [expandedQuestionId, setExpandedQuestionId] = useState(null);
  const [draggedQuestionId, setDraggedQuestionId] = useState(null);
  const [dragOverQuestionId, setDragOverQuestionId] = useState(null);
  const [showBulkEditor, setShowBulkEditor] = useState(false);
  const [showPackageModal, setShowPackageModal] = useState(false);
  const [questionSectionsOpen, setQuestionSectionsOpen] = useState({
    main: true,
    practice: true,
  });
  const [newPackageName, setNewPackageName] = useState("");
  const [creatingPackage, setCreatingPackage] = useState(false);
  const [packageError, setPackageError] = useState("");

  const activePackageId = room?.activePackageId || DEFAULT_PACKAGE_ID;
  const activePackageName = room?.activePackageName || DEFAULT_PACKAGE_NAME;
  const availableQuestionPackages = [
    ...questionPackages,
    ...(activePackageId && !questionPackages.some((item) => item.id === activePackageId)
      ? [{ id: activePackageId, name: activePackageName, createdAtMs: getNow() }]
      : []),
    ...allQuestions
      .filter((question) => question.packageId && !questionPackages.some((item) => item.id === question.packageId))
      .map((question) => ({
        id: question.packageId,
        name: question.packageName || "نموذج بدون اسم",
        createdAtMs: 0,
      })),
  ];
  const mainQuestionRows = questions.filter((question) => !question.isPractice);
  const practiceQuestionRows = questions.filter((question) => question.isPractice);
  const activePackageItem = availableQuestionPackages.find((item) => item.id === activePackageId) || {
    id: activePackageId,
    name: activePackageName,
  };

  function resetForm() {
    setEditingId(null);
    setShowForm(false);
    setType("multiple_choice");
    setText("");
    setMediaUrl("");
    setImageUrl("");
    setOptionImageUrls(["", ""]);
    setVisibleOptionImages({});
    setOptions(["", ""]);
    setCorrectIndex(0);
    setMaxPoints(1000);
    setMinPoints(100);
    setSeconds(20);
    setAnswerRevealDelaySeconds(3);
    setIsPractice(false);
  }

  function startCreate(practice = false) {
    resetForm();
    setIsPractice(!!practice);
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
    setVisibleOptionImages(Object.fromEntries((question.optionImageUrls || []).map((url, index) => [index, !!url])));
    setCorrectIndex(Number(question.correctIndex || 0));
    setMaxPoints(Number(question.maxPoints || 1000));
    setMinPoints(Number(question.minPoints || 100));
    setSeconds(Number(question.seconds || 20));
    setAnswerRevealDelaySeconds(Number(question.answerRevealDelaySeconds ?? question.revealDelaySeconds ?? 3));
    setIsPractice(!!question.isPractice);
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

  function showOptionImageInput(index) {
    setVisibleOptionImages((current) => ({ ...current, [index]: true }));
  }

  function hideOptionImageInput(index) {
    const copy = [...optionImageUrls];
    copy[index] = "";
    setOptionImageUrls(copy);
    setVisibleOptionImages((current) => ({ ...current, [index]: false }));
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
    setVisibleOptionImages(Object.fromEntries(nextOptionImages.map((url, index) => [index, !!url])));

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
      setVisibleOptionImages({});
      setCorrectIndex(0);
      setMediaUrl("");
      setImageUrl("");
    } else {
      setOptions(["", ""]);
      setOptionImageUrls(["", ""]);
      setVisibleOptionImages({});
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
      answerRevealDelaySeconds: Number(answerRevealDelaySeconds),
      isPractice: !!isPractice,
      packageId: activePackageId,
      packageName: activePackageName,
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

  async function selectQuestionPackage(packageItem) {
    await setDoc(
      doc(db, "rooms", ROOM_ID),
      {
        activePackageId: packageItem.id,
        activePackageName: packageItem.name || DEFAULT_PACKAGE_NAME,
        updatedAt: serverTimestamp(),
      },
      { merge: true }
    );
    setShowPackageModal(false);
  }

  async function createQuestionPackage() {
    const cleanName = newPackageName.trim();
    if (!cleanName) return;

    setCreatingPackage(true);
    setPackageError("");

    try {
      const packageItem = {
        id: `package-${getNow()}-${Math.random().toString(16).slice(2, 8)}`,
        name: cleanName,
        createdAtMs: getNow(),
      };

      await setDoc(
        doc(db, "rooms", ROOM_ID),
        {
          questionPackages: arrayUnion(packageItem),
          activePackageId: packageItem.id,
          activePackageName: packageItem.name,
          updatedAt: serverTimestamp(),
        },
        { merge: true }
      );

      setNewPackageName("");
      setShowPackageModal(false);
    } catch (error) {
      setPackageError(`تعذر إضافة النموذج: ${error.message || error}`);
    } finally {
      setCreatingPackage(false);
    }
  }

  async function deleteQuestionPackage(packageItem) {
    if (!packageItem?.id || packageItem.id === DEFAULT_PACKAGE_ID) {
      alert("لا يمكن حذف نموذج المسابقة الحالية.");
      return;
    }

    if (!window.confirm(`حذف نموذج "${packageItem.name}"؟ سيتم حذف الأسئلة الموجودة داخله أيضًا.`)) return;

    const packageQuestionsSnap = await getDocs(
      query(collection(db, "rooms", ROOM_ID, "questions"), where("packageId", "==", packageItem.id))
    );

    await Promise.all(packageQuestionsSnap.docs.map((questionDoc) => deleteDoc(questionDoc.ref)));

    const nextPackages = questionPackages.filter((item) => item.id !== packageItem.id && item.id !== DEFAULT_PACKAGE_ID);
    await setDoc(
      doc(db, "rooms", ROOM_ID),
      {
        questionPackages: nextPackages,
        ...(activePackageId === packageItem.id
          ? { activePackageId: DEFAULT_PACKAGE_ID, activePackageName: DEFAULT_PACKAGE_NAME }
          : {}),
        updatedAt: serverTimestamp(),
      },
      { merge: true }
    );
    setShowPackageModal(false);
  }

  async function reorderQuestions(targetQuestionId) {
    if (!draggedQuestionId || draggedQuestionId === targetQuestionId) return;
    const reordered = [...questions];
    const sourceIndex = reordered.findIndex((item) => item.id === draggedQuestionId);
    const targetIndex = reordered.findIndex((item) => item.id === targetQuestionId);
    if (sourceIndex < 0 || targetIndex < 0) return;
    const [draggedQuestion] = reordered.splice(sourceIndex, 1);
    reordered.splice(targetIndex, 0, draggedQuestion);
    setDraggedQuestionId(null);
    setDragOverQuestionId(null);
    await Promise.all(
      reordered.map((question, index) =>
        updateDoc(doc(db, "rooms", ROOM_ID, "questions", question.id), { order: index + 1 })
      )
    );
  }

  async function deleteQuestion(questionId) {
    if (!window.confirm("حذف السؤال؟")) return;
    await deleteDoc(doc(db, "rooms", ROOM_ID, "questions", questionId));
  }

  async function applyBulkUpdate() {
    const value = Number(bulkValue);
    const targetQuestions = bulkScope === "practice" ? practiceQuestionRows : mainQuestionRows;
    if (!targetQuestions.length || !Number.isFinite(value) || value < 0) {
      alert("اكتب قيمة صحيحة لتطبيقها على جميع الأسئلة.");
      return;
    }

    const labels = {
      maxPoints: "أعلى نقاط",
      minPoints: "أقل نقاط",
      seconds: "وقت الإجابة",
      answerRevealDelaySeconds: "ثواني ظهور الأجوبة",
    };

    const scopeLabel = bulkScope === "practice" ? "الأسئلة التجريبية" : "أسئلة المسابقة";
    if (!window.confirm(`تطبيق ${labels[bulkField]} = ${value} على ${scopeLabel}؟`)) return;

    setBulkSaving(true);
    await Promise.all(
      targetQuestions.map((question) =>
        updateDoc(doc(db, "rooms", ROOM_ID, "questions", question.id), {
          [bulkField]: value,
          updatedAt: serverTimestamp(),
        })
      )
    );
    setBulkSaving(false);
    setBulkValue("");
    setShowBulkEditor(false);
  }

  function toggleQuestionSection(sectionId) {
    setQuestionSectionsOpen((current) => ({ ...current, [sectionId]: !current[sectionId] }));
  }

  function openBulkEditor(scope) {
    setBulkScope(scope);
    setBulkValue("");
    setShowBulkEditor(true);
  }

  function renderQuestionForm() {
    return (
      <div className="modal-backdrop" onClick={resetForm}>
        <div className="modal-card question-edit-modal" onClick={(event) => event.stopPropagation()}>
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
          <textarea value={text} onChange={(e) => setText(e.target.value)} placeholder="اكتب السؤال هنا" />

          {(type === "audio" || type === "video") && (
            <>
              <label>{type === "video" ? "رابط مقطع الفيديو" : "رابط المقطع الصوتي"}</label>
              <input value={mediaUrl} onChange={(e) => setMediaUrl(e.target.value)} placeholder={type === "video" ? "ضع رابط الفيديو هنا" : "ضع رابط الصوت هنا"} />
            </>
          )}

          {type === "image" && (
            <>
              <label>رابط صورة السؤال</label>
              <input value={imageUrl} onChange={(e) => setImageUrl(e.target.value)} placeholder="ضع رابط صورة السؤال هنا، أو اتركه فارغًا إذا الصور في الخيارات" />
            </>
          )}

          <label>الإجابات</label>
          <div className="options-editor">
            {options.map((option, index) => (
              <div className="option-editor-row" key={index}>
                <div className="question-option-fields">
                  <input value={option} onChange={(e) => updateOption(index, e.target.value)} placeholder={`الإجابة ${index + 1}`} disabled={type === "true_false"} />
                  {type !== "audio" && type !== "video" && visibleOptionImages[index] && (
                    <input value={optionImageUrls[index] || ""} onChange={(e) => updateOptionImage(index, e.target.value)} placeholder={`رابط صورة الخيار ${index + 1}`} />
                  )}
                </div>

                <label className="radio-label">
                  <input type="radio" name="correct" checked={correctIndex === index} onChange={() => setCorrectIndex(index)} />
                  الصحيحة
                </label>

                {type !== "audio" && type !== "video" && !visibleOptionImages[index] && (
                  <button type="button" className="small-button add-option-image-button" onClick={() => showOptionImageInput(index)}>إضافة صورة</button>
                )}

                {type !== "audio" && type !== "video" && visibleOptionImages[index] && (
                  <button type="button" className="small-button remove-option-image-button" onClick={() => hideOptionImageInput(index)}>إلغاء الصورة</button>
                )}

                {type !== "true_false" && options.length > 2 && <button type="button" className="danger small-button option-delete-button" onClick={() => removeOption(index)}>حذف</button>}
              </div>
            ))}
          </div>

          {type !== "true_false" && <button type="button" className="small-button" onClick={addOption}>إضافة خيار آخر</button>}

          <div className="settings-grid">
            <div><label>أعلى نقاط</label><input type="number" value={maxPoints} onChange={(e) => setMaxPoints(e.target.value)} /></div>
            <div><label>أقل نقاط</label><input type="number" value={minPoints} onChange={(e) => setMinPoints(e.target.value)} /></div>
            <div><label>وقت الإجابة بالثواني</label><input type="number" value={seconds} onChange={(e) => setSeconds(e.target.value)} /></div>
            <div><label>ثواني ظهور الأجوبة</label><input type="number" value={answerRevealDelaySeconds} onChange={(e) => setAnswerRevealDelaySeconds(e.target.value)} /></div>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px" }}>
            <button onClick={saveQuestion} disabled={saving}>{saving ? "جاري الحفظ..." : editingId ? "حفظ التعديل" : "حفظ السؤال"}</button>
            <button type="button" className="danger" onClick={resetForm}>إلغاء</button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={embedded ? "control-page question-settings-page embedded-admin-panel" : "control-page question-settings-page"}>
      <div className="question-settings-toolbar">
        <label className="question-package-select">
          <span>نموذج الأسئلة</span>
          <select
            value={activePackageId}
            onChange={(event) => {
              const selected = availableQuestionPackages.find((item) => item.id === event.target.value);
              if (selected) selectQuestionPackage(selected);
            }}
          >
            {availableQuestionPackages.map((packageItem) => (
              <option key={packageItem.id} value={packageItem.id}>{packageItem.name || DEFAULT_PACKAGE_NAME}</option>
            ))}
          </select>
        </label>
        <button className="question-package-button" onClick={() => setShowPackageModal(true)}>+ نموذج جديد</button>
        <button className="question-package-delete-button" onClick={() => deleteQuestionPackage(activePackageItem)} disabled={activePackageId === DEFAULT_PACKAGE_ID}>حذف النموذج</button>
      </div>

      {showPackageModal && <div className="modal-backdrop" onClick={() => setShowPackageModal(false)}>
        <div className="modal-card package-picker-modal" onClick={(event) => event.stopPropagation()}>
          <h2>اختيار المسابقة</h2>
          <p className="muted">اختر المسابقة التي تريد إعداد أسئلتها، أو أضف مسابقة جديدة.</p>
          <div className="package-picker-list">
            {availableQuestionPackages.map((packageItem) => (
              <div className={packageItem.id === activePackageId ? "package-picker-item active" : "package-picker-item"} key={packageItem.id}>
                <button
                  type="button"
                  onClick={() => selectQuestionPackage(packageItem)}
                >
                  <strong>{packageItem.name || DEFAULT_PACKAGE_NAME}</strong>
                  <span>{packageItem.id === activePackageId ? "نشطة الآن" : "اضغط للاختيار"}</span>
                </button>
                <button
                  type="button"
                  className="danger icon-action-button"
                  title="حذف النموذج"
                  aria-label="حذف النموذج"
                  disabled={packageItem.id === DEFAULT_PACKAGE_ID}
                  onClick={() => deleteQuestionPackage(packageItem)}
                >
                  ×
                </button>
              </div>
            ))}
          </div>
          <div className="package-create-row">
            <input value={newPackageName} onChange={(event) => setNewPackageName(event.target.value)} placeholder="اسم مسابقة جديدة" />
            <button type="button" onClick={createQuestionPackage} disabled={!newPackageName.trim() || creatingPackage}>{creatingPackage ? "جاري..." : "إضافة"}</button>
          </div>
          {packageError && <div className="error-box">{packageError}</div>}
          <button type="button" className="danger" onClick={() => setShowPackageModal(false)}>إغلاق</button>
        </div>
      </div>}

      {showBulkEditor && <div className="modal-backdrop" onClick={() => setShowBulkEditor(false)}>
        <div className="modal-card bulk-question-modal" onClick={(event) => event.stopPropagation()}>
          <h2>{bulkScope === "practice" ? "تعديل الأسئلة التجريبية" : "تعديل أسئلة المسابقة"}</h2>
          <p className="muted">اختر الحقل والقيمة الجديدة، ثم طبّقها على هذا القسم فقط.</p>
          <div className="bulk-question-editor">
            <select value={bulkField} onChange={(event) => setBulkField(event.target.value)}>
              <option value="maxPoints">أعلى نقاط</option>
              <option value="minPoints">أقل نقاط</option>
              <option value="seconds">وقت الإجابة بالثواني</option>
              <option value="answerRevealDelaySeconds">ثواني ظهور الأجوبة</option>
            </select>
            <input type="number" min="0" value={bulkValue} onChange={(event) => setBulkValue(event.target.value)} placeholder="القيمة الجديدة" />
          </div>
          <div className="bulk-modal-actions">
            <button type="button" onClick={applyBulkUpdate} disabled={bulkSaving || !(bulkScope === "practice" ? practiceQuestionRows.length : mainQuestionRows.length)}>
              {bulkSaving ? "جاري التطبيق..." : "تطبيق"}
            </button>
            <button type="button" className="danger" onClick={() => setShowBulkEditor(false)}>إلغاء</button>
          </div>
        </div>
      </div>}

      <section className="card questions-section-card">
        <div className="questions-section-header">
          <button type="button" className="questions-section-toggle" onClick={() => toggleQuestionSection("main")} aria-expanded={questionSectionsOpen.main}>
            <span>أسئلة المسابقة</span>
            <small>{mainQuestionRows.length} سؤال</small>
            <b>{questionSectionsOpen.main ? "−" : "+"}</b>
          </button>
          <button type="button" className="section-add-question-button" onClick={(event) => { event.stopPropagation(); startCreate(false); }}>+ إضافة سؤال</button>
          <button type="button" className="section-bulk-question-button" onClick={(event) => { event.stopPropagation(); openBulkEditor("main"); }}>تعديل شامل</button>
        </div>

        {questionSectionsOpen.main && (mainQuestionRows.length === 0 ? (
          <p className="muted">لم تضف أي سؤال فعلي بعد.</p>
        ) : (
          <div className="questions-table-wrap">
            <table className="questions-table">
              <thead>
                <tr>
                  <th>رقم</th>
                  <th>إجراء</th>
                  <th>السؤال</th>
                  <th>النوع</th>
                  <th>القيمة</th>
                  <th>وقت الإجابة</th>
                  <th>ظهور الأجوبة</th>
                </tr>
              </thead>
              <tbody>
                {mainQuestionRows.map((q, index) => (
                  <Fragment key={q.id}>
                  <tr
                    className={`${draggedQuestionId === q.id ? "question-row dragging" : "question-row"}${dragOverQuestionId === q.id && draggedQuestionId !== q.id ? " drop-target" : ""}`}
                    draggable
                    onDragStart={() => setDraggedQuestionId(q.id)}
                    onDragEnd={() => { setDraggedQuestionId(null); setDragOverQuestionId(null); }}
                    onDragOver={(event) => { event.preventDefault(); setDragOverQuestionId(q.id); }}
                    onDrop={() => reorderQuestions(q.id)}
                    onClick={() => setExpandedQuestionId(expandedQuestionId === q.id ? null : q.id)}
                  >
                    <td><button type="button" className="drag-handle" title="اسحب لتغيير الترتيب" aria-label="اسحب لتغيير ترتيب السؤال">☷</button> <strong>{index + 1}</strong></td>
                    <td>
                      <div className="question-admin-card-actions">
                        <button className="icon-action-button" title="تعديل" aria-label="تعديل السؤال" onClick={(event) => { event.stopPropagation(); startEdit(q); }}>✎</button>
                        <button className="danger icon-action-button" title="حذف" aria-label="حذف السؤال" onClick={(event) => { event.stopPropagation(); deleteQuestion(q.id); }}>×</button>
                      </div>
                    </td>
                    <td><button type="button" className="question-title-button"><strong>{q.text}</strong>{q.isPractice && <span className="question-practice-chip">سؤال تجريبي</span>}</button></td>
                    <td>{q.isPractice ? "سؤال تجريبي" : getQuestionTypeLabel(q.type)}</td>
                    <td>{q.minPoints || 100} - {q.maxPoints || 1000}</td>
                    <td>{q.seconds || 20} ث</td>
                    <td>{q.answerRevealDelaySeconds ?? 3} ث</td>
                  </tr>
                  {expandedQuestionId === q.id && (
                    <tr className="question-details-row">
                      <td colSpan="7">
                        <div className="question-inline-details">
                          <span>نوع السؤال <b>{getQuestionTypeLabel(q.type)}</b></span>
                          <span>النقاط <b>{q.minPoints || 100} - {q.maxPoints || 1000}</b></span>
                          <span>وقت الإجابة <b>{q.seconds || 20} ثانية</b></span>
                          <span>ظهور الخيارات <b>{q.answerRevealDelaySeconds ?? 3} ثانية</b></span>
                          <span className="question-detail-wide">الإجابة الصحيحة <b>{getOptionText(q.options?.[q.correctIndex]) || "—"}</b></span>
                          <span className="question-detail-wide">الخيارات <b>{(q.options || []).map(getOptionText).join(" | ")}</b></span>
                          {getQuestionMediaUrl(q) && <span className="question-detail-wide">رابط الوسائط <b>{getQuestionMediaUrl(q)}</b></span>}
                          {getQuestionImageUrl(q) && <img className="question-inline-image" src={getQuestionImageUrl(q)} alt="صورة السؤال" />}
                          {(q.options || []).some((option, optionIndex) => getOptionImage(option, q.optionImageUrls || [], optionIndex)) && (
                            <div className="question-option-image-grid">
                              {(q.options || []).map((option, optionIndex) => {
                                const optionImage = getOptionImage(option, q.optionImageUrls || [], optionIndex);
                                return optionImage ? <img key={optionIndex} src={optionImage} alt={`صورة الخيار ${optionIndex + 1}`} /> : null;
                              })}
                            </div>
                          )}
                        </div>
                      </td>
                    </tr>
                  )}
                  </Fragment>
                ))}
              </tbody>
            </table>

          </div>
        ))}
      </section>

      <section className="card practice-questions-card questions-section-card">
        <div className="questions-section-header practice">
          <button type="button" className="questions-section-toggle" onClick={() => toggleQuestionSection("practice")} aria-expanded={questionSectionsOpen.practice}>
            <span>الأسئلة التجريبية</span>
            <small>{practiceQuestionRows.length} سؤال</small>
            <b>{questionSectionsOpen.practice ? "−" : "+"}</b>
          </button>
          <button type="button" className="section-add-question-button practice" onClick={(event) => { event.stopPropagation(); startCreate(true); }}>+ إضافة سؤال تجريبي</button>
          <button type="button" className="section-bulk-question-button practice" onClick={(event) => { event.stopPropagation(); openBulkEditor("practice"); }}>تعديل شامل</button>
        </div>

        {questionSectionsOpen.practice && (practiceQuestionRows.length === 0 ? (
          <p className="muted">لا توجد أسئلة تجريبية. فعّل خيار "سؤال تجريبي" من نموذج إضافة أو تعديل السؤال.</p>
        ) : (
          <div className="questions-table-wrap">
            <table className="questions-table practice-questions-table">
              <thead>
                <tr>
                  <th>رقم</th>
                  <th>إجراء</th>
                  <th>السؤال</th>
                  <th>النوع</th>
                  <th>القيمة</th>
                  <th>وقت الإجابة</th>
                  <th>ظهور الأجوبة</th>
                </tr>
              </thead>
              <tbody>
                {practiceQuestionRows.map((q, index) => (
                  <Fragment key={q.id}>
                  <tr
                    className={`${draggedQuestionId === q.id ? "question-row dragging practice-question-row" : "question-row practice-question-row"}${dragOverQuestionId === q.id && draggedQuestionId !== q.id ? " drop-target" : ""}`}
                    draggable
                    onDragStart={() => setDraggedQuestionId(q.id)}
                    onDragEnd={() => { setDraggedQuestionId(null); setDragOverQuestionId(null); }}
                    onDragOver={(event) => { event.preventDefault(); setDragOverQuestionId(q.id); }}
                    onDrop={() => reorderQuestions(q.id)}
                    onClick={() => setExpandedQuestionId(expandedQuestionId === q.id ? null : q.id)}
                  >
                    <td><button type="button" className="drag-handle" title="اسحب لتغيير الترتيب" aria-label="اسحب لتغيير ترتيب السؤال">☷</button> <strong>{index + 1}</strong></td>
                    <td>
                      <div className="question-admin-card-actions">
                        <button className="icon-action-button" title="تعديل" aria-label="تعديل السؤال" onClick={(event) => { event.stopPropagation(); startEdit(q); }}>✎</button>
                        <button className="danger icon-action-button" title="حذف" aria-label="حذف السؤال" onClick={(event) => { event.stopPropagation(); deleteQuestion(q.id); }}>×</button>
                      </div>
                    </td>
                    <td><button type="button" className="question-title-button"><strong>{q.text}</strong><span className="question-practice-chip">سؤال تجريبي</span></button></td>
                    <td>{getQuestionTypeLabel(q.type)}</td>
                    <td>{q.minPoints || 100} - {q.maxPoints || 1000}</td>
                    <td>{q.seconds || 20} ث</td>
                    <td>{q.answerRevealDelaySeconds ?? 3} ث</td>
                  </tr>
                  {expandedQuestionId === q.id && (
                    <tr className="question-details-row">
                      <td colSpan="7">
                        <div className="question-inline-details">
                          <span>نوع السؤال <b>{getQuestionTypeLabel(q.type)}</b></span>
                          <span>النقاط <b>{q.minPoints || 100} - {q.maxPoints || 1000}</b></span>
                          <span>وقت الإجابة <b>{q.seconds || 20} ثانية</b></span>
                          <span>ظهور الخيارات <b>{q.answerRevealDelaySeconds ?? 3} ثانية</b></span>
                          <span className="question-detail-wide">الإجابة الصحيحة <b>{getOptionText(q.options?.[q.correctIndex]) || "—"}</b></span>
                          <span className="question-detail-wide">الخيارات <b>{(q.options || []).map(getOptionText).join(" | ")}</b></span>
                          {getQuestionMediaUrl(q) && <span className="question-detail-wide">رابط الوسائط <b>{getQuestionMediaUrl(q)}</b></span>}
                          {getQuestionImageUrl(q) && <img className="question-inline-image" src={getQuestionImageUrl(q)} alt="صورة السؤال" />}
                        </div>
                      </td>
                    </tr>
                  )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        ))}
      </section>

      {showForm && renderQuestionForm()}
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

function AdminControl({ room, players, questions, allQuestions = [], questionPackages = [], allAnswers, messages = [], gameHistory = [], visitors = [] }) {
  const stage = room?.stage || "home";
  const adminNow = useNow(250);
  const currentQuestionIndex = room?.currentQuestionIndex ?? -1;
  const [expandedQuestions, setExpandedQuestions] = useState({});
  const [expandedPlayers, setExpandedPlayers] = useState({});
  const [editingPlayer, setEditingPlayer] = useState(null);
  const [editPlayerName, setEditPlayerName] = useState("");
  const [editPlayerScore, setEditPlayerScore] = useState(0);
  const [editPlayerJokers, setEditPlayerJokers] = useState(1);
  const [activeAdminSection, setActiveAdminSection] = useState("live");
  const [previousAdminSection, setPreviousAdminSection] = useState(null);
  const [adminAdvancing, setAdminAdvancing] = useState(false);
  const [quickControlsOpen, setQuickControlsOpen] = useState(false);
  const [liveExpandedSections, setLiveExpandedSections] = useState({
    players: true,
    questionStats: true,
    playerStats: true,
  });
  const adminSectionLabels = {
    live: "متابعة المسابقة",
    players: "المتسابقون المسجلون",
    questionReports: "إحصائيات الأسئلة",
    playerReports: "إحصائيات المتسابقين",
    history: "سجل المسابقات",
    questions: "إعدادات الأسئلة",
    setup: "تهيئة المسابقة",
    displaySettings: "إعدادات العرض",
  };

  const mainQuestions = getMainQuestions(questions);
  const practiceQuestions = getPracticeQuestions(questions);
  const competitionQuestions = mainQuestions;
  const competitionAnswers = allAnswers.filter((answer) => !answer.isPractice);

  const answersByQuestion = competitionQuestions.map((question, index) => {
    const rows = competitionAnswers
      .filter((answer) => answer.questionId === question.id || answer.questionId === question.questionId)
      .map((answer) => {
        const player = players.find((p) => p.id === answer.playerId);
        return { question, questionNumber: index + 1, answer, player, selectedText: getOptionText(question.options?.[answer.selectedIndex]) || "—" };
      });
    return { question, questionNumber: index + 1, rows };
  });

  const sortedWinners = [...players].sort((a, b) => (b.score || 0) - (a.score || 0)).slice(0, 3);
  const nextAdminQuestion = room?.practiceMode
    ? practiceQuestions[currentQuestionIndex + 1] || (currentQuestionIndex < 0 ? practiceQuestions[0] : null)
    : competitionQuestions[currentQuestionIndex + 1] || (currentQuestionIndex < 0 ? competitionQuestions[0] : null);
  const activeVisitors = visitors.filter((visitor) => Number(visitor.seenAtMs || 0) > adminNow - 120000);
  const registeredCount = players.filter((player) => !isVisitorRecord(player)).length;
  const openedLinkCount = Math.max(activeVisitors.length, registeredCount);
  const registrationPercent = openedLinkCount > 0 ? Math.min(100, Math.round((registeredCount / openedLinkCount) * 100)) : 0;
  const editingPlayerBaseline = editingPlayer
    ? Number(editingPlayer.manualScoreDelta || 0) !== 0 && Number.isFinite(Number(editingPlayer.manualScoreBaseline))
      ? Number(editingPlayer.manualScoreBaseline)
      : Number(editingPlayer.score || 0)
    : 0;
  const editingPlayerHasManualDelta = !!editingPlayer && Number(editingPlayer.manualScoreDelta || 0) !== 0;

  function openAdminSection(section) {
    if (section === activeAdminSection) return;
    setPreviousAdminSection(activeAdminSection);
    setActiveAdminSection(section);
  }

  function goBackAdminSection() {
    if (!previousAdminSection) return;
    const currentSection = activeAdminSection;
    setActiveAdminSection(previousAdminSection);
    setPreviousAdminSection(currentSection);
  }

  async function advanceFromDashboard(question = (room?.practiceMode ? practiceQuestions[currentQuestionIndex + 1] : competitionQuestions[currentQuestionIndex + 1]), questionIndex = currentQuestionIndex + 1) {
    const nextQuestion = question;
    if (!nextQuestion || adminAdvancing) return;
    setAdminAdvancing(true);
    const readyDelayMs = 3000;
    const readyUntilMs = getNow() + readyDelayMs;
    await preloadQuestionForReady(nextQuestion, questionIndex, readyUntilMs);
    setTimeout(async () => {
      await activatePreloadedQuestion();
      setAdminAdvancing(false);
    }, readyDelayMs);
  }

  async function startPracticeQuestions() {
    const firstPractice = practiceQuestions[0];
    if (!firstPractice) {
      alert("أضف أسئلة تجريبية أولًا من إعدادات الأسئلة، ثم اختر نوع السؤال: سؤال تجريبي.");
      return;
    }
    await setDoc(doc(db, "rooms", ROOM_ID), { practiceMode: true, practiceFinished: false, currentQuestionIndex: -1, updatedAt: serverTimestamp() }, { merge: true });
    await advanceFromDashboard(firstPractice, 0);
  }

  async function finishPracticeAndReturnToStart() {
    const playersSnap = await getDocs(collection(db, "rooms", ROOM_ID, "players"));
    await Promise.all(playersSnap.docs.map((playerDoc) =>
      updateDoc(playerDoc.ref, {
        score: 0,
        answeredCount: 0,
        lastQuestionPoints: 0,
        lastQuestionId: null,
        manualScoreDelta: 0,
        manualScoreBaseline: 0,
        practicePendingJoker: false,
        practiceJokerQuestionId: null,
        practiceJokerTiming: null,
        practiceJokerMultiplier: null,
        practiceJokerLockedAt: null,
      })
    ));
    await setDoc(doc(db, "rooms", ROOM_ID), {
      stage: "practiceComplete",
      practiceMode: false,
      practiceFinished: true,
      currentQuestion: null,
      currentQuestionIndex: -1,
      processedQuestionId: null,
      updatedAt: serverTimestamp(),
    }, { merge: true });
  }

  async function startRealCompetition() {
    const firstQuestion = competitionQuestions[0];
    if (!firstQuestion) {
      alert("لا توجد أسئلة فعلية. أضف سؤالًا غير تجريبي أولًا.");
      return;
    }
    const playersSnap = await getDocs(collection(db, "rooms", ROOM_ID, "players"));
    await Promise.all(playersSnap.docs.map((playerDoc) =>
      updateDoc(playerDoc.ref, {
        score: 0,
        answeredCount: 0,
        lastQuestionPoints: 0,
        lastQuestionId: null,
        manualScoreDelta: 0,
        manualScoreBaseline: 0,
        practicePendingJoker: false,
        practiceJokerQuestionId: null,
        practiceJokerTiming: null,
        practiceJokerMultiplier: null,
        practiceJokerLockedAt: null,
      })
    ));
    await setDoc(doc(db, "rooms", ROOM_ID), { practiceMode: false, practiceFinished: true, currentQuestionIndex: -1, updatedAt: serverTimestamp() }, { merge: true });
    await advanceFromDashboard(firstQuestion, 0);
  }

  function buildAnswerRows(sourceQuestions = competitionQuestions, sourcePlayers = players, sourceAnswers = competitionAnswers) {
    const rows = [];
    sourceQuestions.forEach((question, index) => {
      sourceAnswers
        .filter((answer) => answer.questionId === question.id || answer.questionId === question.questionId)
        .forEach((answer) => {
          const player = sourcePlayers.find((p) => p.id === answer.playerId) || {};
          rows.push([
            index + 1,
            question.text,
            getQuestionTypeLabel(question.type),
            player.name || answer.playerName || "",
            player.fullName || answer.fullName || "",
            player.phone || answer.phone || "",
            getOptionText(question.options?.[answer.selectedIndex]) || "—",
            answer.isCorrect ? "صح" : "خطأ",
            answer.basePoints || 0,
            answer.points || 0,
            answer.jokerApplied ? "نعم" : "لا",
          ]);
        });
    });
    return rows;
  }

  function exportFullExcel() {
    downloadExcelFile("family-quiz-full-report.xls", [
      { name: "المراكز الثلاثة الأولى", headers: ["المركز", "الاسم المستعار", "الاسم الثلاثي", "رقم الجوال", "النقاط"], rows: sortedWinners.map((player, index) => [index + 1, player.name || "", player.fullName || "", player.phone || "", player.score || 0]) },
      { name: "بيانات المتسابقين", headers: ["الاسم المستعار", "الاسم الثلاثي", "رقم الجوال", "النقاط", "حالة الجوكر", "نقاط آخر سؤال"], rows: players.map((player) => [player.name || "", player.fullName || "", player.phone || "", player.score || 0, player.jokerUsed ? "مستخدم" : player.pendingJoker ? "مفعل" : "متاح", player.lastQuestionPoints ?? 0]) },
      { name: "تفاصيل الأسئلة", headers: ["رقم السؤال", "السؤال", "النوع", "الاسم المستعار", "الاسم الثلاثي", "رقم الجوال", "الإجابة", "النتيجة", "النقاط الأصلية", "النقاط المحتسبة", "جوكر"], rows: buildAnswerRows() },
    ]);
  }

  function openEditPlayer(player) {
    setEditingPlayer(player);
    setEditPlayerName(player.name || "");
    setEditPlayerScore(Number(player.score || 0));
    setEditPlayerJokers(player.jokerUsed ? 0 : 1);
  }

  async function restoreEditedPlayerOriginalScore() {
    if (!editingPlayer || !editingPlayerHasManualDelta) return;
    await updateDoc(doc(db, "rooms", ROOM_ID, "players", editingPlayer.id), {
      score: editingPlayerBaseline,
      manualScoreBaseline: editingPlayerBaseline,
      manualScoreDelta: 0,
      manualScoreAdjustedAt: null,
    });
    setEditPlayerScore(editingPlayerBaseline);
    setEditingPlayer((player) => player ? {
      ...player,
      score: editingPlayerBaseline,
      manualScoreBaseline: editingPlayerBaseline,
      manualScoreDelta: 0,
      manualScoreAdjustedAt: null,
    } : player);
  }

  async function saveEditedPlayer() {
    if (!editingPlayer) return;
    const cleanName = editPlayerName.trim();
    const score = Number(editPlayerScore);
    const jokerAvailable = editPlayerJokers === 1;
    if (!cleanName || !Number.isFinite(score)) {
      alert("تحقق من الاسم والنقاط وعدد الجواكر.");
      return;
    }
    const duplicate = players.some((player) => player.id !== editingPlayer.id && String(player.name || "").trim().toLowerCase() === cleanName.toLowerCase());
    if (duplicate) {
      alert("الاسم المستعار مستخدم بالفعل.");
      return;
    }
    const baseline = editingPlayerBaseline;
    const manualDelta = score - baseline;

    await updateDoc(doc(db, "rooms", ROOM_ID, "players", editingPlayer.id), {
      name: cleanName,
      score,
      manualScoreBaseline: baseline,
      manualScoreDelta: manualDelta || 0,
      manualScoreAdjustedAt: manualDelta ? serverTimestamp() : null,
      jokerUsed: !jokerAvailable,
      pendingJoker: false,
      jokerQuestionId: jokerAvailable ? null : editingPlayer.jokerQuestionId || null,
      jokerQuestionNumber: jokerAvailable ? null : editingPlayer.jokerQuestionNumber || null,
    });
    setEditingPlayer(null);
  }

  function toggleQuestion(questionId) { setExpandedQuestions((prev) => ({ ...prev, [questionId]: !prev[questionId] })); }
  function togglePlayerReport(playerId) { setExpandedPlayers((prev) => ({ ...prev, [playerId]: !prev[playerId] })); }
  function toggleLiveSection(section) {
    setLiveExpandedSections((prev) => ({ ...prev, [section]: !prev[section] }));
  }

  return (
    <div className="control-page dashboard-shell">
      <aside className="dashboard-sidebar">
        <div className="dashboard-brand">
          <span>Q</span>
          <div>
            <strong>{QUIZ_TITLE}</strong>
            <small>{QUIZ_SUBTITLE}</small>
          </div>
        </div>
        <nav className="dashboard-nav">
          <div className="dashboard-nav-group">
            <span>أثناء البث</span>
            <button type="button" className={activeAdminSection === "live" ? "active" : ""} onClick={() => openAdminSection("live")}>متابعة المسابقة</button>
          </div>
          <div className="dashboard-nav-group">
            <span>المتسابقون</span>
            <button type="button" className={activeAdminSection === "players" ? "active" : ""} onClick={() => openAdminSection("players")}>المتسابقون المسجلون</button>
          </div>
          <div className="dashboard-nav-group">
            <span>التحليل</span>
            <button type="button" className={activeAdminSection === "questionReports" ? "active" : ""} onClick={() => openAdminSection("questionReports")}>إحصائيات الأسئلة</button>
            <button type="button" className={activeAdminSection === "playerReports" ? "active" : ""} onClick={() => openAdminSection("playerReports")}>إحصائيات المتسابقين</button>
            <button type="button" className={activeAdminSection === "history" ? "active" : ""} onClick={() => openAdminSection("history")}>سجل المسابقات</button>
          </div>
          <div className="dashboard-nav-group">
            <span>الإعداد</span>
            <button type="button" className={activeAdminSection === "questions" ? "active" : ""} onClick={() => openAdminSection("questions")}>إعدادات الأسئلة</button>
            <button type="button" className={activeAdminSection === "setup" ? "active" : ""} onClick={() => openAdminSection("setup")}>تهيئة المسابقة</button>
            <button type="button" className={activeAdminSection === "displaySettings" ? "active" : ""} onClick={() => openAdminSection("displaySettings")}>إعدادات العرض</button>
          </div>
        </nav>
        <a className="dashboard-display-button" href={`/?admin=${ADMIN_CODE}&view=display`} target="_blank" rel="noreferrer">فتح صفحة العرض ↗</a>
        <button className="dashboard-export-button" onClick={exportFullExcel}>استخراج Excel شامل</button>
      </aside>

      <main className="dashboard-main">
      <div className="dashboard-main-header">
        <div>
          <span>لوحة الإدارة</span>
          <strong>{adminSectionLabels[activeAdminSection]}</strong>
        </div>
        <div className="dashboard-header-actions">
          {previousAdminSection && <button type="button" className="dashboard-back-button" onClick={goBackAdminSection}>عودة</button>}
          {activeAdminSection === "live" && (
            <div className="dashboard-broadcast-controls">
              <button
                type="button"
                className="quick-control-toggle"
                onClick={() => setQuickControlsOpen((value) => !value)}
                aria-expanded={quickControlsOpen}
              >
                تحكم سريع أثناء البث
              </button>
              {quickControlsOpen && (
                <div className="quick-control-actions">
                  {stage === "home" && <button onClick={resetAndStartRegistration}>فتح التسجيل</button>}
                  {stage === "instructions" && practiceQuestions.length > 0 && <button onClick={startPracticeQuestions} disabled={adminAdvancing || players.length === 0}>{adminAdvancing ? "استعدوا..." : "بدء التجربة"}</button>}
                  {stage === "instructions" && <button onClick={startRealCompetition} disabled={adminAdvancing || competitionQuestions.length === 0 || players.length === 0}>{adminAdvancing ? "استعدوا..." : "ابدأ المسابقة"}</button>}
                  {stage === "registration" && room?.practiceFinished && <button onClick={startRealCompetition} disabled={adminAdvancing || competitionQuestions.length === 0 || players.length === 0}>{adminAdvancing ? "استعدوا..." : "ابدأ المسابقة"}</button>}
                  {stage === "practiceComplete" && <button onClick={startRealCompetition} disabled={adminAdvancing || competitionQuestions.length === 0 || players.length === 0}>{adminAdvancing ? "استعدوا..." : "ابدأ المسابقة"}</button>}
                  {stage === "registration" && !room?.practiceFinished && <button onClick={showInstructionsPage} disabled={players.length === 0}>عرض معلومات المسابقة</button>}
                  {stage === "question" && <button className="warning-action" onClick={() => extendQuestionTime(room, 10)}>+10 ثوانٍ</button>}
                  {stage === "question" && isMediaQuestion(room?.currentQuestion) && !hasMediaEnded(room, room.currentQuestion) && <button className="warning-action" onClick={() => finishMediaQuestion(room.currentQuestion)}>إنهاء المقطع وإظهار الخيارات</button>}
                  {stage === "question" && <button onClick={() => endQuestionAndReveal(room, { allowUndo: true })}>إنهاء السؤال وإظهار الإجابة</button>}
                  {stage === "reveal" && Number(room?.revealUndoUntilMs || 0) > adminNow && getQuestionTimeLeft(room?.currentQuestion, room, adminNow) > 0 && <button className="warning-action" onClick={() => reopenQuestion(room)}>تراجع</button>}
                  {stage === "reveal" && <button onClick={showResults}>إظهار النتائج</button>}
                  {stage === "results" && room?.practiceMode && <button className="secondary-action" onClick={launchInstructionsClarityPoll}>تصويت</button>}
                  {stage === "results" && room?.practiceMode && <button className="warning-action" onClick={finishPracticeAndReturnToStart}>إنهاء التجربة</button>}
                  {stage === "results" && (room?.practiceMode ? practiceQuestions[currentQuestionIndex + 1] : competitionQuestions[currentQuestionIndex + 1]) && <button onClick={advanceFromDashboard} disabled={adminAdvancing || room?.processedQuestionId !== room?.currentQuestion?.questionId}>{adminAdvancing ? "استعدوا..." : room?.processedQuestionId === room?.currentQuestion?.questionId ? "السؤال التالي" : "جاري احتساب النتائج..."}</button>}
                  {stage !== "home" && stage !== "finished" && <button className="secondary-action" onClick={() => launchSystemCheck()}>استفتاء</button>}
                  {stage !== "home" && stage !== "finished" && <button className="danger" onClick={() => { if (window.confirm("هل تريد إنهاء المسابقة الآن؟")) finishGame(players, questions, allAnswers || [], messages); }}>إنهاء المسابقة الآن</button>}
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {activeAdminSection === "live" && <>
      <div className="dashboard-live-top-row">
        <div className="admin-next-question-card admin-next-question-main">
          <span>السؤال القادم هو:</span>
          <strong>{nextAdminQuestion?.text || "لا يوجد سؤال تالٍ"}</strong>
          {getQuestionImageUrl(nextAdminQuestion) && (
            <img className="admin-next-question-image" src={getQuestionImageUrl(nextAdminQuestion)} alt="صورة السؤال القادم" />
          )}
          {nextAdminQuestion?.options?.length > 0 && (
            <div className="admin-next-question-options">
              {nextAdminQuestion.options.map((option, index) => {
                const optionImage = getOptionImage(option, nextAdminQuestion.optionImageUrls || [], index);
                const isCorrect = index === Number(nextAdminQuestion.correctIndex || 0);
                return (
                  <div className={isCorrect ? "admin-next-option correct" : "admin-next-option"} key={`${nextAdminQuestion.id || "next-top"}-${index}`}>
                    {optionImage && <img src={optionImage} alt="" />}
                    <b>{getOptionText(option)}</b>
                    {isCorrect && <em>الإجابة الصحيحة</em>}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div className="live-registration-summary-card">
          <span>جاهزية التسجيل</span>
          <div className="live-registration-stats">
            <div>
              <small>فتحوا الرابط</small>
              <strong>{openedLinkCount}</strong>
            </div>
            <div>
              <small>سجلوا</small>
              <strong>{registeredCount}</strong>
            </div>
          </div>
          <div className="live-registration-ratio">
            <span>نسبة التسجيل</span>
            <strong>{registrationPercent}%</strong>
            <i style={{ "--ratio": `${registrationPercent}%` }} />
          </div>
        </div>
      </div>
      <div className="dashboard-live-grid">
        <section className="question-report-card live-report-card live-question-stats-section">
          <button type="button" className="question-report-header" onClick={() => toggleLiveSection("players")}>
            <div className="question-report-title"><strong>المتسابقون</strong></div>
            <span className="expand-indicator">{liveExpandedSections.players ? "−" : "+"}</span>
          </button>
          {liveExpandedSections.players && <div className="question-report-body">
            {players.length === 0 ? <span className="muted">لا يوجد متسابقون حتى الآن.</span> : (
              <div className="admin-table-wrap">
                <table className="admin-table live-players-table">
                  <thead>
                    <tr>
                      <th>المتسابق</th>
                      <th>الاسم الثلاثي</th>
                      <th>الجوال</th>
                      <th>النقاط</th>
                      <th>الجوكر</th>
                      <th>تعديل</th>
                    </tr>
                  </thead>
                  <tbody>
                    {players.map((player) => (
                      <tr key={player.id}>
                        <td><strong>{player.emoji || "👤"} {player.name}</strong></td>
                        <td>{player.fullName || "—"}</td>
                        <td style={{ direction: "ltr", textAlign: "right" }}>{player.phone || "—"}</td>
                        <td><strong>{player.score || 0}</strong>{Number(player.manualScoreDelta || 0) !== 0 && <span className={player.manualScoreDelta > 0 ? "manual-delta positive" : "manual-delta negative"}>{player.manualScoreDelta > 0 ? `+${player.manualScoreDelta}` : player.manualScoreDelta}</span>}</td>
                        <td>{player.jokerUsed ? "\u{1F0CF} مستخدم" : player.pendingJoker ? "\u{1F7E2} مفعل" : "متاح"}</td>
                        <td><button type="button" className="icon-action-button" title="تعديل المتسابق" aria-label="تعديل المتسابق" onClick={() => openEditPlayer(player)}>✎</button></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>}
        </section>
      </div>
      <div className="dashboard-live-overview">
        <section className="question-report-card live-report-card live-question-stats-section">
          <button type="button" className="question-report-header" onClick={() => toggleLiveSection("questionStats")}>
            <div className="question-report-title"><strong>إحصائيات الأسئلة</strong></div>
            <span className="expand-indicator">{liveExpandedSections.questionStats ? "−" : "+"}</span>
          </button>
          {liveExpandedSections.questionStats && <div className="question-report-body">
            <div className="question-list live-collapsible-list">{answersByQuestion.map(({ question, questionNumber, rows }) => {
              const expanded = !!expandedQuestions[question.id];
              const correctCount = rows.filter((row) => row.answer.isCorrect).length;
              const percent = rows.length ? Math.round((correctCount / rows.length) * 100) : 0;
              return (
                <div className="question-report-card" key={question.id}>
                  <button type="button" className="question-report-header" onClick={() => toggleQuestion(question.id)}>
                    <div className="question-report-title"><strong>{questionNumber}. {question.text} <span className="report-accuracy-inline" style={{ color: getAccuracyColor(percent) }}>({percent}%)</span></strong></div>
                    <span className="expand-indicator">{expanded ? "−" : "+"}</span>
                  </button>
                  {expanded && <div className="question-report-body">{rows.length === 0 ? <span className="muted">لا توجد إجابات لهذا السؤال.</span> : <div className="admin-table-wrap"><table className="admin-table live-question-answers-table"><thead><tr><th>المتسابق</th><th>الاسم الثلاثي</th><th>الإجابة</th><th>النتيجة</th><th>النقاط</th><th>جوكر</th></tr></thead><tbody>{rows.map(({ answer, player, selectedText }) => <tr className={answer.isCorrect ? "live-answer-row-correct" : "live-answer-row-wrong"} key={answer.id}><td><strong>{player?.name || answer.playerName}</strong></td><td>{player?.fullName || answer.fullName || "—"}</td><td>{selectedText}</td><td style={{ color: answer.isCorrect ? "#18733a" : "#a51f1f", fontWeight: 900 }}>{answer.isCorrect ? "صح" : "خطأ"}</td><td><strong>{answer.points || 0}</strong></td><td>{answer.jokerApplied ? "\u{1F0CF}" : "—"}</td></tr>)}</tbody></table></div>}</div>}
                </div>
              );
            })}</div>
          </div>}
        </section>
        <section className="question-report-card live-report-card live-player-stats-section">
          <button type="button" className="question-report-header" onClick={() => toggleLiveSection("playerStats")}>
            <div className="question-report-title"><strong>إحصائيات المتسابقين</strong></div>
            <span className="expand-indicator">{liveExpandedSections.playerStats ? "−" : "+"}</span>
          </button>
          {liveExpandedSections.playerStats && <div className="question-report-body">
            <div className="question-list live-collapsible-list">{players.map((player) => {
              const expanded = !!expandedPlayers[player.id];
              const playerAnswers = competitionQuestions.map((question, index) => {
                const answer = competitionAnswers.find((item) => item.playerId === player.id && (item.questionId === question.id || item.questionId === question.questionId));
                return { question, questionNumber: index + 1, answer, selectedText: answer ? getOptionText(question.options?.[answer.selectedIndex]) || "—" : "لم يجب" };
              });
              const answeredCount = playerAnswers.filter((row) => row.answer).length;
              const correctCount = playerAnswers.filter((row) => row.answer?.isCorrect).length;
              const percent = answeredCount ? Math.round((correctCount / answeredCount) * 100) : 0;
              return (
                <div className="player-report-card" key={player.id}>
                  <button type="button" className="player-report-header" onClick={() => togglePlayerReport(player.id)}>
                    <div className="player-report-title"><strong>{player.emoji || ""} {player.name} {player.fullName && <small className="player-fullname-inline">({player.fullName})</small>} <span className="report-accuracy-inline" style={{ color: getAccuracyColor(percent) }}>({percent}%)</span></strong></div>
                    <span className="expand-indicator">{expanded ? "−" : "+"}</span>
                  </button>
                  {expanded && <div className="player-report-body"><div className="admin-table-wrap"><table className="admin-table live-player-answers-table"><thead><tr><th>رقم السؤال</th><th>السؤال</th><th>إجابة المتسابق</th><th>النتيجة</th><th>النقاط</th></tr></thead><tbody>{playerAnswers.map(({ question, questionNumber, answer, selectedText }) => <tr className={answer ? (answer.isCorrect ? "live-answer-row-correct" : "live-answer-row-wrong") : ""} key={`${player.id}-${question.id}`}><td>{questionNumber}</td><td>{question.text} {answer?.jokerApplied && <span className="inline-joker-mark" title="استخدم الجوكر">{"\u{1F0CF}"}</span>}</td><td>{selectedText}</td><td style={{ fontWeight: 900, color: answer ? (answer.isCorrect ? "#18733a" : "#a51f1f") : undefined }}>{answer ? (answer.isCorrect ? "صح" : "خطأ") : "—"}</td><td>{answer?.points ?? "—"}</td></tr>)}</tbody></table></div></div>}
                </div>
              );
            })}</div>
          </div>}
        </section>
      </div>
      </>}

      {activeAdminSection === "setup" && (
      <div className="card setup-actions-card">
        <h2>تهيئة المسابقة</h2>
        <p className="muted">اختر الإجراء المطلوب بعناية. الأسئلة المحفوظة لا تُحذف من أي خيار هنا.</p>
        <div className="setup-action-list">
          <div className="setup-action-row">
            <div><strong>العودة للصفحة الرئيسية</strong><span>يعيد حالة العرض والمتسابقين إلى الانتظار دون حذف الأسماء أو النتائج.</span></div>
            <button onClick={createOrResetRoom}>تنفيذ</button>
          </div>
          <div className="setup-action-row">
            <div><strong>فتح تسجيل جديد</strong><span>يمسح المتسابقين والإجابات والرسائل، ثم يفتح التسجيل لجولة جديدة.</span></div>
            <button onClick={() => { if (window.confirm("مسح بيانات الجولة الحالية وفتح تسجيل جديد؟")) resetAndStartRegistration(); }}>تنفيذ</button>
          </div>
          <div className="setup-action-row">
            <div><strong>مسح الإجابات والرسائل فقط</strong><span>يبقي أسماء المتسابقين، ويمسح إجابات الجولة والرسائل، ثم يعيد العرض للصفحة الرئيسية.</span></div>
            <button className="warning-action" onClick={() => { if (window.confirm("مسح الإجابات والرسائل مع إبقاء المتسابقين؟")) clearAnswersAndMessages(); }}>تنفيذ</button>
          </div>
          <div className="setup-action-row">
            <div><strong>مسح الرسائل فقط</strong><span>يحذف رسائل المتسابقين دون التأثير على الأسماء أو النقاط أو الأسئلة.</span></div>
            <button className="warning-action" onClick={() => { if (window.confirm("مسح رسائل المتسابقين فقط؟")) clearMessagesOnly(); }}>تنفيذ</button>
          </div>
          <div className="setup-action-row danger-row">
            <div><strong>تصفير الجولة بالكامل</strong><span>يمسح المتسابقين والإجابات والرسائل ويعيد المسابقة إلى البداية.</span></div>
            <button className="danger" onClick={() => { if (window.confirm("تصفير الجولة بالكامل؟")) hardResetGame(); }}>تنفيذ</button>
          </div>
        </div>
      </div>
      )}

      {activeAdminSection === "displaySettings" && (
      <div className="card setup-actions-card display-settings-card">
        <h2>إعدادات العرض</h2>
        <div className="setup-action-list">
          <div className="setup-action-row">
            <div>
              <strong>مساحة الفيديو في صفحة العرض</strong>
              <span>يصغّر رسائل المتسابقين ويضيف تحتها مساحة ثابتة تضع فيها الكاميرا أو الفيديو داخل برنامج البث.</span>
            </div>
            <button
              type="button"
              className={room?.displayVideoSlotEnabled ? "warning-action" : ""}
              onClick={() => toggleDisplayVideoSlot(!room?.displayVideoSlotEnabled)}
            >
              {room?.displayVideoSlotEnabled ? "إخفاء المساحة" : "إظهار المساحة"}
            </button>
          </div>
        </div>
      </div>
      )}

      {activeAdminSection === "players" && (
      <div className="card">
        <div className="report-section-title"><h2>المتسابقون المسجلون</h2></div>
        {players.length === 0 ? <p className="muted">لا يوجد متسابقون حتى الآن.</p> : (
          <div className="admin-table-wrap">
            <table className="admin-table"><thead><tr><th>الاسم المستعار</th><th>الاسم الثلاثي</th><th>رقم الجوال</th><th>النقاط</th><th>آخر سؤال</th><th>الجوكر</th><th>تحكم</th></tr></thead>
              <tbody>{players.map((player) => <tr key={player.id}><td><strong>{player.emoji || ""} {player.name}</strong></td><td>{player.fullName || "—"}</td><td style={{ direction: "ltr", textAlign: "right" }}>{player.phone || "—"}</td><td><strong><AnimatedNumber value={player.score || 0} /></strong>{Number(player.manualScoreDelta || 0) !== 0 && <span className={player.manualScoreDelta > 0 ? "manual-delta positive" : "manual-delta negative"}> {player.manualScoreDelta > 0 ? `(+${player.manualScoreDelta})` : `(${player.manualScoreDelta})`}</span>}</td><td><strong>{player.lastQuestionPoints > 0 ? `+${player.lastQuestionPoints}` : player.lastQuestionPoints ?? 0}</strong></td><td>{player.jokerUsed ? "\u{1F0CF} مستخدم" : player.pendingJoker ? "\u{1F7E2} مفعل" : "متاح"}</td><td><button className="icon-action-button" title="تعديل" aria-label="تعديل المتسابق" onClick={() => openEditPlayer(player)}>✎</button></td></tr>)}</tbody></table>
          </div>
        )}
      </div>
      )}

      {activeAdminSection === "questionReports" && (
      <div className="card"><div className="report-section-title"><h2>تقرير إجابات الأسئلة</h2></div>
        {answersByQuestion.every((item) => item.rows.length === 0) ? <p className="muted">لا توجد إجابات محفوظة حتى الآن.</p> : (
          <div className="question-list">{answersByQuestion.map(({ question, questionNumber, rows }) => {
            const expanded = !!expandedQuestions[question.id];
            const correctCount = rows.filter((row) => row.answer.isCorrect).length;
            const wrongCount = rows.filter((row) => !row.answer.isCorrect).length;
            const jokerCount = rows.filter((row) => row.answer.jokerApplied).length;
            const correctPercent = rows.length ? Math.round((correctCount / rows.length) * 100) : 0;
            return <div className="question-report-card" key={question.id}>
              <button type="button" className="question-report-header" onClick={() => toggleQuestion(question.id)}><div className="question-report-title"><strong>{questionNumber}. {question.text} <span className="report-accuracy-inline" style={{ color: getAccuracyColor(correctPercent) }}>({correctPercent}%)</span></strong><span>صح {correctCount} — خطأ {wrongCount} — {"\u{1F0CF}"} {jokerCount}</span></div><span className="expand-indicator">{expanded ? "−" : "+"}</span></button>
              {expanded && <div className="question-report-body">{rows.length === 0 ? <span className="muted">لا توجد إجابات لهذا السؤال.</span> : <div className="admin-table-wrap"><table className="admin-table"><thead><tr><th>المتسابق</th><th>الاسم الثلاثي</th><th>الجوال</th><th>الإجابة</th><th>النتيجة</th><th>النقاط</th><th>جوكر</th></tr></thead><tbody>{rows.map(({ answer, player, selectedText }) => <tr key={answer.id}><td><strong>{player?.name || answer.playerName}</strong></td><td>{player?.fullName || answer.fullName || "—"}</td><td style={{ direction: "ltr", textAlign: "right" }}>{player?.phone || answer.phone || "—"}</td><td>{selectedText}</td><td style={{ color: answer.isCorrect ? "#18733a" : "#a51f1f", fontWeight: 900 }}>{answer.isCorrect ? "صح" : "خطأ"}</td><td><strong>{answer.points || 0}</strong></td><td>{answer.jokerApplied ? "\u{1F0CF}" : "—"}</td></tr>)}</tbody></table></div>}</div>}
            </div>;
          })}</div>
        )}
      </div>
      )}

      {activeAdminSection === "playerReports" && (
      <div className="card"><div className="report-section-title"><h2>تقرير المتسابقين</h2></div>
        {players.length === 0 ? <p className="muted">لا يوجد متسابقون حتى الآن.</p> : (
          <div className="question-list">{players.map((player) => {
            const expanded = !!expandedPlayers[player.id];
            const playerAnswers = competitionQuestions.map((question, index) => {
              const answer = competitionAnswers.find((item) => item.playerId === player.id && (item.questionId === question.id || item.questionId === question.questionId));
              return { question, questionNumber: index + 1, answer, selectedText: answer ? getOptionText(question.options?.[answer.selectedIndex]) || "—" : "لم يجب" };
            });
            const answeredCount = playerAnswers.filter((row) => row.answer).length;
            const correctCount = playerAnswers.filter((row) => row.answer?.isCorrect).length;
            const jokerCount = playerAnswers.filter((row) => row.answer?.jokerApplied).length;
            const correctPercent = answeredCount ? Math.round((correctCount / answeredCount) * 100) : 0;
            return <div className="player-report-card" key={player.id}><button type="button" className="player-report-header" onClick={() => togglePlayerReport(player.id)}><div className="player-report-title"><strong>{player.name} <span className="report-accuracy-inline" style={{ color: getAccuracyColor(correctPercent) }}>({correctPercent}%)</span></strong>{expanded && <span>أجاب {answeredCount} / {competitionQuestions.length} — صح {correctCount} — {"\u{1F0CF}"} {jokerCount}</span>}</div><span className="expand-indicator">{expanded ? "−" : "+"}</span></button>{expanded && <div className="player-report-body"><div className="admin-table-wrap"><table className="admin-table"><thead><tr><th>رقم السؤال</th><th>السؤال</th><th>إجابة المتسابق</th><th>النتيجة</th><th>النقاط</th><th>جوكر</th></tr></thead><tbody>{playerAnswers.map(({ question, questionNumber, answer, selectedText }) => <tr key={`${player.id}-${question.id}`}><td>{questionNumber}</td><td>{question.text}</td><td>{selectedText}</td><td style={{ fontWeight: 900, color: answer ? (answer.isCorrect ? "#18733a" : "#a51f1f") : undefined }}>{answer ? (answer.isCorrect ? "صح" : "خطأ") : "—"}</td><td>{answer?.points ?? "—"}</td><td>{answer?.jokerApplied ? "\u{1F0CF}" : "—"}</td></tr>)}</tbody></table></div></div>}</div>;
          })}</div>
        )}
      </div>
      )}

      {activeAdminSection === "questions" && <QuestionSettings questions={questions} room={room} questionPackages={questionPackages} allQuestions={allQuestions} embedded />}

      {activeAdminSection === "history" && <LastGamePanel room={room} gameHistory={gameHistory} embedded />}

      {editingPlayer && (
        <div className="modal-backdrop" onClick={() => setEditingPlayer(null)}>
          <div className="modal-card edit-player-modal" onClick={(event) => event.stopPropagation()}>
            <h2>تعديل بيانات المتسابق</h2>
            <label>الاسم المستعار</label>
            <input value={editPlayerName} onChange={(e) => setEditPlayerName(e.target.value)} placeholder="الاسم المستعار" />
            <label>النقاط الحالية</label>
            <input type="number" value={editPlayerScore} onChange={(e) => setEditPlayerScore(e.target.value)} placeholder="النقاط الحالية" />
            <button type="button" className="secondary-action restore-score-button" onClick={restoreEditedPlayerOriginalScore} disabled={!editingPlayerHasManualDelta}>
              إرجاع النقاط الأصلية
            </button>
            <label>حالة الجوكر</label>
            <div className="joker-availability-toggle">
              <button type="button" className={editPlayerJokers === 1 ? "active" : ""} onClick={() => setEditPlayerJokers(1)}>متوفر</button>
              <button type="button" className={editPlayerJokers === 0 ? "active" : ""} onClick={() => setEditPlayerJokers(0)}>غير متوفر</button>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px" }}>
              <button onClick={saveEditedPlayer}>حفظ</button>
              <button className="danger" onClick={() => setEditingPlayer(null)}>إلغاء</button>
            </div>
          </div>
        </div>
      )}
      </main>
    </div>
  );
}

function HealthCheckResultsPanel({ room, players = [] }) {
  const check = room?.healthCheck;
  if (!check?.active) return null;

  const responses = Object.values(check.responses || {});
  const okLabel = check.okText || "كل شي تمام";
  const problemLabel = check.problemText || "في مشكلة";
  const okCount = responses.filter((item) => item.answerText === okLabel || item.answerText === "كل شي تمام").length;
  const problemCount = responses.filter((item) => item.answerText === problemLabel || item.answerText === "في مشكلة").length;
  const totalCount = responses.length;
  const votersTarget = players.length;

  return (
    <div className={check.kind === "instructions" ? "admin-health-popover instructions-health-popover" : "admin-health-popover"}>
      <div className="health-popover-title">
        <strong>{check.title || "استفتاء"}</strong>
        <span>قام بالتصويت {totalCount} من {votersTarget}</span>
      </div>
      <div className="health-result-row ok"><span>{okLabel}</span><strong>{okCount}</strong></div>
      <div className="health-result-row problem"><span>{problemLabel}</span><strong>{problemCount}</strong></div>
      <button type="button" className="health-stop-button" onClick={stopSystemCheck}>إيقاف</button>
    </div>
  );
}


function DisplayScreen({ room, players, questions, messages, answers, allAnswers }) {
  const [previewStage, setPreviewStage] = useState(null);
  const [previewQuestionIndex, setPreviewQuestionIndex] = useState(null);
  const [readyCountdown, setReadyCountdown] = useState(null);
  const [showForceProcess, setShowForceProcess] = useState(false);
  const readyTimerRef = useRef(null);
  const displayNow = useNow(250);

  const stage = room?.stage || "home";
  const displayStage = previewStage || stage;
  const displayVideoSlotEnabled = !!room?.displayVideoSlotEnabled;
  const currentQuestion = room?.currentQuestion || null;
  const currentQuestionIndex = room?.currentQuestionIndex ?? -1;
  const displayQuestionList = room?.practiceMode ? getPracticeQuestions(questions) : getMainQuestions(questions);
  const nextQuestion = displayQuestionList?.[currentQuestionIndex + 1];
  const displayQuestionIndex = previewStage && previewQuestionIndex !== null ? previewQuestionIndex : currentQuestionIndex;
  const displayQuestionSource = previewStage && displayQuestionIndex >= 0 ? displayQuestionList?.[displayQuestionIndex] : currentQuestion;
  const displayQuestion = displayQuestionSource
    ? { ...displayQuestionSource, questionId: displayQuestionSource.questionId || displayQuestionSource.id }
    : null;
  const displayAnswers = previewStage && displayQuestion
    ? (allAnswers || []).filter((answer) => answer.questionId === displayQuestion.questionId)
    : answers;
  const displayPlayers = previewStage && displayQuestionIndex >= 0
    ? [...players]
        .map((player) => ({
          ...player,
          score: (allAnswers || [])
            .filter((answer) => answer.playerId === player.id)
            .filter((answer) => displayQuestionList.findIndex((question) => question.id === answer.questionId || question.questionId === answer.questionId) <= displayQuestionIndex)
            .reduce((total, answer) => total + Number(answer.points || 0), 0),
        }))
        .sort((a, b) => (b.score || 0) - (a.score || 0))
    : players;
  const displayRoom = previewStage && displayQuestion
    ? {
        ...room,
        currentQuestion: { ...displayQuestion, answerRevealAtMs: 1, answerStartAtMs: 1, answerEndAtMs: 1 },
        currentQuestionIndex: displayQuestionIndex,
        questionSentAt: null,
        questionStartedAtMs: null,
        answerRevealAtMs: 1,
        answerEndAtMs: 1,
        processedQuestionId: displayQuestion.questionId,
        collectingBonusByPlayer: Object.fromEntries(displayAnswers.map((answer) => [answer.playerId, Number(answer.points || 0)])),
        rankMovementByPlayer: {},
      }
    : room;

  const currentProcessed =
    room?.processedQuestionId === room?.currentQuestion?.questionId;

  useEffect(() => {
    setPreviewStage(null);
    setPreviewQuestionIndex(null);
    setReadyCountdown(null);
    if (readyTimerRef.current) {
      clearInterval(readyTimerRef.current);
      readyTimerRef.current = null;
    }
  }, [stage, room?.currentQuestion?.questionId]);

  useEffect(() => {
    if (stage !== "results" || currentProcessed) {
      setShowForceProcess(false);
      return;
    }

    const timeout = setTimeout(() => setShowForceProcess(true), 5000);
    return () => clearTimeout(timeout);
  }, [stage, currentProcessed, room?.currentQuestion?.questionId]);

  useEffect(() => {
    return () => {
      if (readyTimerRef.current) clearInterval(readyTimerRef.current);
    };
  }, []);

  if (!room) {
    return (
      <div className="display-frame">
        <div className="display-panel display-home">
          <h1>جاري تحميل المسابقة...</h1>
        </div>
      </div>
    );
  }

  function previewPreviousStep() {
    const index = displayQuestionIndex;
    if (displayStage === "finished") {
      setPreviewQuestionIndex(currentQuestionIndex);
      setPreviewStage("results");
    } else if (displayStage === "results") {
      setPreviewQuestionIndex(index);
      setPreviewStage("reveal");
    } else if (displayStage === "reveal") {
      setPreviewQuestionIndex(index);
      setPreviewStage("question");
    } else if (displayStage === "question" && index > 0) {
      setPreviewQuestionIndex(index - 1);
      setPreviewStage("results");
    } else if (displayStage === "question") {
      setPreviewQuestionIndex(null);
      setPreviewStage("registration");
    } else if (displayStage === "registration") {
      setPreviewQuestionIndex(null);
      setPreviewStage("instructions");
    } else if (displayStage === "instructions") {
      setPreviewQuestionIndex(null);
      setPreviewStage("home");
    }
  }

  function previewNextStep() {
    const index = displayQuestionIndex;
    if (!previewStage) return;

    if (displayStage === "home") {
      setPreviewStage("instructions");
    } else if (displayStage === "instructions") {
      setPreviewStage("registration");
    } else if (displayStage === "registration" && currentQuestionIndex >= 0) {
      setPreviewQuestionIndex(0);
      setPreviewStage("question");
    } else if (displayStage === "question") {
      setPreviewQuestionIndex(index);
      setPreviewStage("reveal");
    } else if (displayStage === "reveal") {
      setPreviewQuestionIndex(index);
      setPreviewStage("results");
    } else if (displayStage === "results" && index < currentQuestionIndex) {
      setPreviewQuestionIndex(index + 1);
      setPreviewStage("question");
    } else {
      setPreviewStage(null);
      setPreviewQuestionIndex(null);
    }
  }

  async function startCompetition() {
    const firstQuestion = getMainQuestions(questions)[0];
    if (!firstQuestion) {
      alert("أضف سؤالًا فعليًا واحدًا على الأقل قبل بدء المسابقة.");
      return;
    }

    const playersSnap = await getDocs(collection(db, "rooms", ROOM_ID, "players"));
    await Promise.all(playersSnap.docs.map((playerDoc) =>
      updateDoc(playerDoc.ref, {
        score: 0,
        answeredCount: 0,
        lastQuestionPoints: 0,
        lastQuestionId: null,
        manualScoreDelta: 0,
        manualScoreBaseline: 0,
        practicePendingJoker: false,
        practiceJokerQuestionId: null,
        practiceJokerTiming: null,
        practiceJokerMultiplier: null,
        practiceJokerLockedAt: null,
      })
    ));
    await setDoc(doc(db, "rooms", ROOM_ID), { practiceMode: false, practiceFinished: true, currentQuestionIndex: -1, updatedAt: serverTimestamp() }, { merge: true });
    await startReadyThenSend(firstQuestion, 0);
  }

  async function startReadyThenSend(question, questionIndex) {
    if (readyTimerRef.current) clearInterval(readyTimerRef.current);

    const readyDelayMs = 3000;
    const readyUntilMs = getNow() + readyDelayMs;
    await preloadQuestionForReady(question, questionIndex, readyUntilMs);

    setPreviewStage("ready");
    setReadyCountdown(3);

    let counter = 3;
    readyTimerRef.current = setInterval(async () => {
      counter -= 1;
      if (counter > 0) {
        setReadyCountdown(counter);
        return;
      }

      clearInterval(readyTimerRef.current);
      readyTimerRef.current = null;
      setReadyCountdown(null);
      await activatePreloadedQuestion();
      setPreviewStage(null);
    }, 1000);
  }

  async function finishPracticeToRegistration() {
    const playersSnap = await getDocs(collection(db, "rooms", ROOM_ID, "players"));
    await Promise.all(playersSnap.docs.map((playerDoc) =>
      updateDoc(playerDoc.ref, {
        score: 0,
        answeredCount: 0,
        lastQuestionPoints: 0,
        lastQuestionId: null,
        manualScoreDelta: 0,
        manualScoreBaseline: 0,
        practicePendingJoker: false,
        practiceJokerQuestionId: null,
        practiceJokerTiming: null,
        practiceJokerMultiplier: null,
        practiceJokerLockedAt: null,
      })
    ));
    await setDoc(doc(db, "rooms", ROOM_ID), {
      stage: "practiceComplete",
      practiceMode: false,
      practiceFinished: true,
      currentQuestion: null,
      currentQuestionIndex: -1,
      updatedAt: serverTimestamp(),
    }, { merge: true });
  }

  async function goNextQuestion() {
    if (!nextQuestion) {
      if (room?.practiceMode) {
        await finishPracticeToRegistration();
        return;
      }
      await finishGame(players, getMainQuestions(questions), allAnswers || [], messages);
      return;
    }

    await startReadyThenSend(nextQuestion, currentQuestionIndex + 1);
  }

  async function startPracticeFromDisplay() {
    const firstPractice = getPracticeQuestions(questions)[0];
    if (!firstPractice) {
      alert("أضف حتى 3 أسئلة تجريبية من إعدادات الأسئلة أولًا.");
      return;
    }

    await setDoc(doc(db, "rooms", ROOM_ID), {
      practiceMode: true,
      practiceFinished: false,
      currentQuestionIndex: -1,
      updatedAt: serverTimestamp(),
    }, { merge: true });

    await startReadyThenSend(firstPractice, 0);
  }

  function renderDisplayButton() {
    let mainButton = null;

    if (stage === "home") {
      mainButton = <button onClick={resetAndStartRegistration}>فتح التسجيل</button>;
    } else if (stage === "instructions") {
      mainButton = (
        <div className="display-instructions-action-row">
          <button onClick={startCompetition} disabled={getMainQuestions(questions).length === 0 || players.length === 0}>ابدأ المسابقة</button>
          <div className="display-practice-actions">
            <span>تجربة</span>
            <button type="button" onClick={startPracticeFromDisplay} disabled={players.length === 0 || getPracticeQuestions(questions).length === 0}>بدء الأسئلة التجريبية</button>
          </div>
        </div>
      );
    } else if (stage === "registration" || stage === "practiceComplete") {
      mainButton = (
        <button
          onClick={stage === "practiceComplete" || room?.practiceFinished ? startCompetition : showInstructionsPage}
          disabled={players.length === 0 || (room?.practiceFinished && getMainQuestions(questions).length === 0)}
        >
          {stage === "practiceComplete" || room?.practiceFinished ? "ابدأ المسابقة" : "عرض معلومات المسابقة"}
        </button>
      );
    } else if (stage === "question") {
      mainButton = <button onClick={() => endQuestionAndReveal(room, { allowUndo: true })}>إنهاء السؤال الآن وإظهار الإجابة الصحيحة</button>;
    } else if (stage === "reveal") {
      mainButton = <button onClick={showResults}>إظهار النتائج</button>;
    } else if (stage === "results") {
      mainButton = (
        <>
          <button onClick={goNextQuestion} disabled={!currentProcessed}>
            {currentProcessed ? (nextQuestion ? "السؤال التالي" : (room?.practiceMode ? "إنهاء التجربة" : "إنهاء المسابقة")) : "جاري تجميع النتائج..."}
          </button>
          {/* FIX: Fallback force-process button shown when scores are stuck.
              This unblocks the admin if AutoProcessResults did not run
              (e.g. display page was not open when results were shown). */}
          {!currentProcessed && !room?.processingQuestionId && showForceProcess && (
            <button
              onClick={() => forceProcessResults(room, players, answers)}
              className="force-process-button"
              title="احسب النتائج يدويًا إذا توقف التجميع التلقائي"
            >
              إعادة محاولة احتساب النتائج
            </button>
          )}
        </>
      );
    } else if (stage === "finished") {
      mainButton = <button onClick={createOrResetRoom}>العودة للصفحة الرئيسية</button>;
    }

    return (
      <div className="display-primary-actions">
        {!previewStage && mainButton}
        {previewStage && displayStage !== "ready" && (
          <button
            type="button"
            className="display-nav-button display-current-stage-button"
            onClick={() => { setPreviewStage(null); setPreviewQuestionIndex(null); }}
          >
            الرجوع للمرحلة الحالية
          </button>
        )}
      </div>
    );
  }

  function renderBottomDisplayActions() {
    if (stage === "home" || stage === "instructions" || stage === "finished") return null;

    return (
      <div className="display-corner-actions">
        <HealthCheckResultsPanel room={room} players={players} />
        {stage === "question" && (
          <button
            type="button"
            className="display-corner-button extend"
            onClick={() => extendQuestionTime(room, 10)}
          >
            +10 ثوانٍ
          </button>
        )}
        {stage === "results" && room?.practiceMode && currentProcessed && (
          <>
            <button
              type="button"
              className="display-corner-button poll"
              onClick={launchInstructionsClarityPoll}
            >
              تصويت
            </button>
            <button
              type="button"
              className="display-corner-button finish"
              onClick={finishPracticeToRegistration}
            >
              إنهاء التجربة
            </button>
          </>
        )}
        <button
          type="button"
          className="display-corner-button poll"
          onClick={launchSystemCheck}
        >
          استفتاء
        </button>
        <button
          type="button"
          className="display-corner-button finish"
          onClick={() => { if (window.confirm("هل تريد إنهاء المسابقة الآن؟")) finishGame(players, questions, allAnswers || [], messages); }}
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

      {displayStage !== "home" && displayStage !== "ready" && (
        <div className="display-history-nav">
          <button type="button" className="display-nav-button display-next-button" onClick={previewNextStep} disabled={!previewStage}>التالي</button>
          <button type="button" className="display-nav-button display-back-button" onClick={previewPreviousStep}>السابق</button>
          {!previewStage && stage === "reveal" && Number(room?.revealUndoUntilMs || 0) > displayNow && getQuestionTimeLeft(currentQuestion, room, displayNow) > 0 && (
            <button type="button" className="display-nav-button display-undo-button" onClick={() => reopenQuestion(room)}>تراجع</button>
          )}
        </div>
      )}

      <div className="display-control-bar">{renderDisplayButton()}</div>

      <div className="display-content-area">
        {displayStage === "ready" && (
          <div className="display-panel ready-countdown-screen">
            <div className="ready-countdown-card">
              <span className="ready-countdown-number">{readyCountdown || 3}</span>
              <span className="ready-countdown-label">استعدوا للسؤال التالي</span>
            </div>
          </div>
        )}

        {displayStage === "home" && (
          <div className="display-panel display-home">
            <h1>{QUIZ_TITLE}</h1>
            <p>{QUIZ_SUBTITLE}</p>
          </div>
        )}

        {displayStage === "instructions" && (
          <InstructionsPage isAdmin room={room} players={players} />
        )}

        {displayStage === "registration" && (
          <div className="display-grid-main">
            <div className="display-panel registration-screen">
              <div className="registration-hero-card">
                <span className="registration-hero-icon">👥</span>
                <div>
                  <h2>تسجيل اللاعبين</h2>
                  <p>افتح رابط المسابقة من جوالك وسجّل بياناتك.</p>
                </div>
                <b>{players.length}</b>
              </div>

              <div className="players-grid display-players-grid">
                {players.length === 0 ? (
                  <div className="registration-empty-state">
                    <span>بانتظار دخول اللاعبين</span>
                    <i />
                  </div>
                ) : (
                  players.map((player) => (
                    <div className="player-chip" key={player.id}>
                      {player.emoji || ""} {player.name}
                    </div>
                  ))
                )}
              </div>
            </div>

            <DisplaySidePanel messages={messages} videoEnabled={displayVideoSlotEnabled} />
          </div>
        )}

        {displayStage === "practiceComplete" && (
          <div className="display-grid-main">
            <div className="display-panel registration-screen practice-complete-screen">
              <div className="practice-complete-hero">
                <span>✓</span>
                <h2>انتهت التجربة</h2>
                <p className="muted">استعدوا للمسابقة الفعلية. سنبدأ بعد لحظات.</p>
              </div>

              <div className="players-grid display-players-grid">
                {players.map((player) => (
                  <div className="player-chip" key={player.id}>
                    {player.emoji || ""} {player.name}
                  </div>
                ))}
              </div>
            </div>

            <DisplaySidePanel messages={messages} videoEnabled={displayVideoSlotEnabled} />
          </div>
        )}

        {displayStage === "question" && (
          <div className="display-grid-main">
            <QuestionScreen
              question={displayQuestion}
              room={displayRoom}
              answers={displayAnswers}
              playersCount={players.length}
              isAdmin
              displayMode
              visualStage={displayStage}
              showTimer={!previewStage}
            />

            <DisplaySidePanel messages={messages} videoEnabled={displayVideoSlotEnabled} />
          </div>
        )}

        {displayStage === "reveal" && (
          <div className="display-grid-main">
            <QuestionScreen
              question={displayQuestion}
              room={displayRoom}
              answers={displayAnswers}
              playersCount={players.length}
              isAdmin
              displayMode
              visualStage={displayStage}
            />

            <DisplaySidePanel messages={messages} videoEnabled={displayVideoSlotEnabled} />
          </div>
        )}

        {displayStage === "results" && (
          <ResultsDisplay room={displayRoom} players={displayPlayers} messages={messages} />
        )}

        {displayStage === "finished" && <FinishedDisplay players={players} messages={messages} />}
      </div>

      {renderBottomDisplayActions()}
    </div>
  );
}


function LastGamePanel({ room, gameHistory = [], embedded = false }) {
  const [selectedGameId, setSelectedGameId] = useState(null);
  const [expandedArchiveSections, setExpandedArchiveSections] = useState({ overview: true });
  const selectedGame =
    gameHistory.find((game) => game.id === selectedGameId) ||
    gameHistory[0] ||
    room?.lastGame ||
    null;
  const selectedPlayers = selectedGame?.players || [];
  const selectedQuestions = selectedGame?.questions || [];
  const selectedAnswers = selectedGame?.answers || [];
  const selectedMessages = selectedGame?.messages || [];
  const correctAnswersCount = selectedAnswers.filter((answer) => answer.isCorrect).length;
  const jokerAnswersCount = selectedAnswers.filter((answer) => answer.jokerApplied).length;
  const savedAtLabel = selectedGame?.savedAtMs ? new Date(selectedGame.savedAtMs).toLocaleString("ar-SA") : "—";
  const winner = selectedPlayers[0] || null;
  const answersByArchiveQuestion = selectedQuestions.map((question, index) => {
    const rows = selectedAnswers.filter((answer) => answer.questionId === question.id || answer.questionId === question.questionId);
    return { question, questionNumber: question.order || index + 1, rows };
  });
  const answersWithoutQuestion = selectedAnswers.filter(
    (answer) => !selectedQuestions.some((question) => question.id === answer.questionId || question.questionId === answer.questionId)
  );

  function exportLastGameExcel() {
    if (!selectedGame?.players?.length) return;
    downloadExcelFile(`family-quiz-${selectedGame.savedAtMs || "history"}.xls`, [
      {
        name: "المراكز الثلاثة الأولى",
        headers: ["المركز", "الاسم المستعار", "الاسم الثلاثي", "رقم الجوال", "النقاط"],
        rows: (selectedGame.players || []).slice(0, 3).map((player) => [player.rank, player.name || "", player.fullName || "", player.phone || "", player.score || 0]),
      },
      {
        name: "بيانات المتسابقين",
        headers: ["المركز", "الاسم المستعار", "الاسم الثلاثي", "رقم الجوال", "النقاط"],
        rows: (selectedGame.players || []).map((player) => [player.rank, player.name || "", player.fullName || "", player.phone || "", player.score || 0]),
      },
      {
        name: "تفاصيل الأسئلة",
        headers: ["رقم السؤال", "السؤال", "النوع", "النقاط الكبرى", "النقاط الصغرى", "وقت السؤال", "ثواني ظهور الأجوبة", "الإجابة الصحيحة", "الخيارات"],
        rows: (selectedGame.questions || []).map((question) => [
          question.order,
          question.text || "",
          getQuestionTypeLabel(question.type),
          question.maxPoints || 0,
          question.minPoints || 0,
          question.seconds || 0,
          question.answerRevealDelaySeconds || 0,
          (question.options || [])[question.correctIndex] || question.correctIndex,
          (question.options || []).join(" | "),
        ]),
      },
      {
        name: "تفاصيل الإجابات",
        headers: ["الاسم المستعار", "السؤال", "الإجابة", "النتيجة", "النقاط", "جوكر"],
        rows: (selectedGame.answers || []).map((answer) => {
          const question = (selectedGame.questions || []).find((item) => item.id === answer.questionId || item.questionId === answer.questionId);
          const player = (selectedGame.players || []).find((item) => item.id === answer.playerId);
          return [
            player?.name || answer.playerName || "",
            question?.text || answer.questionId || "",
            answer.selectedIndex ?? "",
            answer.isCorrect ? "صح" : "خطأ",
            answer.points || 0,
            answer.jokerApplied ? "نعم" : "لا",
          ];
        }),
      },
    ]);
  }

  async function deleteArchivedGame(gameId) {
    if (!gameId || !window.confirm("حذف هذه المسابقة من الأرشيف؟")) return;
    const nextHistory = gameHistory.filter((game) => game.id !== gameId);
    await setDoc(doc(db, "rooms", ROOM_ID), { gameHistory: nextHistory }, { merge: true });
    if (selectedGameId === gameId) setSelectedGameId(null);
  }

  async function renameArchivedGame(game) {
    const title = window.prompt("اكتب عنوان المسابقة", game.title || new Date(game.savedAtMs || 0).toLocaleString("ar-SA"))?.trim();
    if (!title) return;
    const nextHistory = gameHistory.map((item) => item.id === game.id ? { ...item, title } : item);
    await setDoc(doc(db, "rooms", ROOM_ID), { gameHistory: nextHistory }, { merge: true });
  }

  function toggleArchiveSection(sectionId) {
    setExpandedArchiveSections((current) => ({ ...current, [sectionId]: !current[sectionId] }));
  }

  function renderArchiveSection(sectionId, title, content, className = "") {
    const expanded = !!expandedArchiveSections[sectionId];
    return (
      <section className={`archive-detail-section ${className}`}>
        <button type="button" className="archive-section-toggle" onClick={() => toggleArchiveSection(sectionId)} aria-expanded={expanded}>
          <h3>{title}</h3>
          <span>{expanded ? "−" : "+"}</span>
        </button>
        {expanded && <div className="archive-section-body">{content}</div>}
      </section>
    );
  }

  return (
    <div className={embedded ? "control-page embedded-admin-panel" : "control-page"}>
      {!embedded && <div className="admin-toolbar card">
        <a className="link-button" href={`/?admin=${ADMIN_CODE}&view=control`}>لوحة التحكم</a>
        <button onClick={exportLastGameExcel} disabled={!selectedGame?.players?.length}>استخراج Excel</button>
      </div>}
      {embedded && (
        <div className="embedded-panel-heading">
          <div>
            <span>الأرشيف</span>
            <h2>سجل المسابقات</h2>
          </div>
          <button onClick={exportLastGameExcel} disabled={!selectedGame?.players?.length}>استخراج Excel</button>
        </div>
      )}
      <div className="archive-browser-layout">
        <aside className="card archive-history-panel">
          <div className="archive-history-title">
            <strong>المسابقات المحفوظة</strong>
            <span>{gameHistory.length}</span>
          </div>
          {gameHistory.length === 0 ? (
            <p className="muted">لا توجد مسابقات محفوظة حتى الآن.</p>
          ) : (
            <div className="history-list">
              {gameHistory.map((game) => (
                <div className={game.id === selectedGame?.id ? "history-item active" : "history-item"} key={game.id}>
                  <button type="button" className="history-open-button" onClick={() => setSelectedGameId(game.id)}>
                    <strong>{game.title || new Date(game.savedAtMs || 0).toLocaleString("ar-SA")}</strong>
                    <span className="history-meta-table">
                      <i>التاريخ</i><b>{new Date(game.savedAtMs || 0).toLocaleString("ar-SA")}</b>
                      <i>المتسابقون</i><b>{game.players?.length || 0}</b>
                    </span>
                  </button>
                  <button type="button" className="icon-action-button" title="تعديل عنوان المسابقة" aria-label="تعديل عنوان المسابقة" onClick={() => renameArchivedGame(game)}>✎</button>
                  <button type="button" className="danger icon-action-button" title="حذف المسابقة" aria-label="حذف المسابقة" onClick={() => deleteArchivedGame(game.id)}>×</button>
                </div>
              ))}
            </div>
          )}
        </aside>
      <details className="card archive-collapsible-card archive-selected-details" open>
        <summary>تفاصيل المسابقة المحددة</summary>
        {!selectedGame?.players?.length ? (
          <p className="muted">لا توجد مسابقات محفوظة حتى الآن.</p>
        ) : (
          <div className="archive-details-layout">
            {renderArchiveSection("overview", "ملخص المسابقة", <div className="archive-overview-box">
              <div className="archive-title-card">
                <span>العنوان</span>
                <strong>{selectedGame.title || savedAtLabel}</strong>
              </div>
              <table className="archive-mini-table">
                <tbody>
                  <tr><th>تاريخ الحفظ</th><td>{savedAtLabel}</td><th>الفائز</th><td>{winner ? `${winner.name} - ${winner.score || 0} نقطة` : "—"}</td></tr>
                  <tr><th>المتسابقون</th><td>{selectedPlayers.length}</td><th>الأسئلة</th><td>{selectedQuestions.length}</td></tr>
                  <tr><th>الإجابات</th><td>{selectedAnswers.length}</td><th>الصحيحة</th><td>{correctAnswersCount}</td></tr>
                  <tr><th>استخدام الجوكر</th><td>{jokerAnswersCount}</td><th>الرسائل</th><td>{selectedMessages.length}</td></tr>
                </tbody>
              </table>
            </div>, "archive-overview-section")}

            {renderArchiveSection("rankings", "ترتيب المتسابقين", <div className="archive-table-wrap">
            <table className="admin-bordered-table archive-table">
              <thead><tr><th>المركز</th><th>الاسم المستعار</th><th>الاسم الثلاثي</th><th>رقم الجوال</th><th>النقاط</th></tr></thead>
              <tbody>
                {selectedPlayers.map((player) => (
                  <tr key={`${player.id}-${player.rank}`}>
                    <td>{player.rank}</td><td>{player.name}</td><td>{player.fullName || "—"}</td><td>{player.phone || "—"}</td><td>{player.score || 0}</td>
                  </tr>
                ))}
              </tbody>
            </table>
              </div>, "archive-first-section")}

            {renderArchiveSection("questions", "تفاصيل الأسئلة", <div className="archive-question-list compact">
              {selectedQuestions.map((question, index) => (
                <details className="archive-question-row" key={question.id || question.order || index}>
                  <summary>
                    <span>س{question.order || index + 1}</span>
                    <strong>{question.text || "—"}</strong>
                    <small>{getQuestionTypeLabel(question.type)}</small>
                    <small>{question.minPoints || 0}-{question.maxPoints || 0} نقطة</small>
                    <small>{question.seconds || 0} ث</small>
                  </summary>
                  <div className="archive-question-row-body">
                    <table className="archive-mini-table compact">
                      <tbody>
                        <tr><th>الإجابة الصحيحة</th><td>{(question.options || [])[question.correctIndex] || "—"}</td><th>ظهور الخيارات</th><td>{question.answerRevealDelaySeconds || 0} ثانية</td></tr>
                      </tbody>
                    </table>
                    <div className="archive-options-grid compact">
                      {(question.options || []).map((option, optionIndex) => (
                        <span className={optionIndex === Number(question.correctIndex || 0) ? "correct" : ""} key={`${question.id || index}-${optionIndex}`}>
                          {getOptionText(option)}
                        </span>
                      ))}
                    </div>
                  </div>
                </details>
              ))}
              </div>)}

            {renderArchiveSection("answers", "إجابات المتسابقين", <div className="archive-answer-groups">
              {answersByArchiveQuestion.map(({ question, questionNumber, rows }) => (
                <details className="archive-answer-group" key={question.id || questionNumber} open={rows.length > 0}>
                  <summary>
                    <strong>{questionNumber}. {question.text || "—"}</strong>
                    <span>{rows.length} إجابة</span>
                  </summary>
                  {rows.length === 0 ? <p className="muted">لا توجد إجابات لهذا السؤال.</p> : (
                    <div className="archive-table-wrap">
                      <table className="admin-bordered-table archive-table compact">
                        <thead><tr><th>المتسابق</th><th>الإجابة</th><th>النتيجة</th><th>النقاط</th><th>جوكر</th></tr></thead>
                        <tbody>
                          {rows.map((answer, index) => {
                            const player = selectedPlayers.find((item) => item.id === answer.playerId);
                            return <tr key={answer.id || `${answer.playerId}-${question.id}-${index}`}><td>{player?.name || answer.playerName || "—"}</td><td>{(question.options || [])[answer.selectedIndex] ?? answer.selectedIndex ?? "—"}</td><td className={answer.isCorrect ? "archive-correct" : "archive-wrong"}>{answer.isCorrect ? "صح" : "خطأ"}</td><td>{answer.points || 0}</td><td>{answer.jokerApplied ? "\u{1F0CF}" : "—"}</td></tr>;
                          })}
                        </tbody>
                      </table>
                    </div>
                  )}
                </details>
              ))}
              {answersWithoutQuestion.length > 0 && (
                <details className="archive-answer-group">
                  <summary><strong>إجابات غير مرتبطة بسؤال محفوظ</strong><span>{answersWithoutQuestion.length} إجابة</span></summary>
                  <div className="archive-table-wrap">
                    <table className="admin-bordered-table archive-table compact">
                      <thead><tr><th>المتسابق</th><th>السؤال</th><th>الإجابة</th><th>النتيجة</th><th>النقاط</th></tr></thead>
                      <tbody>{answersWithoutQuestion.map((answer, index) => {
                        const player = selectedPlayers.find((item) => item.id === answer.playerId);
                        return <tr key={answer.id || `${answer.playerId}-${answer.questionId}-${index}`}><td>{player?.name || answer.playerName || "—"}</td><td>{answer.questionId || "—"}</td><td>{answer.selectedIndex ?? "—"}</td><td className={answer.isCorrect ? "archive-correct" : "archive-wrong"}>{answer.isCorrect ? "صح" : "خطأ"}</td><td>{answer.points || 0}</td></tr>;
                      })}</tbody>
                    </table>
                  </div>
                </details>
              )}
              </div>)}

            {renderArchiveSection("messages", "رسائل المتسابقين", selectedMessages.length === 0 ? <p className="muted">لا توجد رسائل محفوظة في هذه المسابقة.</p> : <div className="archive-table-wrap"><table className="admin-bordered-table archive-table"><thead><tr><th>المتسابق</th><th>الرسالة</th><th>الوقت</th></tr></thead><tbody>{selectedMessages.map((message, index) => <tr key={`${message.createdAtMs || 0}-${index}`}><td>{message.playerName || "—"}</td><td>{message.text || "—"}</td><td>{message.createdAtMs ? new Date(message.createdAtMs).toLocaleString("ar-SA") : "—"}</td></tr>)}</tbody></table></div>)}
          </div>
        )}
      </details>
      </div>
    </div>
  );
}

function AdminPanel({ initialView = "control" }) {
  const room = useRoom();
  const players = usePlayers();
  const questions = useQuestions(room?.activePackageId || DEFAULT_PACKAGE_ID);
  const allQuestions = useAllQuestions();
  const questionPackages = useQuestionPackages();
  const messages = useMessages();
  const answers = useAnswers(room?.currentQuestion?.questionId);
  const allAnswers = useAllAnswers();
  const visitors = useVisitors();
  const gameHistory = [...(room?.gameHistory || [])].sort(
    (a, b) => Number(b.savedAtMs || 0) - Number(a.savedAtMs || 0)
  );

  // FIX: Automation components are mounted here (on the admin/control side) so that
  // AutoProcessResults runs even when the display page (?view=display) is not open.
  // Previously these only ran inside DisplayScreen, causing the "stuck on تجميع النتائج"
  // bug whenever the display tab was closed or not opened.
  // In display mode they will also be rendered inside DisplayScreen (duplicate mount is
  // harmless because each instance uses its own processingQuestionId state guard).
  const alwaysOnAutomations = (
    <>
      <AutoRevealCorrectAnswer room={room} />
      <AutoLockJokers room={room} players={players} />
      <AutoProcessResults room={room} answers={answers} players={players} />
    </>
  );

  if (initialView === "settings") {
    return (
      <>
        {alwaysOnAutomations}
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

        <QuestionSettings questions={questions} room={room} questionPackages={questionPackages} allQuestions={allQuestions} />
      </>
    );
  }

  if (initialView === "lastgame") {
    return (
      <>
        {alwaysOnAutomations}
        <LastGamePanel room={room} gameHistory={gameHistory} />
      </>
    );
  }

  if (initialView === "display") {
    // Display page renders its own set of automation components internally.
    return (
      <DisplayScreen
        room={room}
        players={players}
        questions={questions}
        allQuestions={allQuestions}
        messages={messages}
        answers={answers}
        allAnswers={allAnswers}
      />
    );
  }

  if (!room) {
    return (
      <>
        {alwaysOnAutomations}
        <div className="card center-card">
          <h2>تهيئة المسابقة</h2>
          <p className="muted">اضغط الزر لإنشاء غرفة المسابقة لأول مرة.</p>
          <button onClick={createOrResetRoom}>إنشاء المسابقة</button>
        </div>
      </>
    );
  }

  return (
    <>
      {alwaysOnAutomations}
      <AdminControl
        room={room}
        players={players}
        questions={questions}
        questionPackages={questionPackages}
        allAnswers={allAnswers}
        messages={messages}
        gameHistory={gameHistory}
        visitors={visitors}
      />
    </>
  );
}

/* Player */

function PlayerTopBar({ player, rank = null }) {
  if (!player?.name) return null;
  return (
    <div className="card player-identity-bar">
      <strong>{player.emoji || "👤"} {player.name}</strong>
      {rank ? <span className="player-rank-chip">#{rank}</span> : null}
    </div>
  );
}

function JoinForm({ onJoined, room }) {
  const [nickname, setNickname] = useState("");
  const [emoji, setEmoji] = useState("");
  const [fullName, setFullName] = useState("");
  const [phone, setPhone] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const nicknameInputRef = useRef(null);

  useEffect(() => {
    nicknameInputRef.current?.focus();
  }, []);

  async function join() {
    const cleanNickname = nickname.trim();
    const cleanFullName = fullName.trim();
    const cleanPhone = normalizePhoneDigits(phone);

    if (!cleanNickname || !cleanFullName || !cleanPhone || loading) return;

    if (!isValidSaudiMobile(cleanPhone)) {
      setError("رقم الجوال يجب أن يكون 10 أرقام.");
      return;
    }

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

      const duplicatePhoneQuery = query(
        collection(db, "rooms", ROOM_ID, "players"),
        where("phone", "==", cleanPhone)
      );
      const duplicatePhoneSnap = await getDocs(duplicatePhoneQuery);

      if (!duplicatePhoneSnap.empty) {
        setError("رقم الجوال مسجل بالفعل. استخدم رقمًا آخر أو تواصل مع المقدم.");
        setLoading(false);
        return;
      }

      const playerRef = await addDoc(collection(db, "rooms", ROOM_ID, "players"), {
        name: cleanNickname,
        emoji: emoji.trim(),
        fullName: cleanFullName,
        phone: cleanPhone,
        score: 0,
        answeredCount: 0,
      pendingJoker: false,
      jokerUsed: false,
      jokerQuestionId: null,
      jokerQuestionNumber: null,
      practicePendingJoker: false,
      practiceJokerQuestionId: null,
      practiceJokerTiming: null,
      practiceJokerMultiplier: null,
      joinedAt: serverTimestamp(),
      });

      localStorage.setItem("familyQuizPlayerId", playerRef.id);
      localStorage.setItem("familyQuizPlayerName", cleanNickname);
      localStorage.setItem("familyQuizPlayerEmoji", emoji.trim());
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

      <div className="nickname-emoji-row">
        <select
          className="emoji-input"
          value={emoji}
          onChange={(event) => setEmoji(event.target.value)}
          aria-label="إيموجي اختياري"
        >
          <option value="">👤</option>
          {PLAYER_EMOJIS.map((item) => (
            <option key={item} value={item}>{item}</option>
          ))}
        </select>
        <input
          ref={nicknameInputRef}
          value={nickname}
          onChange={(event) => setNickname(event.target.value)}
          placeholder="الاسم المستعار"
        />
      </div>

      <div className="registration-contact-box">
        <h3>بيانات التواصل</h3>
        <input
          value={fullName}
          onChange={(event) => setFullName(event.target.value)}
          placeholder="الاسم الثلاثي"
        />

        <input
          value={phone}
          onChange={(event) => setPhone(event.target.value)}
          onKeyDown={(event) => event.key === "Enter" && join()}
          placeholder="رقم الجوال"
          inputMode="tel"
          style={{ direction: "ltr", textAlign: "right" }}
        />
      </div>

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
  const [newEmoji, setNewEmoji] = useState(player?.emoji || "");
  const [newFullName, setNewFullName] = useState(player?.fullName || "");
  const [newPhone, setNewPhone] = useState(player?.phone || "");
  const [editError, setEditError] = useState("");

  const rank = players.findIndex((p) => p.id === player?.id) + 1;

  useEffect(() => {
    setNewNickname(player?.name || "");
    setNewEmoji(player?.emoji || "");
    setNewFullName(player?.fullName || "");
    setNewPhone(player?.phone || "");
  }, [player?.name, player?.emoji, player?.fullName, player?.phone]);

  async function savePlayerInfo() {
    const cleanNickname = newNickname.trim();
    const cleanFullName = newFullName.trim();
    const cleanPhone = normalizePhoneDigits(newPhone);

    if (!cleanNickname || !cleanFullName || !cleanPhone || !player?.id) {
      setEditError("عبّئ البيانات الثلاثة.");
      return;
    }

    if (!isValidSaudiMobile(cleanPhone)) {
      setEditError("رقم الجوال يجب أن يكون 10 أرقام.");
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
      emoji: newEmoji,
      fullName: cleanFullName,
      phone: cleanPhone,
    });

    localStorage.setItem("familyQuizPlayerName", cleanNickname);
    localStorage.setItem("familyQuizPlayerEmoji", newEmoji);
    localStorage.setItem("familyQuizPlayerFullName", cleanFullName);
    localStorage.setItem("familyQuizPlayerPhone", cleanPhone);
    setPlayerName(cleanNickname);
    setEditError("");
    setEditingInfo(false);
  }

  let title = "تم التسجيل بنجاح";
  let text = "انتظر حتى يتم إرسال السؤال من المقدم.";

  if (stage === "home") {
    title = "بانتظار فتح التسجيل";
    text = "عندما يفتح المقدم التسجيل، يمكنك الدخول للمسابقة من جديد.";
  }

  if (stage === "registration") {
    title = "تم تسجيلك";
    text = "بانتظار عرض طريقة المسابقة من المقدم.";
  }

  if (stage === "practiceComplete") {
    title = "انتهت التجربة";
    text = "استعد لبدء المسابقة الفعلية.";
  }

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
                <select
                  className="emoji-input"
                  value={newEmoji}
                  onChange={(e) => setNewEmoji(e.target.value)}
                  aria-label="تعديل الإيموجي"
                >
                  <option value="">👤</option>
                  {PLAYER_EMOJIS.map((item) => (
                    <option key={item} value={item}>{item}</option>
                  ))}
                </select>
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

        {(((stage === "registration" || stage === "practiceComplete") && room?.practiceFinished) || (stage === "results" && hasNextQuestion)) && (
          <JokerControl player={player} stage={stage} />
        )}

        {(stage !== "registration" || room?.practiceFinished) && <div className="score-box total-score-box">
          <span>نقاطك الحالية</span>
          <strong><AnimatedNumber value={player?.score || 0} /></strong>
        </div>}
      </div>

      <PlayerChat playerId={player.id} playerName={player.name} />
    </div>
  );
}

function PlayerResultSummary({ player, lastAnswer, stage, hasNextQuestion = false, currentQuestion = null, currentQuestionIndex = 0, room = null }) {
  const points = lastAnswer?.points || 0;
  const basePoints = lastAnswer?.basePoints || 0;
  const isCorrect = !!lastAnswer?.isCorrect;
  const jokerApplied = !!lastAnswer?.jokerApplied;
  const jokerMultiplier = Number(lastAnswer?.jokerMultiplier || 3);
  const isResults = stage === "results";
  const showBetweenQuestionJoker =
    stage === "results" &&
    hasNextQuestion &&
    (!currentQuestion?.isPractice || currentQuestionIndex === 0);

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
            <span className="points-question-label">نقاط هذا السؤال</span>
            <strong className="points-question-value">
              {jokerApplied ? "\u{1F0CF} " : ""}
              {points > 0 ? "+" : ""}
              <AnimatedNumber value={points} /> نقطة
            </strong>
            {jokerApplied && isCorrect && (
              <small className="points-question-sub">
                <span>النقاط الأصلية</span>
                <b>{basePoints}</b>
                <i>{getJokerTimingLabel(jokerMultiplier)}</i>
              </small>
            )}
            {jokerApplied && !isCorrect && (
              <small className="points-question-sub">
                <span>الجوكر</span>
                <b>خصم</b>
                <i>قيمة السؤال</i>
              </small>
            )}
          </div>
        ) : (
          <p className="muted">سيتم حساب نقاطك عند إظهار النتائج.</p>
        )}

        <div className="score-box total-score-box">
          <span>مجموع نقاطك</span>
          <strong><AnimatedNumber value={player?.score || 0} /></strong>
        </div>

        {showBetweenQuestionJoker && (
          <div className="between-question-joker-wrap">
            {currentQuestion?.isPractice && currentQuestionIndex === 0 && (
              <PracticeJokerHint room={room} player={player} inline />
            )}
            <JokerControl player={player} stage={stage} room={{ ...(room || {}), practiceMode: !!currentQuestion?.isPractice }} />
          </div>
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
    <div className={isWinner ? "main-column winner-celebration-page" : "main-column"}>
      <div className={isWinner ? "waiting-card card player-final-winner-card" : "waiting-card card"} style={{ textAlign: "center" }}>
        {isWinner && <FallingConfetti />}
        <div className="big-icon">{isWinner ? "\u{1F3C6}" : "\u{1F389}"}</div>
        <h2 className={isWinner ? "winner-final-title" : ""}>{isWinner ? `مبروك! فزت بالمركز ${rank}` : "حظ أوفر"}</h2>
        {!isWinner && <p className="muted">ترتيبك النهائي: {rank || "—"}</p>}
        <div className="score-box">
          <span>نقاطك النهائية</span>
          <strong><AnimatedNumber value={player?.score || 0} /></strong>
        </div>
      </div>

      <PlayerChat playerId={player.id} playerName={player.name} />
    </div>
  );
}

function PlayerReadyScreen({ seconds }) {
  return (
    <div className="main-column">
      <div className="waiting-card card player-ready-screen">
        <strong className="player-ready-countdown">{seconds > 0 ? seconds : "..."}</strong>
        <h2>استعد للسؤال التالي</h2>
      </div>
    </div>
  );
}

function PracticeJokerHint({ room, player, inline = false }) {
  const stage = room?.stage;
  const currentQuestion = room?.currentQuestion;
  const index = room?.currentQuestionIndex ?? -1;
  const isPractice = !!room?.practiceMode || !!currentQuestion?.isPractice;
  const questionId = currentQuestion?.questionId;
  const alreadyUsedForQuestion = questionId && player?.practiceJokerQuestionId === questionId;
  const showBeforeSecond =
    isPractice &&
    stage === "results" &&
    index === 0 &&
    !player?.practicePendingJoker &&
    !player?.practiceJokerQuestionId;
  const showDuringThird =
    isPractice &&
    stage === "question" &&
    index === 2 &&
    !alreadyUsedForQuestion;

  if (!showBeforeSecond && !showDuringThird) return null;

  return (
    <div className={inline ? "try-joker-nudge" : showDuringThird ? "try-joker-layer fixed-try-joker-layer during" : "try-joker-layer fixed-try-joker-layer before"}>
      <span>{inline ? "!" : "↥"}</span>
      <div>
        <strong>جرّب الجوكر</strong>
        <small>{showDuringThird ? "اضغط زر الجوكر أثناء السؤال" : "فعّله الآن قبل السؤال القادم"}</small>
      </div>
    </div>
  );
}


function PlayerHealthCheck({ room, player }) {
  const check = room?.healthCheck;
  const [answered, setAnswered] = useState(() =>
    localStorage.getItem("familyQuizLastHealthCheck") === check?.id
  );
  const [guestId, setGuestId] = useState(() => localStorage.getItem("familyQuizGuestId") || "");

  useEffect(() => {
    setAnswered(localStorage.getItem("familyQuizLastHealthCheck") === check?.id);
  }, [check?.id]);

  useEffect(() => {
    if (guestId) return;
    const created = `guest-${getNow()}-${Math.random().toString(16).slice(2)}`;
    localStorage.setItem("familyQuizGuestId", created);
    setGuestId(created);
  }, [guestId]);

  const responderId = player?.id || guestId;
  const responderName = player?.name || "زائر";

  if (!check?.active || !responderId || answered) return null;

  async function submitHealth(answerText) {
    await answerSystemCheck({
      playerId: responderId,
      playerName: responderName,
      answerText,
    });
    localStorage.setItem("familyQuizLastHealthCheck", check.id);
    setAnswered(true);
  }

  return (
    <div className="player-health-popover" role="dialog" aria-live="polite">
      <strong>{check.kind === "instructions" ? (check.title || "تصويت") : (check.question || "استفتاء")}</strong>
      {check.kind === "instructions" && <span className="player-health-question">{check.question}</span>}
      <div className="health-choice-grid">
        <button type="button" className="health-choice-ok" onClick={() => submitHealth(check.okText || "كل شي تمام")}>{check.okText || "كل شي تمام"}</button>
        <button type="button" className="health-choice-problem" onClick={() => submitHealth(check.problemText || "في مشكلة")}>{check.problemText || "في مشكلة"}</button>
      </div>
    </div>
  );
}

function getLocalAnswerKey(playerId, questionId) {
  return `familyQuizAnswered:${ROOM_ID}:${playerId}:${questionId}`;
}

function readLocalAnswerLock(playerId, questionId) {
  if (!playerId || !questionId) return null;
  try {
    const raw = localStorage.getItem(getLocalAnswerKey(playerId, questionId));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return {
      selectedIndex: Number.isFinite(Number(parsed.selectedIndex)) ? Number(parsed.selectedIndex) : -1,
      answeredAt: Number(parsed.answeredAt || 0) || null,
    };
  } catch {
    return { selectedIndex: -1, answeredAt: null };
  }
}

function writeLocalAnswerLock(playerId, questionId, selectedIndex, answeredAt) {
  if (!playerId || !questionId) return;
  try {
    localStorage.setItem(
      getLocalAnswerKey(playerId, questionId),
      JSON.stringify({ selectedIndex, answeredAt })
    );
  } catch {
    // Local answer locks are only a temporary UX guard; Firebase remains the source of truth.
  }
}

function PlayerPanel() {
  const room = useRoom();
  const players = usePlayers();
  const questions = useQuestions(room?.activePackageId || DEFAULT_PACKAGE_ID);
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
  const localAnswerLock = readLocalAnswerLock(playerId, currentQuestion?.questionId);
  const playerRank = players.findIndex((item) => item.id === playerId) + 1;
  const lastAnswerId = lastAnswer?.id;
  const lastAnswerIsCorrect = lastAnswer?.isCorrect;
  const playerNow = useNow(250);
  const readySeconds = Math.max(0, Math.ceil((Number(room?.nextQuestionReadyUntilMs || 0) - playerNow) / 1000));
  const isWaitingForReadyQuestion =
    stage === "ready" ||
    Number(room?.nextQuestionReadyQuestionIndex ?? -1) > currentQuestionIndex &&
    (stage === "instructions" || stage === "registration" || stage === "practiceComplete" || stage === "reveal" || stage === "results");

  useEffect(() => {
    const visitorId = getOrCreateVisitorId();

    async function markVisitorSeen() {
      try {
        await setDoc(
          doc(db, "rooms", ROOM_ID, "players", visitorId),
          {
            isVisitorOnly: true,
            seenAtMs: Date.now(),
            seenAt: serverTimestamp(),
            playerId: player?.id || null,
            playerName: player?.name || playerName || "",
            registered: !!player?.id,
          },
          { merge: true }
        );
      } catch {
        // Visitor count is helpful for the presenter, but should never block the player page.
      }
    }

    markVisitorSeen();
    const interval = setInterval(markVisitorSeen, 20000);
    return () => clearInterval(interval);
  }, [player?.id, player?.name, playerName]);

  useEffect(() => {
    if (stage === "question" && currentQuestion?.questionId && typeof navigator !== "undefined") {
      vibrateDevice(200);
    }
  }, [stage, currentQuestion?.questionId]);

  useEffect(() => {
    if (Number(room?.nextQuestionReadyUntilMs || 0) > Date.now()) vibrateDevice([80, 55, 80]);
  }, [room?.nextQuestionReadyUntilMs]);

  useEffect(() => {
    if (stage === "results" && lastAnswerId) {
      vibrateDevice(lastAnswerIsCorrect ? [80, 45, 140] : [170, 70, 170]);
    }
  }, [stage, lastAnswerId, lastAnswerIsCorrect]);

  useEffect(() => {
    const finalRank = players.findIndex((item) => item.id === playerId) + 1;
    if (stage === "finished" && finalRank >= 1 && finalRank <= 3) {
      vibrateDevice([120, 70, 120, 70, 190]);
    }
  }, [stage, playerId, players]);

  useEffect(() => {
    const localLock = readLocalAnswerLock(playerId, currentQuestion?.questionId);
    setSelectedIndex(null);
    setAnswerMessage("");
    setFrozenProgressPercent(null);
    if (localLock && currentQuestion?.questionId) {
      setSelectedIndex(localLock.selectedIndex);
      setAnswerMessage("تم إرسال إجابتك");
      setAnsweredQuestionId(currentQuestion.questionId);
    } else {
      setAnsweredQuestionId(null);
    }
  }, [currentQuestion?.questionId, playerId]);


  async function submitAnswer(index) {
    if (!playerId || !playerName || !currentQuestion || !player) return;
    if (answeredQuestionId === currentQuestion.questionId) return;
    if (readLocalAnswerLock(playerId, currentQuestion.questionId)) return;
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
      currentQuestion.isPractice
        ? player.practiceJokerQuestionId === currentQuestion.questionId
        : !!player.jokerUsed && player.jokerQuestionId === currentQuestion.questionId;
    const jokerMultiplier = getJokerMultiplier(player, currentQuestion);
    const jokerTiming = jokerApplied
      ? currentQuestion.isPractice
        ? player.practiceJokerTiming || (Number(jokerMultiplier) === 2 ? "during" : "before")
        : (Number(jokerMultiplier) === 2 ? "during" : "before")
      : null;

    const points = calculateFinalPoints({
      isCorrect,
      basePoints,
      jokerApplied,
      jokerMultiplier,
    });

    setSelectedIndex(index);
    setFrozenProgressPercent(frozenPercent);
    setAnsweredQuestionId(currentQuestion.questionId);
    setAnswerMessage("تم إرسال إجابتك");
    writeLocalAnswerLock(playerId, currentQuestion.questionId, index, answeredAt);
    vibrateDevice(65);

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
      jokerMultiplier: jokerApplied ? jokerMultiplier : null,
      jokerTiming,
      isPractice: !!currentQuestion.isPractice,
      points,
      answeredAt,
      createdAt: serverTimestamp(),
    });
  }

  if (stage === "home") {
    return (
      <div className="join-card card">
        <h2>بانتظار فتح التسجيل</h2>
        <p className="muted">عندما يفتح المقدم التسجيل، سيظهر لك نموذج الدخول هنا.</p>
      </div>
    );
  }

  if ((readySeconds > 0 || isWaitingForReadyQuestion) && player) {
    return (
      <>
        <PlayerTopBar player={player} rank={playerRank || null} />
        <PlayerHealthCheck room={room} player={player} />
        <PlayerReadyScreen seconds={readySeconds} />
      </>
    );
  }

  if (stage === "instructions") {
    return (
      <>
        {player && <PlayerTopBar player={player} rank={playerRank || null} />}
        <PlayerHealthCheck room={room} player={player || { id: localStorage.getItem("familyQuizGuestId") || "", name: "زائر" }} />
        <InstructionsPage />
        {player && room?.practiceFinished && (
          <div className="main-column">
            <div className="waiting-card card post-practice-joker-card">
              <strong>المسابقة الفعلية بتبدأ بعد قليل</strong>
              <JokerControl player={player} stage="registration" />
              <div className="score-box total-score-box">
                <span>نقاطك الحالية</span>
                <strong><AnimatedNumber value={player?.score || 0} /></strong>
              </div>
            </div>
          </div>
        )}
      </>
    );
  }

  if (!playerId || !player) {
    return (
      stage === "registration" ? (
        <>
          <PlayerHealthCheck room={room} player={null} />
          <JoinForm
            room={room}
            onJoined={(id, name) => {
              setPlayerId(id);
              setPlayerName(name);
            }}
          />
        </>
      ) : (
        <div className="join-card card">
          <h2>التسجيل مغلق</h2>
          <p className="muted">بانتظار المقدم للخطوة التالية.</p>
        </div>
      )
    );
  }

  if (stage === "finished") {
    return (
      <>
        <PlayerTopBar player={player} rank={playerRank || null} />
        <PlayerHealthCheck room={room} player={player} />
        <PlayerFinalScreen player={player} players={players} />
      </>
    );
  }

  if (readySeconds > 0 || isWaitingForReadyQuestion) {
    return (
      <>
        <PlayerTopBar player={player} rank={playerRank || null} />
        <PlayerHealthCheck room={room} player={player} />
        <PlayerReadyScreen seconds={readySeconds} />
      </>
    );
  }

  if ((stage === "reveal" || stage === "results") && currentQuestion) {
    return (
      <>
        <PlayerTopBar player={player} rank={playerRank || null} />
        <PlayerHealthCheck room={room} player={player} />
        <PlayerResultSummary
        player={player}
        lastAnswer={lastAnswer}
        stage={stage}
        hasNextQuestion={hasNextQuestion}
        currentQuestion={currentQuestion}
        currentQuestionIndex={currentQuestionIndex}
        room={room}
      />
      </>
    );
  }

  if (stage !== "question" || !currentQuestion) {
    return (
      <>
        <PlayerTopBar player={player} rank={playerRank || null} />
        <PlayerHealthCheck room={room} player={player} />
        <PracticeJokerHint room={room} player={player} />
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
      <PlayerTopBar player={player} rank={playerRank || null} />
      <PlayerHealthCheck room={room} player={player} />
      <div className="main-column">
        <QuestionScreen
        question={currentQuestion}
        room={room}
        onAnswer={submitAnswer}
        selectedIndex={selectedIndex ?? lastAnswer?.selectedIndex ?? localAnswerLock?.selectedIndex ?? null}
        answerMessage={answerMessage || (lastAnswer || localAnswerLock ? "تم إرسال إجابتك" : "")}
        frozenProgressPercent={frozenProgressPercent ?? (lastAnswer ? getPointsProgressPercent(currentQuestion, room, lastAnswer.answeredAt) : localAnswerLock?.answeredAt ? getPointsProgressPercent(currentQuestion, room, localAnswerLock.answeredAt) : null)}
        currentPlayer={player}
      />

        <PlayerChat playerId={playerId} playerName={player?.name || playerName} />
      </div>
    </>
  );
}

/* App */

function AppCredit() {
  return <div className="app-credit">قام ببرمجة المسابقة: علي إبراهيم ال مطرود</div>;
}

export default function App() {
  const searchParams = new URLSearchParams(window.location.search);
  const isAdmin = searchParams.get("admin") === ADMIN_CODE;
  const viewParam = searchParams.get("view");

  const adminView =
    viewParam === "settings" || viewParam === "display" || viewParam === "control" || viewParam === "lastgame"
      ? viewParam
      : "control";

  if (isAdmin && adminView === "display") {
    return (
      <div className="display-app" dir="rtl">
        <AdminPanel initialView="display" />
        <AppCredit />
      </div>
    );
  }

  return (
    <div className="app" dir="rtl">
      {!isAdmin && <header className="app-header">
        <div>
          <h1>{QUIZ_TITLE}</h1>
          <p>{QUIZ_SUBTITLE}</p>
        </div>

        {isAdmin ? (
          <span className="admin-badge">
            {adminView === "settings" ? "صفحة الإعداد" : "لوحة التحكم"}
          </span>
        ) : null}
      </header>}

      {isAdmin ? <AdminPanel initialView={adminView} /> : <PlayerPanel />}
      <AppCredit />
    </div>
  );
}
