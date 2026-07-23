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
  getDoc,
  getDocs,
  query,
  where,
  serverTimestamp,
  deleteDoc,
  arrayUnion,
  runTransaction,
  writeBatch,
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
const LOCAL_ADMIN_DEV_BYPASS = import.meta.env.DEV === true;

const QUIZ_TITLE = "مسابقة قروب العائلة العائلية";
const QUIZ_SUBTITLE = "من تقديم الأستاذ إبراهيم ال مطرود";
const GROUP_NAME_IMAGE_SRC = "/Group_name.png";


const REVEAL_OPTIONS_DELAY_MS = 3000;
const MEDIA_REVEAL_OPTIONS_DELAY_MS = 5000;
const QUESTION_START_SYNC_BUFFER_MS = 300;
const RESULTS_PROCESSING_STALE_MS = 9000;
const RESULTS_LEADERBOARD_LIMIT = 15;
const DEFAULT_PACKAGE_ID = "default";
const DEFAULT_PACKAGE_NAME = "المسابقة الحالية";
const DEFAULT_PRIZE_ITEMS = [
  { id: "prize-100-a", title: "100 ريال" },
  { id: "prize-100-b", title: "100 ريال" },
  { id: "prize-phone", title: "جوال" },
];
const DEFAULT_QUESTION_CATEGORY = "عام";

function getNow() {
  return Date.now();
}

function getRandomIndex(length) {
  if (length <= 0) return 0;
  return Math.floor(Math.random() * length);
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

function isSameId(a, b) {
  return a != null && b != null && String(a) === String(b);
}

function isResultsProcessingStale(room, questionId) {
  if (!room?.processingQuestionId || !isSameId(room.processingQuestionId, questionId)) return false;
  const startedAt = Number(room.processingStartedAtMs || 0);
  return !startedAt || getNow() - startedAt > RESULTS_PROCESSING_STALE_MS;
}

function getAnswerStartMs(question = {}) {
  return Number(question.answerStartAtMs || question.answerRevealAtMs || question.questionStartedAtMs || question.sentAtMs || 0);
}

function formatAnswerTime(answer) {
  const seconds = Number(answer?.answerTimeSeconds);
  if (Number.isFinite(seconds) && seconds >= 0) return `${seconds.toFixed(seconds < 10 ? 1 : 0)} ث`;
  return "—";
}

function isValidPlayerAnswerForQuestion(answer, questionId) {
  if (!answer?.playerId || !questionId || !isSameId(answer.questionId, questionId)) return false;
  const selectedIndex = Number(answer.selectedIndex);
  return Number.isInteger(selectedIndex) && selectedIndex >= 0;
}

function vibrateDevice(pattern) {
  try {
    navigator.vibrate?.(pattern);
  } catch {
    // Some devices and browsers intentionally do not expose vibration.
  }
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

function getAdminStageLabel(stage) {
  const labels = {
    home: "الرئيسية",
    registration: "التسجيل",
    instructions: "التعليمات",
    ready: "استعداد",
    question: "سؤال مباشر",
    reveal: "كشف الإجابة",
    results: "النتائج",
    categoryVote: "تصويت التصنيف",
    practiceComplete: "انتهاء التجربة",
    prizeWheel: "سحب الجوائز",
    finalCountdown: "العد التنازلي",
    finished: "انتهت المسابقة",
  };
  return labels[stage] || stage || "غير محدد";
}

function getQuestionCategory(question) {
  return String(question?.category || DEFAULT_QUESTION_CATEGORY).trim() || DEFAULT_QUESTION_CATEGORY;
}

function isVotingQuestion(question) {
  return !!question?.voteEnabled && Array.isArray(question?.voteChoices) && question.voteChoices.length === 2;
}

function getQuestionDisplayText(question) {
  if (!isVotingQuestion(question)) return question?.text || "";
  return question.voteChoices.map((choice) => choice.category).filter(Boolean).join(" أو ");
}

function materializeVoteQuestion(question, category) {
  if (!isVotingQuestion(question)) return question;
  const choices = question.voteChoices;
  const selectedChoice = choices.find((choice) => choice.category === category) || choices[getRandomIndex(choices.length)];
  return {
    ...question,
    ...selectedChoice,
    id: question.id || question.questionId,
    questionId: question.id || question.questionId,
    voteRoundId: question.id || question.questionId,
    selectedVoteCategory: selectedChoice.category,
    voteEnabled: false,
    voteChoices: choices,
  };
}

function getSelectedAnswerText(question, answer) {
  if (!answer) return "—";
  const answeredQuestion = isVotingQuestion(question) && answer.voteCategory
    ? materializeVoteQuestion(question, answer.voteCategory)
    : question;
  return getOptionText(answeredQuestion?.options?.[answer.selectedIndex]) || "—";
}

function getCategoryVoteCounts(categoryVote = {}) {
  const options = Array.isArray(categoryVote.options) ? categoryVote.options : [];
  const counts = Object.fromEntries(options.map((option) => [option.label, 0]));
  Object.values(categoryVote.votes || {}).forEach((vote) => {
    const label = typeof vote === "string" ? vote : vote?.label;
    if (Object.prototype.hasOwnProperty.call(counts, label)) counts[label] += 1;
  });
  return counts;
}

function getCategoryVoteWinner(categoryVote = {}) {
  const options = Array.isArray(categoryVote.options) ? categoryVote.options : [];
  const counts = getCategoryVoteCounts(categoryVote);
  const ranked = [...options].sort((a, b) => (counts[b.label] || 0) - (counts[a.label] || 0));
  if (!ranked.length) return null;
  if (ranked.length > 1 && (counts[ranked[0].label] || 0) === (counts[ranked[1].label] || 0)) return null;
  return ranked[0].label;
}

function getCategoryVoteTieLabels(categoryVote = {}) {
  const options = Array.isArray(categoryVote.options) ? categoryVote.options : [];
  if (options.length < 2) return [];
  const counts = getCategoryVoteCounts(categoryVote);
  const highestCount = Math.max(...options.map((option) => Number(counts[option.label] || 0)));
  const leadingLabels = options
    .filter((option) => Number(counts[option.label] || 0) === highestCount)
    .map((option) => option.label);
  return leadingLabels.length > 1 ? leadingLabels : [];
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
  "\u{1F3C6}",
  "\u{1F947}",
  "\u{1F9E0}",
  "\u{26A1}",
  "\u{1F3B2}",
  "\u{1F381}",
  "\u{1F44F}",
  "\u{1F399}",
  "\u{1F4A1}",
  "\u{1F3AE}",
  "\u{1F98A}",
  "\u{1F981}",
];

function QuizTitleMark({ compact = false }) {
  return (
    <span className={compact ? "quiz-title-mark compact" : "quiz-title-mark"}>
      <span className="quiz-title-word">مسابقة</span>
      <img className="quiz-title-logo" src={GROUP_NAME_IMAGE_SRC} alt="قروب العائلة" />
      <span className="quiz-title-word">العائلية</span>
    </span>
  );
}

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

function RevealCountNumber({ value = 0, active = false, duration = 1050 }) {
  const [displayValue, setDisplayValue] = useState(0);

  useEffect(() => {
    const end = Number(value) || 0;
    if (!active) {
      setDisplayValue(0);
      return undefined;
    }

    const startedAt = performance.now();
    let frameId;

    function tick(now) {
      const progress = clamp((now - startedAt) / duration, 0, 1);
      const eased = 1 - Math.pow(1 - progress, 3);
      const nextValue = progress >= 1 ? end : Math.floor(end * eased);
      setDisplayValue(nextValue);
      if (progress < 1) frameId = requestAnimationFrame(tick);
    }

    setDisplayValue(0);
    frameId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frameId);
  }, [active, duration, value]);

  return <span className={active ? "reveal-count-number is-counting" : "reveal-count-number"}>{displayValue}</span>;
}

function useRevealProgressValue(value = 0, active = false, duration = 1050) {
  const [displayValue, setDisplayValue] = useState(0);

  useEffect(() => {
    const end = clamp(Number(value) || 0, 0, 100);
    if (!active) {
      setDisplayValue(0);
      return undefined;
    }

    const startedAt = performance.now();
    let frameId;

    function tick(now) {
      const progress = clamp((now - startedAt) / duration, 0, 1);
      const eased = 1 - Math.pow(1 - progress, 3);
      setDisplayValue(progress >= 1 ? end : end * eased);
      if (progress < 1) frameId = requestAnimationFrame(tick);
    }

    setDisplayValue(0);
    frameId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frameId);
  }, [active, duration, value]);

  return displayValue;
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
      activePackageId: DEFAULT_PACKAGE_ID,
      activePackageName: DEFAULT_PACKAGE_NAME,
      categoryVotingEnabled: false,
      categoryVote: null,
      usedQuestionIds: {},
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

async function returnToRegistrationKeepingPlayers() {
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
      processingQuestionId: null,
      processingStartedAtMs: null,
      resultsError: null,
      practiceMode: false,
      healthCheck: { active: false },
      "prizeWheel.spinning": false,
      categoryVote: null,
      testMode: {
        autoAnswerEnabled: false,
        slowResultsEnabled: false,
        slowResultsDelayMs: 15000,
      },
      updatedAt: serverTimestamp(),
    },
    { merge: true }
  );
}

async function setTemporaryRegistrationOpen(isOpen) {
  await setDoc(
    doc(db, "rooms", ROOM_ID),
    {
      registrationOverrideOpen: !!isOpen,
      registrationOverrideUpdatedAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    },
    { merge: true }
  );
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
      registrationOverrideOpen: false,
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
      registrationOverrideOpen: false,
      practiceFinished: false,
      categoryVote: null,
      usedQuestionIds: {},
      resultsDisplaySnapshot: null,
      calculationStatus: null,
      testMode: {
        autoAnswerEnabled: false,
        slowResultsEnabled: false,
        slowResultsDelayMs: 15000,
      },
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
    resultsCalculated: false,
    resultsCalculatedAt: null,
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
    resultsCalculated: false,
    resultsCalculatedQuestionId: null,
    processingQuestionId: null,
    processingStartedAtMs: null,
    collectingBonusByPlayer: {},
    collectingBonusJokerByPlayer: {},
    collectingBonusPlayerId: null,
    collectingBonusPoints: 0,
    rankMovementByPlayer: {},
    nextQuestionReadyUntilMs: readyUntilMs,
    nextQuestionReadyQuestionIndex: index,
    categoryVote: null,
    [`usedQuestionIds.${question.id || question.questionId}`]: true,
    stageStartedAtMs,
    readyStartedAtMs: stageStartedAtMs,
    revealStartedAtMs: null,
    resultsStartedAtMs: null,
    updatedAt: serverTimestamp(),
  });
}

async function startCategoryVote(question, _room = null, questionIndex = 0) {
  void _room;
  if (!isVotingQuestion(question)) return false;
  const options = question.voteChoices.map((choice) => ({ label: choice.category, count: 1 }));

  const startedAtMs = getNow();
  await setDoc(
    doc(db, "rooms", ROOM_ID),
    {
      stage: "categoryVote",
      currentQuestion: null,
      currentQuestionIndex: questionIndex - 1,
      categoryVote: {
        id: `category-vote-${startedAtMs}`,
        options,
        votes: {},
        questionId: question.id || question.questionId,
        questionIndex,
        startedAtMs,
      },
      nextQuestionReadyUntilMs: null,
      nextQuestionReadyQuestionIndex: null,
      stageStartedAtMs: startedAtMs,
      updatedAt: serverTimestamp(),
    },
    { merge: true }
  );
  return true;
}

async function submitCategoryVote(player, categoryLabel) {
  if (!player?.id || !categoryLabel) return;
  await updateDoc(doc(db, "rooms", ROOM_ID), {
    [`categoryVote.votes.${player.id}`]: {
      playerId: player.id,
      playerName: player.name || "",
      label: categoryLabel,
      votedAtMs: getNow(),
    },
    updatedAt: serverTimestamp(),
  });
}

async function resolveCategoryVote(room, questions, { selectedCategory = null, chooseRandomTie = false } = {}) {
  const vote = room?.categoryVote;
  if (!vote || room?.stage !== "categoryVote") return { resolved: false, reason: "invalid" };
  const winner = getCategoryVoteWinner(vote);
  const tiedLabels = getCategoryVoteTieLabels(vote);
  const validLabels = (vote.options || []).map((option) => option.label);
  const presenterChoice = validLabels.includes(selectedCategory) ? selectedCategory : null;
  const randomTieChoice = chooseRandomTie && tiedLabels.length
    ? tiedLabels[getRandomIndex(tiedLabels.length)]
    : null;
  const category = winner || presenterChoice || randomTieChoice;
  if (!category) return { resolved: false, reason: tiedLabels.length ? "tie" : "no-winner", tiedLabels };
  const questionIndex = Number(vote.questionIndex ?? (room?.currentQuestionIndex ?? -1) + 1);
  const voteQuestion = questions.find((question) => isSameId(question.id || question.questionId, vote.questionId)) || questions[questionIndex];
  if (!voteQuestion || !isVotingQuestion(voteQuestion)) return { resolved: false, reason: "missing-question" };
  const question = materializeVoteQuestion(voteQuestion, category);
  const readyUntilMs = getNow() + 3000;
  await preloadQuestionForReady(question, questionIndex, readyUntilMs);
  return { resolved: true, category };
}

async function activatePreloadedQuestion(expectedQuestionId = null, expectedQuestionIndex = null) {
  const stageStartedAtMs = getNow();
  const roomRef = doc(db, "rooms", ROOM_ID);
  const roomSnap = await getDoc(roomRef);
  const latestRoom = roomSnap.exists() ? roomSnap.data() : null;
  const latestQuestionId = latestRoom?.currentQuestion?.questionId || latestRoom?.currentQuestion?.id || null;
  const expectedId = expectedQuestionId || latestQuestionId;

  if (
    !latestRoom ||
    latestRoom.stage !== "ready" ||
    (expectedId && !isSameId(latestQuestionId, expectedId)) ||
    (expectedQuestionIndex !== null && Number(latestRoom.currentQuestionIndex) !== Number(expectedQuestionIndex))
  ) {
    console.warn("Skipped stale question activation", {
      expectedQuestionId: expectedId,
      latestQuestionId,
      expectedQuestionIndex,
      latestQuestionIndex: latestRoom?.currentQuestionIndex,
      latestStage: latestRoom?.stage,
    });
    return false;
  }

  await updateDoc(roomRef, {
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
  return true;
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

  await revealCorrectAnswer({ allowUndo, expectedQuestionId: room?.currentQuestion?.questionId || room?.currentQuestion?.id || null });
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

async function revealCorrectAnswer({ allowUndo = false, expectedQuestionId = null } = {}) {
  const stageStartedAtMs = getNow();
  const roomRef = doc(db, "rooms", ROOM_ID);
  const roomSnap = await getDoc(roomRef);
  const latestRoom = roomSnap.exists() ? roomSnap.data() : null;
  const latestQuestionId = latestRoom?.currentQuestion?.questionId || latestRoom?.currentQuestion?.id || null;

  if (
    !latestRoom ||
    latestRoom.stage !== "question" ||
    (expectedQuestionId && !isSameId(latestQuestionId, expectedQuestionId))
  ) {
    console.warn("Skipped stale reveal request", {
      expectedQuestionId,
      latestQuestionId,
      latestStage: latestRoom?.stage,
    });
    return false;
  }

  await setDoc(
    roomRef,
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
  return true;
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

async function beginFinalCountdown(room) {
  const questionId = room?.currentQuestion?.questionId || room?.currentQuestion?.id;
  if (questionId && !isSameId(room?.processedQuestionId, questionId)) {
    await calculateResultsForCurrentQuestion(room, { source: "final", nextStage: null });
  }

  const startedAtMs = getNow();
  await setDoc(
    doc(db, "rooms", ROOM_ID),
    {
      stage: "finalCountdown",
      stageStartedAtMs: startedAtMs,
      finalCountdownStartedAtMs: startedAtMs,
      finalCountdownUntilMs: startedAtMs + 3000,
      revealUndoUntilMs: null,
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

async function archiveLastGame(players = [], questions = [], allAnswers = [], messages = [], room = null) {
  const sortedPlayers = [...players].sort((a, b) => (b.score || 0) - (a.score || 0));
  const savedAtMs = getNow();
  const prizeWinners = room?.prizeWheel?.winners || [];
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
    prizeWinners: prizeWinners.map((winner) => ({ ...winner })),
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

async function finishGame(players = [], questions = [], allAnswers = [], messages = [], room = null) {
  const roomRef = doc(db, "rooms", ROOM_ID);
  const canFinish = await runTransaction(db, async (transaction) => {
    const roomSnap = await transaction.get(roomRef);
    const roomData = roomSnap.exists() ? roomSnap.data() : {};
    if (roomData.stage === "finished" || roomData.finalizingGame) return false;
    transaction.set(roomRef, { finalizingGame: true, updatedAt: serverTimestamp() }, { merge: true });
    return true;
  });
  if (!canFinish) return;

  try {
    await archiveLastGame(players, questions, allAnswers, messages, room);
  } catch (error) {
    console.error("Could not archive the finished game.", error);
  }
  await setDoc(
    roomRef,
    {
      stage: "finished",
      finalizingGame: false,
      finalCountdownUntilMs: null,
      updatedAt: serverTimestamp(),
    },
    { merge: true }
  );
}

async function claimQuestionProcessing(questionId, { publishResultsStage = false } = {}) {
  if (!questionId) return false;
  const roomRef = doc(db, "rooms", ROOM_ID);

  return runTransaction(db, async (transaction) => {
    const roomSnap = await transaction.get(roomRef);
    const roomData = roomSnap.exists() ? roomSnap.data() : {};

    const alreadyProcessed =
      isSameId(roomData.processedQuestionId, questionId) ||
      roomData.currentQuestion?.resultsCalculated === true ||
      (roomData.resultsCalculated === true && isSameId(roomData.resultsCalculatedQuestionId, questionId));
    const processingSameQuestion = isSameId(roomData.processingQuestionId, questionId);
    const processingStartedAt = Number(roomData.processingStartedAtMs || 0);
    const processingIsFresh =
      processingSameQuestion &&
      processingStartedAt &&
      getNow() - processingStartedAt <= RESULTS_PROCESSING_STALE_MS;

    if (alreadyProcessed || processingIsFresh) {
      return false;
    }

    transaction.set(
      roomRef,
      {
        processingQuestionId: questionId,
        processingStartedAtMs: getNow(),
        ...(publishResultsStage ? {
          stage: "results",
          stageStartedAtMs: getNow(),
          resultsStartedAtMs: getNow(),
          revealUndoUntilMs: null,
        } : {}),
        updatedAt: serverTimestamp(),
      },
      { merge: true }
    );

    return true;
  });
}


async function calculateResultsForCurrentQuestion(room, { source = "auto", nextStage = "results", publishResultsStage = false } = {}) {
  const questionId = room?.currentQuestion?.questionId || room?.currentQuestion?.id;
  if (!questionId) return;
  const calculationStartedAtMs = getNow();
  console.log(`Starting result calculation for question ${questionId}`, { source });

  if (
    isSameId(room?.processedQuestionId, questionId) ||
    room?.currentQuestion?.resultsCalculated === true ||
    (room?.resultsCalculated === true && isSameId(room?.resultsCalculatedQuestionId, questionId))
  ) {
    console.log("Results already calculated, skipping", { questionId });
    return { skipped: true };
  }

  const roomRef = doc(db, "rooms", ROOM_ID);
  const simulateSlowResults = !!room?.testMode?.slowResultsEnabled;
  let prefetchedAnswersSnap = null;
  let prefetchedPlayersSnap = null;
  let claimed;

  if (simulateSlowResults) {
    claimed = await claimQuestionProcessing(questionId, { publishResultsStage });
  } else {
    [claimed, prefetchedAnswersSnap, prefetchedPlayersSnap] = await Promise.all([
      claimQuestionProcessing(questionId, { publishResultsStage }),
      getDocs(query(collection(db, "rooms", ROOM_ID, "answers"), where("questionId", "==", questionId))),
      getDocs(collection(db, "rooms", ROOM_ID, "players")),
    ]);
  }

  if (!claimed) {
    console.log("Results already calculated, skipping", { questionId, reason: "busy-or-processed" });
    return { skipped: true };
  }

  // TestMode: simulate slow calculation to test emergency skip
  if (simulateSlowResults) {
    const delayMs = Number(room?.testMode?.slowResultsDelayMs || 15000);
    console.warn(`[TestMode] Delaying calculation by ${delayMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    const freshSnap = await getDoc(roomRef);
    const freshRoom = freshSnap.exists() ? freshSnap.data() : null;
    if (
      freshRoom?.calculationStatus === "skipped" ||
      isSameId(freshRoom?.processedQuestionId, questionId) ||
      isSameId(freshRoom?.resultsCalculatedQuestionId, questionId)
    ) {
      await setDoc(
        roomRef,
        { processingQuestionId: null, processingStartedAtMs: null, updatedAt: serverTimestamp() },
        { merge: true }
      );
      return { skipped: true };
    }
  }

  const isTestMode = !!room?.testMode;
  if (isTestMode) console.time(`[calc] ${questionId}`);

  try {
    const [answersSnap, playersSnap] = prefetchedAnswersSnap && prefetchedPlayersSnap
      ? [prefetchedAnswersSnap, prefetchedPlayersSnap]
      : await Promise.all([
          getDocs(query(collection(db, "rooms", ROOM_ID, "answers"), where("questionId", "==", questionId))),
          getDocs(collection(db, "rooms", ROOM_ID, "players")),
        ]);

    const safeAnswers = answersSnap.docs.map((item) => ({ id: item.id, ...item.data() }));
    const safePlayers = playersSnap.docs
      .map((item) => ({ id: item.id, ...item.data() }))
      .filter((player) => !isVisitorRecord(player));

    if (isTestMode) console.timeLog(`[calc] ${questionId}`, `fetch (${safeAnswers.length} answers, ${safePlayers.length} players)`);
    console.log("Answers loaded", { questionId, answers: safeAnswers.length, players: safePlayers.length });

    if (room?.currentQuestion?.isPractice) {
      // Practice questions use the same result display flow, but their points are reset
      // before the real competition starts.
    }

    const answersToProcess = [...safeAnswers]
      .filter((answer) => isValidPlayerAnswerForQuestion(answer, questionId))
      .sort((a, b) => Number(a.answeredAt || 0) - Number(b.answeredAt || 0));
    const answerByPlayer = new Map(answersToProcess.map((answer) => [answer.playerId, answer]));
    const bonusByPlayer = {};
    const jokerByPlayer = {};
    const correctByPlayer = {};
    const answeredByPlayer = {};

    answersToProcess.forEach((answer) => {
      answeredByPlayer[answer.playerId] = true;
      bonusByPlayer[answer.playerId] = Number(answer.points || 0);
      correctByPlayer[answer.playerId] = !!answer.isCorrect;
      if (answer.jokerApplied) {
        jokerByPlayer[answer.playerId] = getJokerTimingLabel(answer.jokerMultiplier || 3);
      }
    });

    const sortedBefore = [...safePlayers].sort((a, b) => Number(b.score || 0) - Number(a.score || 0));
    const previousRankByPlayer = {};
    sortedBefore.forEach((player, index) => {
      previousRankByPlayer[player.id] = index + 1;
    });

    if (room.questionIgnored) {
      await setDoc(
        roomRef,
        {
          processedQuestionId: questionId,
          resultsCalculated: true,
          resultsCalculatedQuestionId: questionId,
          "currentQuestion.resultsCalculated": true,
          "currentQuestion.resultsCalculatedAt": serverTimestamp(),
          questionResultsById: {
            [questionId]: {
              questionId,
              ignored: true,
              answersCount: 0,
              calculatedAtMs: getNow(),
            },
          },
          collectingBonusByPlayer: {},
          collectingBonusJokerByPlayer: {},
          collectingBonusPlayerId: null,
          collectingBonusPoints: 0,
          rankMovementByPlayer: {},
          collectingAnswerCorrectByPlayer: {},
          resultsAnimationPhase: "done",
          processingQuestionId: null,
          processingStartedAtMs: null,
          resultsError: null,
          updatedAt: serverTimestamp(),
        },
        { merge: true }
      );
      console.log("Question marked as calculated", { questionId, ignored: true });
      return { skipped: false };
    }

    const playerUpdates = safePlayers.map((player) => {
      const answer = answerByPlayer.get(player.id);
      const points = Number(answer?.points || 0);
      const alreadyApplied = isSameId(player.lastQuestionId, questionId);
      const nextScore = alreadyApplied ? Number(player.score || 0) : Number(player.score || 0) + points;
      return {
        player,
        answer,
        points,
        alreadyApplied,
        nextScore,
      };
    });

    const sortedAfterRaw = [...playerUpdates]
      .map(({ player, nextScore }) => ({ player, nextScore }))
      .sort((a, b) => Number(b.nextScore || 0) - Number(a.nextScore || 0));
    const rankMovementByPlayer = {};
    sortedAfterRaw.forEach(({ player }, index) => {
      rankMovementByPlayer[player.id] = (previousRankByPlayer[player.id] || index + 1) - (index + 1);
    });

    const resultsBatch = writeBatch(db);
    playerUpdates.forEach(({ player, answer, points, alreadyApplied, nextScore }) => {
      resultsBatch.update(doc(db, "rooms", ROOM_ID, "players", player.id), {
        score: nextScore,
        answeredCount: Number(player.answeredCount || 0) + (!alreadyApplied && answer ? 1 : 0),
        lastQuestionPoints: points,
        lastQuestionId: questionId,
        lastQuestionCorrect: answer ? !!answer.isCorrect : null,
        lastRankMovement: Number(rankMovementByPlayer[player.id] || 0),
        lastAnswerAt: answer ? serverTimestamp() : player.lastAnswerAt || null,
      });
    });

    // Stable snapshot for ResultsDisplay — before/after for two-phase animation
    const leaderboardBeforeSnapshot = sortedBefore.slice(0, RESULTS_LEADERBOARD_LIMIT).map((player) => ({
      id: player.id,
      name: player.name || "",
      emoji: player.emoji || "",
      score: Number(player.score || 0),
      jokerUsed: player.jokerUsed || false,
      jokerQuestionId: player.jokerQuestionId || null,
      jokerMultiplier: player.jokerMultiplier || null,
      lastQuestionId: player.lastQuestionId || null,
      lastQuestionPoints: Number(player.lastQuestionPoints || 0),
      lastQuestionCorrect: player.lastQuestionCorrect ?? null,
    }));
    const leaderboardAfterSnapshot = sortedAfterRaw.slice(0, RESULTS_LEADERBOARD_LIMIT).map(({ player, nextScore }) => ({
      id: player.id,
      name: player.name || "",
      emoji: player.emoji || "",
      score: nextScore,
      jokerUsed: player.jokerUsed || false,
      jokerQuestionId: player.jokerQuestionId || null,
      jokerMultiplier: player.jokerMultiplier || null,
      lastQuestionId: questionId,
      lastQuestionPoints: Number(bonusByPlayer[player.id] || 0),
      lastQuestionCorrect: correctByPlayer[player.id] ?? null,
    }));

    // Emergency skip appears only after 3 seconds. If this calculation has taken
    // unusually long, verify that the presenter did not skip it or move onward
    // before committing any player-score or room updates.
    if (getNow() - calculationStartedAtMs >= 2500) {
      const latestRoomSnap = await getDoc(roomRef);
      const latestRoom = latestRoomSnap.exists() ? latestRoomSnap.data() : {};
      const latestQuestionId = latestRoom?.currentQuestion?.questionId || latestRoom?.currentQuestion?.id;
      const wasEmergencySkipped =
        !!latestRoom?.skippedQuestionIds?.[questionId] ||
        (latestRoom?.calculationStatus === "skipped" && isSameId(latestRoom?.processedQuestionId, questionId));
      const presenterMovedOn = !isSameId(latestQuestionId, questionId);

      if (wasEmergencySkipped || presenterMovedOn) {
        console.warn("Late result calculation cancelled", { questionId, wasEmergencySkipped, presenterMovedOn });
        return { skipped: true, cancelled: true };
      }
    }

    resultsBatch.set(
      roomRef,
      {
        processedQuestionId: questionId,
        resultsCalculated: true,
        resultsCalculatedQuestionId: questionId,
        "currentQuestion.resultsCalculated": true,
        "currentQuestion.resultsCalculatedAt": serverTimestamp(),
        questionResultsById: {
          [questionId]: {
            questionId,
            answersCount: answersToProcess.length,
            correctCount: answersToProcess.filter((answer) => answer.isCorrect).length,
            jokerCount: answersToProcess.filter((answer) => answer.jokerApplied).length,
            bonusByPlayer,
            jokerByPlayer,
            correctByPlayer,
            answeredByPlayer,
            rankMovementByPlayer,
            calculatedAtMs: getNow(),
          },
        },
        collectingBonusByPlayer: bonusByPlayer,
        collectingBonusJokerByPlayer: jokerByPlayer,
        collectingBonusPlayerId: null,
        collectingBonusPoints: 0,
        rankMovementByPlayer,
        collectingAnswerCorrectByPlayer: correctByPlayer,
        resultsAnimationPhase: "done",
        resultsDisplaySnapshot: {
          questionId,
          leaderboardBefore: leaderboardBeforeSnapshot,
          leaderboardAfter: leaderboardAfterSnapshot,
          bonusByPlayer,
          correctByPlayer,
          answeredByPlayer,
          rankMovementByPlayer,
          calculatedAtMs: getNow(),
        },
        calculationStatus: "calculated",
        processingQuestionId: null,
        processingStartedAtMs: null,
        resultsError: null,
        ...(nextStage ? { stage: nextStage } : {}),
        updatedAt: serverTimestamp(),
      },
      { merge: true }
    );
    await resultsBatch.commit();
    if (isTestMode) console.timeLog(`[calc] ${questionId}`, `atomic results batch (${playerUpdates.length} players)`);
    console.log("Player scores and result snapshot updated atomically", { questionId, players: playerUpdates.length });
    if (isTestMode) console.timeEnd(`[calc] ${questionId}`);
    console.log("Question marked as calculated", { questionId });
    return { skipped: false };
  } catch (error) {
    console.error("Calculation failed", error);
    await setDoc(
      roomRef,
      {
        resultsError: String(error?.message || error),
        processingQuestionId: null,
        processingStartedAtMs: null,
        updatedAt: serverTimestamp(),
      },
      { merge: true }
    );
    throw error;
  } finally {
    console.log("Calculation finished", { questionId });
  }
}

async function showResultsFast(room) {
  const questionId = room?.currentQuestion?.questionId || room?.currentQuestion?.id;
  if (!questionId || isSameId(room?.processedQuestionId, questionId)) {
    await showResults();
    return;
  }

  await calculateResultsForCurrentQuestion(room, {
    source: "show-results",
    nextStage: null,
    publishResultsStage: true,
  });
}

// Called by admin when display page is not open and scores are stuck.
// Reads the current answers and players directly from Firestore and processes them.
async function forceProcessResults(room) {
  return calculateResultsForCurrentQuestion(room, { source: "manual" });
}

// Emergency bypass: marks the current question as processed WITHOUT touching any player scores.
// Used when score calculation is stuck and the admin needs to unblock the competition.
async function skipQuestionCalculation(room, answersCount = 0, { source = "admin-control" } = {}) {
  const questionId = room?.currentQuestion?.questionId || room?.currentQuestion?.id;
  if (!questionId) return;
  const skippedAtMs = getNow();
  const skipReport = {
    questionId,
    questionNumber: Number(room?.currentQuestionIndex ?? -1) + 1,
    questionText: getQuestionDisplayText(room?.currentQuestion) || "سؤال بلا عنوان",
    answersCount: Number(answersCount || 0),
    skippedAtMs,
    source,
    scoreChange: 0,
    standingsChanged: false,
    answersPreserved: true,
    nextQuestionUnlocked: true,
  };

  await setDoc(
    doc(db, "rooms", ROOM_ID),
    {
      processedQuestionId: questionId,
      resultsCalculated: true,
      resultsCalculatedQuestionId: questionId,
      "currentQuestion.resultsCalculated": true,
      processingQuestionId: null,
      processingStartedAtMs: null,
      resultsError: null,
      calculationStatus: "skipped",
      collectingBonusByPlayer: {},
      collectingBonusJokerByPlayer: {},
      collectingBonusPlayerId: null,
      collectingBonusPoints: 0,
      rankMovementByPlayer: {},
      collectingAnswerCorrectByPlayer: {},
      resultsAnimationPhase: "done",
      resultsDisplaySnapshot: null,
      lastSkipReport: skipReport,
      [`skippedQuestionIds.${questionId}`]: true,
      questionResultsById: {
        [questionId]: {
          questionId,
          status: "skipped",
          calculationMode: "skipped",
          answersCount,
          correctCount: null,
          skippedAtMs,
          calculatedAtMs: skippedAtMs,
          scoreChange: 0,
          standingsChanged: false,
          answersPreserved: true,
          nextQuestionUnlocked: true,
        },
      },
      updatedAt: serverTimestamp(),
    },
    { merge: true }
  );
  return skipReport;
}

/* TestMode helpers */

async function updateTestMode(updates) {
  await setDoc(
    doc(db, "rooms", ROOM_ID),
    { testMode: updates, updatedAt: serverTimestamp() },
    { merge: true }
  );
}

async function createFakePlayers(count = 5) {
  const batch = writeBatch(db);
  const emojis = ["🙂", "😎", "⭐", "🎯", "⚡", "🏆", "🔥", "💡", "🎲", "🚀"];
  for (let i = 0; i < Math.max(1, Math.min(count, 60)); i++) {
    const fakeId = `fake_${Date.now()}_${i}`;
    const playerRef = doc(db, "rooms", ROOM_ID, "players", fakeId);
    const number = i + 1;
    batch.set(playerRef, {
      id: fakeId,
      name: `اختبار ${number}`,
      fullName: `متسابق وهمي ${number}`,
      phone: `050000${String(number).padStart(4, "0")}`,
      emoji: emojis[i % emojis.length],
      score: 0,
      isFake: true,
      source: "testMode",
      joinedAt: serverTimestamp(),
    });
  }
  await batch.commit();
}

async function deleteFakeAnswersForQuestion(questionId) {
  if (!questionId) return 0;
  const answersSnap = await getDocs(
    query(collection(db, "rooms", ROOM_ID, "answers"), where("questionId", "==", questionId))
  );
  const fakeAnswers = answersSnap.docs.filter((item) => item.data()?.isFake || item.data()?.playerIsFake);
  if (fakeAnswers.length === 0) return 0;
  const batch = writeBatch(db);
  fakeAnswers.forEach((item) => batch.delete(item.ref));
  await batch.commit();
  return fakeAnswers.length;
}

async function deleteFakePlayers(players) {
  const fakePlayers = players.filter((p) => p.isFake === true);
  if (fakePlayers.length === 0) return;
  const batch = writeBatch(db);
  for (const p of fakePlayers) {
    batch.delete(doc(db, "rooms", ROOM_ID, "players", p.id));
  }
  await batch.commit();
}

async function sendFakeAnswerForPlayer(player, room, existingAnswerIds = new Set()) {
  const question = room?.currentQuestion;
  const questionId = question?.questionId || question?.id;
  if (!questionId || !player?.id) return null;

  const answerId = `${questionId}_${player.id}`;

  // skip if already answered
  if (existingAnswerIds.has(answerId)) return "duplicate";

  const options = question?.options || [];
  // match the exact field the real submitAnswer uses: correctIndex
  const correctIndex = question?.correctIndex ?? question?.correctOption ?? question?.correctOptionIndex ?? null;

  if (options.length === 0 || correctIndex === null || correctIndex === undefined) {
    return "no-options";
  }

  // 75% correct, 25% random wrong
  const isCorrect = Math.random() < 0.75;
  let selectedIndex = Number(correctIndex);
  if (!isCorrect && options.length > 1) {
    const wrongOptions = options.map((_, i) => i).filter((i) => i !== Number(correctIndex));
    selectedIndex = wrongOptions[Math.floor(Math.random() * wrongOptions.length)];
  }

  // Spread answeredAt across the full question duration so points vary clearly
  const answerStartAtMs = getAnswerStartMs(question);
  const questionSeconds = Math.max(5, Number(question.seconds || 20));
  const maxOffsetSeconds = Math.max(1, questionSeconds - 0.5);
  const rand = Math.random();
  let offsetSeconds;
  if (rand < 0.25) {
    offsetSeconds = 1 + Math.random() * 2;            // 25%: 1–3s (fast)
  } else if (rand < 0.60) {
    offsetSeconds = 4 + Math.random() * 4;            // 35%: 4–8s (normal)
  } else if (rand < 0.85) {
    offsetSeconds = 9 + Math.random() * 6;            // 25%: 9–15s (slow)
  } else {
    offsetSeconds = maxOffsetSeconds * 0.78 + Math.random() * (maxOffsetSeconds * 0.20); // 15%: near end
  }
  offsetSeconds = Math.min(Math.max(1, offsetSeconds), maxOffsetSeconds);

  const answeredAt = answerStartAtMs
    ? Math.round(answerStartAtMs + offsetSeconds * 1000)
    : getNow();
  const answerTimeSeconds = answerStartAtMs
    ? Math.max(0, (answeredAt - answerStartAtMs) / 1000)
    : null;

  const basePoints = calculateBasePoints({ question, room, answeredAt });
  const points = calculateFinalPoints({ isCorrect, basePoints, jokerApplied: false });

  await setDoc(
    doc(db, "rooms", ROOM_ID, "answers", answerId),
    {
      playerId: player.id,
      playerName: player.name || "",
      fullName: player.fullName || "",
      phone: player.phone || "",
      questionId,
      selectedIndex,
      isCorrect,
      basePoints,
      jokerApplied: false,
      jokerMultiplier: null,
      jokerTiming: null,
      isPractice: !!question.isPractice,
      points,
      answeredAt,
      answerStartAtMs,
      answerTimeSeconds,
      createdAt: serverTimestamp(),
      isFake: true,
      source: "testMode",
      playerIsFake: true,
    }
  );

  return "written";
}

async function sendFakeAnswersForQuestion(players, room) {
  const question = room?.currentQuestion;
  const questionId = question?.questionId || question?.id;
  const fakePlayers = players.filter((p) => p.isFake === true);

  console.log("[TestMode] sendFakeAnswersForQuestion", {
    fakePlayers: fakePlayers.length,
    questionId,
    options: question?.options?.length,
    correctIndex: question?.correctIndex,
  });

  if (fakePlayers.length === 0) {
    console.warn("[TestMode] لا يوجد لاعبون وهميون");
    return { written: 0, duplicates: 0, failed: 0, error: "no-fake-players" };
  }
  if (!questionId) {
    console.warn("[TestMode] لا يوجد سؤال حالي");
    return { written: 0, duplicates: 0, failed: 0, error: "no-question" };
  }

  // pre-fetch existing answer ids for this question to avoid overwriting
  let existingAnswerIds = new Set();
  try {
    const existingSnap = await getDocs(
      query(collection(db, "rooms", ROOM_ID, "answers"), where("questionId", "==", questionId))
    );
    existingSnap.docs.forEach((d) => existingAnswerIds.add(d.id));
  } catch (e) {
    console.error("[TestMode] Failed to fetch existing answers", e);
  }

  const results = await Promise.all(
    fakePlayers.map((p) => sendFakeAnswerForPlayer(p, room, existingAnswerIds))
  );

  const written = results.filter((r) => r === "written").length;
  const duplicates = results.filter((r) => r === "duplicate").length;
  const noOptions = results.filter((r) => r === "no-options").length;
  const failed = results.filter((r) => r === null).length;

  console.log("[TestMode] نتيجة إرسال الإجابات الوهمية", { written, duplicates, noOptions, failed });

  return { written, duplicates, noOptions, failed };
}

/* Automation */

function AutoRevealCorrectAnswer({ room }) {
  const now = useNow(500);
  const question = room?.currentQuestion;
  const currentAutoRevealQuestionId = question?.questionId || question?.id || null;
  const timeLeft = getQuestionTimeLeft(question, room, now);
  const revealCountdown = getRevealCountdown(question, room, now);
  const [doneQuestionId, setDoneQuestionId] = useState(null);
  const revealTimingRef = useRef({
    questionId: null,
    questionSeenAtMs: null,
    mediaAnswerSeenAtMs: null,
  });

  useEffect(() => {
    if (!room || room.stage !== "question" || !question) return;
    const questionId = question.questionId || question.id || null;
    if (!questionId) return;

    if (revealTimingRef.current.questionId !== questionId || !revealTimingRef.current.questionSeenAtMs) {
      revealTimingRef.current = {
        questionId,
        questionSeenAtMs: Date.now(),
        mediaAnswerSeenAtMs: null,
      };
    }

    if (isMediaQuestion(question) && hasMediaEnded(room, question) && !revealTimingRef.current.mediaAnswerSeenAtMs) {
      revealTimingRef.current = {
        ...revealTimingRef.current,
        mediaAnswerSeenAtMs: Date.now(),
      };
    }

    if (doneQuestionId === questionId) return;
    if (revealCountdown === null) return;

    const seconds = Math.max(1, Number(question.seconds || question.time || 20) || 20);
    const revealDelayMs = getRevealDelayMs(question);
    const localStartAt = isMediaQuestion(question)
      ? revealTimingRef.current.mediaAnswerSeenAtMs
      : revealTimingRef.current.questionSeenAtMs;
    const requiredLocalElapsedMs = revealDelayMs + seconds * 1000;
    const localElapsedMs = localStartAt ? Date.now() - localStartAt : 0;

    if (localElapsedMs + 500 < requiredLocalElapsedMs) return;

    if (revealCountdown <= 0 && timeLeft <= 0) {
      setDoneQuestionId(questionId);
      revealCorrectAnswer({ expectedQuestionId: questionId });
    }
  }, [room, question, timeLeft, revealCountdown, doneQuestionId]);

  useEffect(() => {
    setDoneQuestionId(null);
    revealTimingRef.current = {
      questionId: currentAutoRevealQuestionId,
      questionSeenAtMs: room?.stage === "question" && currentAutoRevealQuestionId ? Date.now() : null,
      mediaAnswerSeenAtMs: null,
    };
  }, [currentAutoRevealQuestionId, room?.stage]);

  return null;
}

// Reliably ends the question when answerEndAtMs is reached.
// AutoRevealCorrectAnswer has a local-elapsed-time guard that blocks when the page
// opens mid-question. This component uses only server-synced answerEndAtMs.
// Mount ONLY in admin/display — not in player views — so only one browser fires it.
function AutoEndQuestionOnTimer({ room }) {
  const now = useNow(500);
  const endedRef = useRef(null);

  useEffect(() => {
    if (!room || room.stage !== "question") return;
    const question = room.currentQuestion;
    const questionId = question?.questionId || question?.id || null;
    if (!questionId) return;

    const answerEndAtMs =
      Number(room.answerEndAtMs) ||
      Number(question?.answerEndAtMs) ||
      0;
    if (!answerEndAtMs) return;

    // 500ms buffer: prevents ending a fraction early due to polling interval
    if (now < answerEndAtMs + 500) return;

    if (endedRef.current === questionId) return; // already triggered for this question
    endedRef.current = questionId;

    // revealCorrectAnswer reads Firestore first and aborts if stage changed,
    // so concurrent calls from display + admin tabs are safe.
    revealCorrectAnswer({ expectedQuestionId: questionId });
  }, [room, now]);

  useEffect(() => {
    if (room?.stage !== "question") {
      endedRef.current = null;
    }
  }, [room?.stage]);

  return null;
}

// Fallback: if stage stays "ready" longer than expected + 1500ms,
// auto-activates the preloaded question. Handles cases where the admin tab's
// local setInterval fires late or the tab is backgrounded.
// Mount ONLY in admin/display (alwaysOnAutomations).
function AutoActivateReadyQuestion({ room }) {
  const now = useNow(500);
  const doneRef = useRef(null);

  useEffect(() => {
    if (room?.stage !== "ready") { doneRef.current = null; return; }
    const readyUntilMs = Number(room?.nextQuestionReadyUntilMs || 0);
    if (!readyUntilMs) return;
    if (now < readyUntilMs + 1500) return;
    const questionId = room?.currentQuestion?.questionId || room?.currentQuestion?.id;
    if (!questionId) return;
    if (doneRef.current === questionId) return;
    doneRef.current = questionId;
    const questionIndex = room?.nextQuestionReadyQuestionIndex ?? room?.currentQuestionIndex ?? 0;
    activatePreloadedQuestion(questionId, questionIndex).catch((err) =>
      console.error("AutoActivateReadyQuestion failed:", err)
    );
  }, [room, now]);

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
      const questionId = room?.currentQuestion?.questionId || room?.currentQuestion?.id;

      if (!room || room.stage !== "results" || !questionId) return;
      if (isSameId(room.processedQuestionId, questionId)) return;
      if (isSameId(room.processingQuestionId, questionId) && !isResultsProcessingStale(room, questionId)) return;
      if (processingQuestionId === questionId) return;

      setProcessingQuestionId(questionId);

      try {
        await calculateResultsForCurrentQuestion(room, { source: "auto" });
      } catch (error) {
        console.error("AutoProcessResults failed:", error);
      } finally {
        setProcessingQuestionId(null);
      }
    }

    processScores();
  }, [room, processingQuestionId, answers, players]);

  useEffect(() => {
    if (room?.stage !== "results") {
      setProcessingQuestionId(null);
    }
  }, [room?.stage]);

  return null;
}

function AutoFinishFinalCountdown({ room, players = [], questions = [], allAnswers = [], messages = [] }) {
  const now = useNow(250);
  const [finalizing, setFinalizing] = useState(false);

  useEffect(() => {
    async function finishAfterCountdown() {
      if (!room || room.stage !== "finalCountdown" || finalizing) return;
      const untilMs = Number(room.finalCountdownUntilMs || 0);
      if (!untilMs || now < untilMs) return;

      setFinalizing(true);
      try {
        await finishGame(players, getMainQuestions(questions), allAnswers || [], messages, room);
      } catch (error) {
        console.error("Final countdown finish failed:", error);
        setFinalizing(false);
      }
    }

    finishAfterCountdown();
  }, [room, now, finalizing, players, questions, allAnswers, messages]);

  useEffect(() => {
    if (room?.stage !== "finalCountdown") {
      setFinalizing(false);
    }
  }, [room?.stage]);

  return null;
}
function AutoFakeAnswers({ room, players = [] }) {
  const timerIdsRef = useRef([]);
  const scheduledQIdRef = useRef(null);

  const autoEnabled = room?.testMode?.autoAnswerEnabled === true;
  const stage = room?.stage;
  const question = room?.currentQuestion;
  const questionId = question?.questionId || question?.id || null;
  // Use count as dep — avoids object identity re-renders on every Firestore update
  const fakeCount = players.filter((p) => p.isFake).length;

  useEffect(() => {
    // Guard: nothing to do
    if (
      !autoEnabled ||
      !questionId ||
      stage !== "question" ||
      question?.answersLocked ||
      question?.resultsCalculated ||
      fakeCount === 0 ||
      scheduledQIdRef.current === questionId // already scheduled for this question
    ) {
      return;
    }

    // Capture stable snapshot at schedule time
    const capturedQId = questionId;
    const capturedRoom = room;
    const capturedFakePlayers = players.filter((p) => p.isFake === true);

    scheduledQIdRef.current = capturedQId;

    const answerStartAtMs = getAnswerStartMs(question);
    const now = getNow();
    const questionSeconds = Math.max(5, Number(question.seconds || 20));

    console.log(`[AutoFakeAnswers] Scheduling ${capturedFakePlayers.length} answers for Q:${capturedQId}`);

    const newTimerIds = capturedFakePlayers.map((player) => {
      const rand = Math.random();
      let offsetSec;
      if (rand < 0.25) offsetSec = 1 + Math.random() * 2;
      else if (rand < 0.60) offsetSec = 4 + Math.random() * 4;
      else if (rand < 0.85) offsetSec = 9 + Math.random() * 6;
      else offsetSec = Math.max(1, questionSeconds * 0.78 + Math.random() * (questionSeconds * 0.20));
      offsetSec = Math.min(Math.max(1, offsetSec), questionSeconds - 0.5);

      const targetMs = answerStartAtMs
        ? answerStartAtMs + offsetSec * 1000
        : now + offsetSec * 1000;
      const delayMs = Math.max(300, targetMs - now);

      return setTimeout(async () => {
        // Abort if question changed since scheduling
        if (scheduledQIdRef.current !== capturedQId) {
          console.log(`[AutoFakeAnswers] Stale timer, skipping ${player.name}`);
          return;
        }
        try {
          const result = await sendFakeAnswerForPlayer(player, capturedRoom, new Set());
          console.log(`[AutoFakeAnswers] ${result === "written" ? "✓" : result} ${player.name} (Q:${capturedQId})`);
        } catch (e) {
          console.error(`[AutoFakeAnswers] ✗ ${player.name}:`, e);
        }
      }, delayMs);
    });

    timerIdsRef.current = newTimerIds;

    return () => {
      console.log(`[AutoFakeAnswers] Cancelling ${newTimerIds.length} timers for Q:${capturedQId}`);
      newTimerIds.forEach(clearTimeout);
      timerIdsRef.current = [];
      scheduledQIdRef.current = null;
    };
  // Specific deps only — NOT room/players object to avoid cancellation on every Firestore update
  }, [autoEnabled, questionId, stage, fakeCount]); // eslint-disable-line react-hooks/exhaustive-deps

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
  answerCorrectByPlayer = {},
  answeredPlayerIds = null,
  freezeLayout = false,
}) {
  const visiblePlayers = players;
  const hasAnsweredPlayerFilter = answeredPlayerIds && typeof answeredPlayerIds === "object";

  function renderFlashBadges(player) {
    const hasBonusEntry = Object.prototype.hasOwnProperty.call(bonusPointsByPlayer || {}, player.id);
    const hasAnswerResultEntry = Object.prototype.hasOwnProperty.call(answerCorrectByPlayer || {}, player.id);
    const hasAnsweredCurrentQuestion =
      hasAnsweredPlayerFilter
        ? Object.prototype.hasOwnProperty.call(answeredPlayerIds, player.id)
        : hasAnswerResultEntry;
    const isSameQuestion =
      currentQuestionId &&
      player.lastQuestionId != null &&
      String(player.lastQuestionId) === String(currentQuestionId);
    const savedLastQuestionPoints =
      isSameQuestion && hasAnsweredCurrentQuestion
        ? Number(player.lastQuestionPoints || 0)
        : 0;
    const delta = hasBonusEntry && hasAnsweredCurrentQuestion
      ? Number(bonusPointsByPlayer?.[player.id] || 0)
      : savedLastQuestionPoints;
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
        <motion.div
          className="leaderboard"
          layout
          transition={{ layout: freezeLayout ? { duration: 0 } : isCollecting ? { duration: 0 } : { duration: 0.45 } }}
        >
          <AnimatePresence initial={false}>
            {visiblePlayers.map((player, index) => {
              const jokerUsedInCurrentQuestion =
                player.jokerUsed &&
                currentQuestionId &&
                player.jokerQuestionId === currentQuestionId;
              const hasCurrentAnswerResult =
                !!currentQuestionId &&
                String(player.lastQuestionId) === String(currentQuestionId) &&
                typeof player.lastQuestionCorrect === "boolean";
              const hasAnsweredCurrentQuestionForTone = hasAnsweredPlayerFilter
                ? Object.prototype.hasOwnProperty.call(answeredPlayerIds, player.id)
                : hasCurrentAnswerResult;
              const currentAnswerCorrect =
                hasAnsweredCurrentQuestionForTone && typeof answerCorrectByPlayer?.[player.id] === "boolean"
                  ? answerCorrectByPlayer[player.id]
                  : hasCurrentAnswerResult
                    ? player.lastQuestionCorrect
                    : null;
              const scoreToneClass =
                currentQuestionId && !hasAnsweredCurrentQuestionForTone
                  ? " score-no-answer"
                  : currentAnswerCorrect === true
                  ? " score-correct"
                  : currentAnswerCorrect === false
                    ? " score-wrong"
                    : "";
              // When frozen: disable layout entirely. When live: animate only moved rows.
              const playerMoved = Number(rankMovementByPlayer?.[player.id] || 0) !== 0;
              const layoutTransition = isCollecting
                ? { duration: 0 }
                : playerMoved
                  ? { duration: 0.58, type: "spring", bounce: 0.12 }
                  : { duration: 0 };

              return (
                <motion.div
                  layout
                  key={player.id}
                  className={`leaderboard-row animated-leaderboard-row rank-${index + 1} ${compact ? "compact" : ""}`}
                  initial={{ opacity: 0, scale: 0.96 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.96 }}
                  transition={{
                    layout: freezeLayout ? { duration: 0 } : layoutTransition,
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

                  <div className={`leaderboard-score-wrap${scoreToneClass}`}>
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

function RegistrationQrPanel() {
  return (
    <div className="card registration-qr-card">
      <div className="registration-qr-heading">
        <h2>للمشاركة امسح الباركود</h2>
      </div>

      <div className="registration-qr-frame">
        <img src="/QR.png" alt="باركود التسجيل في المسابقة" />
      </div>
    </div>
  );
}

function DisplaySidePanel({ messages, videoEnabled, registrationMode = false }) {
  return (
    <div className={videoEnabled ? "display-side-panel has-video-slot" : "display-side-panel"}>
      {registrationMode ? <RegistrationQrPanel /> : <MessagesPanel messages={messages} />}
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

function getPrizeWheelPlayers(players = [], prizeWheel = {}) {
  const previousWinnerIds = new Set((prizeWheel.winners || []).map((winner) => winner.playerId));
  const basePlayers = (players || []).filter((player) => !isVisitorRecord(player));
  const eligiblePlayers = prizeWheel.excludePreviousWinners
    ? basePlayers.filter((player) => !previousWinnerIds.has(player.id))
    : basePlayers;
  return eligiblePlayers.length > 0 ? eligiblePlayers : basePlayers;
}

async function spinPrizeWheelForRoom(room, players, overrides = {}) {
  const currentPrizeWheel = room?.prizeWheel || {};
  const nextPrizeWheel = {
    ...currentPrizeWheel,
    ...overrides,
  };
  const candidates = getPrizeWheelPlayers(players, nextPrizeWheel);
  if (candidates.length === 0) {
    alert("لا يوجد متسابقون لتشغيل سحب الجوائز.");
    return;
  }

  const selectedWinner =
    candidates.find((player) => player.id === nextPrizeWheel.selectedPlayerId) ||
    candidates[getRandomIndex(candidates.length)];
  const prizeTitle = (nextPrizeWheel.prizeTitle || "").trim() || "جائزة مفاجئة";
  const prizeItemId = nextPrizeWheel.activePrizeItemId || overrides.prizeItemId || null;
  const spinId = `${getNow()}-${selectedWinner.id}`;
  const winnerRecord = {
    prizeItemId,
    playerId: selectedWinner.id,
    playerName: selectedWinner.name || "",
    playerFullName: selectedWinner.fullName || "",
    playerEmoji: selectedWinner.emoji || "",
    prizeTitle,
    gameTitle: QUIZ_TITLE,
    awardedAtMs: getNow(),
    spinId,
  };

  await updateDoc(doc(db, "rooms", ROOM_ID), {
    stage: "prizeWheel",
    "prizeWheel.previousStage": room?.stage === "prizeWheel" ? currentPrizeWheel.previousStage || "registration" : room?.stage || "registration",
    "prizeWheel.prizeTitle": prizeTitle,
    "prizeWheel.activePrizeItemId": prizeItemId,
    "prizeWheel.excludePreviousWinners": !!nextPrizeWheel.excludePreviousWinners,
    "prizeWheel.selectedPlayerId": nextPrizeWheel.selectedPlayerId || null,
    "prizeWheel.winnerPlayerId": selectedWinner.id,
    "prizeWheel.spinId": spinId,
    "prizeWheel.spinStartedAtMs": getNow(),
    "prizeWheel.spinning": true,
    "prizeWheel.winners": arrayUnion(winnerRecord),
    updatedAt: serverTimestamp(),
  });
}

function PrizeWheelDisplay({ room, players }) {
  const prizeWheel = room?.prizeWheel || {};
  const displayPrizeWheel = {
    ...prizeWheel,
    winners: (prizeWheel.winners || []).filter((winnerItem) => winnerItem.spinId !== prizeWheel.spinId),
  };
  const wheelPlayers = getPrizeWheelPlayers(players, displayPrizeWheel);
  const winner = players.find((player) => player.id === prizeWheel.winnerPlayerId) || null;
  const winnerIndex = Math.max(0, wheelPlayers.findIndex((player) => player.id === winner?.id));
  const [highlightedIndex, setHighlightedIndex] = useState(null);
  const [showWinner, setShowWinner] = useState(false);
  const spinActive = !!prizeWheel.spinning && !!prizeWheel.spinId && !!winner;

  useEffect(() => {
    if (!spinActive) {
      setHighlightedIndex(null);
      setShowWinner(false);
      return undefined;
    }

    setShowWinner(false);
    setHighlightedIndex(0);
    const timers = [];
    const cardCount = wheelPlayers.length;
    const baseSteps = Math.min(76, Math.max(30, cardCount * 2 + 18));
    const finalStep = baseSteps + ((winnerIndex - (baseSteps % cardCount) + cardCount) % cardCount);

    function scheduleStep(step) {
      const progress = step / Math.max(1, finalStep);
      const delay = 45 + Math.round((progress ** 2.25) * 250);
      const timer = setTimeout(() => {
        const nextIndex = step % cardCount;
        setHighlightedIndex(nextIndex);
        if (step >= finalStep) {
          setShowWinner(true);
          return;
        }
        scheduleStep(step + 1);
      }, delay);
      timers.push(timer);
    }

    scheduleStep(1);
    return () => {
      timers.forEach((timer) => clearTimeout(timer));
    };
  }, [prizeWheel.spinId, spinActive, wheelPlayers.length, winnerIndex]);

  return (
    <div className={room?.displayVideoSlotEnabled ? "display-panel prize-draw-screen prize-draw-with-video-space" : "display-panel prize-draw-screen"}>
      <div className="prize-draw-header">
        <span>سحب الجوائز</span>
        <strong>{prizeWheel.prizeTitle || "جائزة مفاجئة"}</strong>
      </div>

      <div className={spinActive ? "prize-draw-grid is-drawing" : "prize-draw-grid"}>
        {wheelPlayers.length === 0 ? (
          <div className="prize-draw-empty">لا يوجد متسابقون</div>
        ) : (
          wheelPlayers.map((player, index) => {
            const isHighlighted = highlightedIndex === index;
            const isWinner = showWinner && winner?.id === player.id;
            return (
              <div
                className={[
                  "prize-draw-card",
                  isHighlighted ? "is-highlighted" : "",
                  isWinner ? "is-winner" : "",
                  showWinner && !isWinner ? "is-dimmed" : "",
                ].filter(Boolean).join(" ")}
                key={player.id}
              >
                <span className="prize-draw-number">{index + 1}</span>
                <strong>{player.emoji || "⭐"} {player.name}</strong>
              </div>
            );
          })
        )}
      </div>

      <div className={showWinner && winner ? "prize-draw-footer prize-wheel-winner visible" : "prize-draw-footer"}>
        {showWinner && winner ? (
          <>
            <span>الفائز</span>
            <strong>{winner.emoji || ""} {winner.name}</strong>
          </>
        ) : spinActive ? (
          <strong>جاري السحب...</strong>
        ) : (
          <button type="button" className="prize-wheel-spin-button" onClick={() => spinPrizeWheelForRoom(room, players)} disabled={wheelPlayers.length === 0}>
            سحب
          </button>
        )}
      </div>
    </div>
  );
}

function LiveAnswerOption({ item, showCorrect }) {
  const resultClass = showCorrect
    ? item.correct
      ? "result-item modern-answer-card answer-correct"
      : "result-item modern-answer-card answer-wrong"
    : "result-item modern-answer-card";
  const optionLetter = ["أ", "ب", "ج", "د", "هـ", "و"][item.index] || item.index + 1;
  const animatedPercent = useRevealProgressValue(item.percent, showCorrect);
  const percent = Math.round(animatedPercent);

  return (
    <div className={resultClass}>
      <div className="result-top">
        <b className="answer-option-letter">{optionLetter}</b>
        <span>{item.option}</span>

        <div
          className={showCorrect ? "result-count-boxes" : "result-count-boxes is-reserved"}
          aria-label="إحصائيات الإجابة"
          aria-hidden={!showCorrect}
        >
          <span className="answer-count-box"><small>إجابات</small><b><RevealCountNumber value={item.count} active={showCorrect} /></b></span>
          <span className={item.jokerCount > 0 ? "joker-answer-count-box" : "joker-answer-count-box is-empty"}><small>{"\u{1F0CF}"}</small><b><RevealCountNumber value={item.jokerCount} active={showCorrect} /></b></span>
          <span className="answer-percent-box">
            <span className="reveal-count-number is-counting">{percent}</span>%
          </span>
        </div>
      </div>

      <div className={showCorrect ? "bar" : "bar is-reserved"} aria-hidden={!showCorrect}>
        <div className={showCorrect ? "bar-fill is-counting" : "bar-fill"} style={{ width: `${percent}%` }} />
      </div>
    </div>
  );
}

function LiveAnswerStats({ question, answers, showCorrect = false }) {
  const stats = buildAnswerStats(question, answers);

  return (
    <div className="live-answer-stats">
      {stats.map((item) => (
        <LiveAnswerOption item={item} showCorrect={showCorrect} key={item.index} />
      ))}
    </div>
  );
}



function InstructionsPage({ isAdmin = false, room = null }) {
  const showInstructionVideoSlot = isAdmin && !!room?.displayVideoSlotEnabled;

  return (
    <div className={[
      isAdmin ? "display-panel instructions-page" : "card instructions-page",
      showInstructionVideoSlot ? "instructions-with-video" : "",
    ].filter(Boolean).join(" ")}>
      {showInstructionVideoSlot && (
        <div className="instructions-video-spacer" aria-hidden="true" />
      )}

      <div className="instructions-content-stack">
        <div className="instructions-hero">
          <span>✦</span>
          <div>
            <h1>طريقة المسابقة</h1>
            <p>معلومات سريعة قبل بداية اللعب.</p>
          </div>
        </div>

        <div className="instructions-board instructions-board-v2" aria-label="طريقة المسابقة">
          <section className="instruction-vote-card">
            <div className="instruction-card-icon">🗳️</div>
            <div className="instruction-card-copy">
              <small>بعض الجولات تبدأ بتصويت</small>
              <strong>اختر التصنيف الذي تريد سؤاله</strong>
              <p>يظهر تصنيفان على جوالك. صوّت مرة واحدة، والتصنيف الأعلى تصويتًا يحدد السؤال الذي سيظهر للجميع.</p>
            </div>
            <div className="instruction-vote-example" aria-label="مثال على تصويت التصنيفات">
              <span>تاريخ</span>
              <b>أو</b>
              <span>رياضة</span>
            </div>
          </section>

          <div className="instruction-flow-grid">
            <section className="instruction-flow-card question-flow">
              <span className="instruction-step-number">1</span>
              <div><strong>انتظر ظهور السؤال</strong><p>بعد التصويت أو مباشرة في الجولات العادية، يصل السؤال إلى جوالك.</p></div>
            </section>
            <section className="instruction-flow-card answer-flow">
              <span className="instruction-step-number">2</span>
              <div><strong>جاوب بسرعة ودقة</strong><p>الإجابة الصحيحة الأسرع تحصل على نقاط أكثر، والخطأ العادي لا ينقص نقاطك.</p></div>
            </section>
            <section className="instruction-flow-card result-flow">
              <span className="instruction-step-number">3</span>
              <div><strong>تابع نتيجتك</strong><p>بعد كل سؤال تظهر نقاطك وترتيبك مباشرة.</p></div>
            </section>
          </div>

          <section className="instruction-joker-card instruction-joker-card-v2">
            <div className="joker-card-head">
              <span>{"\u{1F0CF}"}</span>
              <div><strong>لك جوكر واحد طوال المسابقة</strong><p>فعّله في الجولة التي تثق بإجابتها.</p></div>
            </div>
            <div className="joker-focus-card" aria-label="شرح الجوكر">
              <div className="joker-multiplier-pair">
                <div className="joker-multiplier-option before"><small>قبل ظهور السؤال</small><b>x3</b></div>
                <div className="joker-multiplier-option after"><small>بعد ظهور السؤال</small><b>x2</b></div>
              </div>
              <div className="joker-result-note"><span className="negative">إذا أخطأت بالجوكر تُخصم قيمة السؤال</span></div>
            </div>
          </section>
        </div>
      </div>

      {isAdmin ? null : (
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
      <strong><AnimatedNumber value={answersCount} duration={650} /></strong>
      <small>من {playersCount}</small>
    </div>
  );
}

function CategoryVoteScreen({ room, players = [], player = null, onVote = null, displayMode = false }) {
  const vote = room?.categoryVote || {};
  const options = Array.isArray(vote.options) ? vote.options : [];
  const counts = getCategoryVoteCounts(vote);
  const playerVote = player?.id ? vote.votes?.[player.id]?.label : null;
  const totalVotes = Object.keys(vote.votes || {}).length;
  const winner = getCategoryVoteWinner(vote);
  const playersCount = Math.max(players.length, totalVotes, 1);

  return (
    <div className={displayMode ? "display-panel category-vote-screen display-category-vote" : "category-vote-screen card"}>
      <div className="category-vote-head">
        <span>تصويت التصنيف</span>
        <h2>اختاروا تصنيف السؤال القادم</h2>
        <p>{displayMode ? "التصنيف الأعلى تصويتًا سيحدد السؤال القادم." : "صوّت مرة واحدة، ثم انتظر نتيجة التصويت على الشاشة."}</p>
      </div>

      <div className="category-vote-options">
        {options.map((option) => {
          const count = counts[option.label] || 0;
          const percent = Math.round((count / playersCount) * 100);
          const selected = playerVote === option.label;
          const leading = winner === option.label;
          return (
            <button
              type="button"
              className={`category-vote-option${selected ? " selected" : ""}${leading ? " leading" : ""}`}
              key={option.label}
              onClick={() => onVote?.(option.label)}
              disabled={!onVote || !!playerVote}
            >
              <strong>{option.label}</strong>
              <span>{count} صوت</span>
              <i style={{ "--vote-ratio": `${percent}%` }} />
            </button>
          );
        })}
      </div>

      <div className="category-vote-footer">
        <strong>{totalVotes}</strong>
        <span>إجمالي الأصوات</span>
        {playerVote && <b>تم تسجيل صوتك: {playerVote}</b>}
      </div>
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

  async function handleMediaPlay() {
    if (isAdmin && displayMode && !mediaStarted) {
      await startMediaQuestion();
    }
  }

  async function handleEnded() {
    if (isAdmin && displayMode && !mediaEnded) {
      await finishMediaQuestion(question);
    }
  }

  async function handleFinishMedia() {
    if (mediaRef.current) {
      mediaRef.current.pause?.();
    }
    await finishMediaQuestion(question);
  }

  if (!mediaUrl) return null;

  const canParticipantPlay = !isAdmin && mediaEnded;
  const showControls = (isAdmin && displayMode) || canParticipantPlay;

  return (
    <div className="reveal-box media-question-player">
      {isVideo ? (
        <video
          ref={mediaRef}
          controls={showControls}
          src={mediaUrl}
          onPlay={handleMediaPlay}
          onEnded={handleEnded}
          style={{ width: "100%", maxHeight: displayMode ? "34vh" : "220px", borderRadius: "16px" }}
        />
      ) : (
        <audio
          ref={mediaRef}
          controls={showControls}
          src={mediaUrl}
          onPlay={handleMediaPlay}
          onEnded={handleEnded}
          style={{ width: "100%" }}
        />
      )}

      {isAdmin && displayMode && !mediaEnded && (
        <button
          type="button"
          onClick={mediaStarted ? handleFinishMedia : handleStartMedia}
          className="media-primary-action"
        >
          {mediaStarted ? "إظهار الخيارات" : "تشغيل المقطع"}
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
  const canShowQuestionJoker =
    !isAdmin &&
    currentPlayer &&
    activeStage === "question" &&
    shouldShowPracticeJoker &&
    (question?.isPractice
      ? canUsePracticeJokerInQuestion
      : true);

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

        {displayMode && (activeStage === "question" || activeStage === "reveal") && (
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

function ResultsDisplay({ room, messages, answers = [] }) {
  const currentQuestionId = room?.currentQuestion?.questionId || room?.currentQuestion?.id || null;
  const questionNumber = (room?.currentQuestionIndex ?? 0) + 1;
  const videoEnabled = !!room?.displayVideoSlotEnabled;
  const answeredPlayerIds = Object.fromEntries(
    (answers || [])
      .filter((answer) => isValidPlayerAnswerForQuestion(answer, currentQuestionId))
      .map((answer) => [answer.playerId, true])
  );

  const snapshot = room?.resultsDisplaySnapshot;

  // hasValidSnapshot checks only the snapshot itself — NOT isCollecting/processedQuestionId.
  // Reason: snapshot.questionId matching currentQuestionId is the only condition we need.
  // Adding !isCollecting caused loading to show even when snapshot was already valid.
  const hasValidSnapshot =
    snapshot?.questionId === currentQuestionId &&
    Array.isArray(snapshot?.leaderboardBefore) &&
    snapshot.leaderboardBefore.length > 0 &&
    Array.isArray(snapshot?.leaderboardAfter) &&
    snapshot.leaderboardAfter.length > 0;

  // before      → leaderboardBefore, no badges         (immediate)
  // applyPoints → leaderboardBefore + bonus badges     (+400ms)
  // move        → leaderboardAfter  + spring layout    (+600ms)
  // frozen      → leaderboardAfter, locked             (+1000ms)
  const [phaseState, setPhaseState] = useState({ questionId: null, phase: "before" });
  const animatedForRef = useRef(null);
  const timer1Ref = useRef(null);
  const timer2Ref = useRef(null);
  const timer3Ref = useRef(null);

  const phase =
    phaseState.questionId === currentQuestionId
      ? phaseState.phase
      : "before";

  useEffect(() => {
    if (!hasValidSnapshot) return;
    if (animatedForRef.current === currentQuestionId) return;
    animatedForRef.current = currentQuestionId;

    setPhaseState({ questionId: currentQuestionId, phase: "before" });

    timer1Ref.current = setTimeout(() => {
      setPhaseState({ questionId: currentQuestionId, phase: "applyPoints" });

      timer2Ref.current = setTimeout(() => {
        setPhaseState({ questionId: currentQuestionId, phase: "move" });

        timer3Ref.current = setTimeout(() => {
          setPhaseState({ questionId: currentQuestionId, phase: "frozen" });
        }, 1000);
      }, 600);
    }, 400);

    return () => {
      clearTimeout(timer1Ref.current);
      clearTimeout(timer2Ref.current);
      clearTimeout(timer3Ref.current);
      animatedForRef.current = null;
    };
  }, [hasValidSnapshot, snapshot?.questionId, currentQuestionId]);

  // No valid snapshot → show status only. Loading card is NEVER shown when snapshot is valid.
  if (!hasValidSnapshot) {
    const isCollecting = currentQuestionId && room?.processedQuestionId !== currentQuestionId;
    const wasSkipped = !isCollecting && room?.calculationStatus === "skipped";
    const wasIgnored = !isCollecting && !!room?.questionIgnored;

    let statusMsg = "جاري احتساب النتائج...";
    if (wasSkipped) statusMsg = "تم تجاوز هذا السؤال بدون احتساب نقاط.";
    else if (wasIgnored) statusMsg = "تم تجاهل هذا السؤال، ولم تُحتسب أي نقاط.";

    return (
      <div className="results-display-grid">
        <div className="results-main-area">
          <div className="results-collecting-card">
            {isCollecting && (
              <div className="collecting-dots-row">
                <span className="collecting-dot" />
                <span className="collecting-dot" />
                <span className="collecting-dot" />
              </div>
            )}
            <p className="results-collecting-label">{statusMsg}</p>
          </div>
        </div>
        <div className="results-messages-area">
          <DisplaySidePanel messages={messages} videoEnabled={videoEnabled} />
        </div>
      </div>
    );
  }

  // Derived synchronously from snapshot + ref phase — never empty when hasValidSnapshot.
  // Phase:      | displayPlayers    | bonus | correct | rankMovement | spring
  // before      | leaderboardBefore |  no   |   no    |     no       |  no
  // applyPoints | leaderboardBefore |  yes  |   no    |     no       |  no
  // move        | leaderboardAfter  |  yes  |   yes   |     yes      |  YES
  // frozen      | leaderboardAfter  |  yes  |   yes   |     yes      |  no
  const showAfter = phase === "move" || phase === "frozen";
  const showBonus = phase !== "before";
  const displayPlayers      = showAfter ? snapshot.leaderboardAfter  : snapshot.leaderboardBefore;
  const displayBonus        = showBonus ? (snapshot.bonusByPlayer    || {}) : {};
  const displayCorrect      = showBonus ? (snapshot.correctByPlayer  || {}) : {};
  const hasLiveAnsweredIds = Object.keys(answeredPlayerIds).length > 0;
  const displayAnswered =
    hasLiveAnsweredIds
      ? answeredPlayerIds
      : snapshot.answeredByPlayer && typeof snapshot.answeredByPlayer === "object"
      ? snapshot.answeredByPlayer
      : snapshot.correctByPlayer && typeof snapshot.correctByPlayer === "object"
        ? Object.fromEntries(Object.keys(snapshot.correctByPlayer).map((playerId) => [playerId, true]))
        : {};
  const sanitizedDisplayBonus = Object.fromEntries(
    Object.entries(displayBonus).filter(([playerId]) =>
      Object.prototype.hasOwnProperty.call(displayAnswered, playerId)
    )
  );
  const sanitizedDisplayCorrect = Object.fromEntries(
    Object.entries(displayCorrect).filter(([playerId]) =>
      Object.prototype.hasOwnProperty.call(displayAnswered, playerId)
    )
  );
  const sanitizedDisplayPlayers = displayPlayers.slice(0, RESULTS_LEADERBOARD_LIMIT).map((player) => {
    const answered = Object.prototype.hasOwnProperty.call(displayAnswered, player.id);
    if (answered) return player;
    return {
      ...player,
      lastQuestionId: currentQuestionId || player.lastQuestionId,
      lastQuestionPoints: 0,
      lastQuestionCorrect: null,
    };
  });
  const displayRankMovement = showAfter ? (snapshot.rankMovementByPlayer || {}) : {};
  const freezeLayout        = phase !== "move";

  return (
    <div className="results-display-grid">
      <div className="results-main-area">
        <Leaderboard
          players={sanitizedDisplayPlayers}
          compact
          isCollecting={false}
          bonusPointsByPlayer={sanitizedDisplayBonus}
          rankMovementByPlayer={displayRankMovement}
          currentQuestionId={currentQuestionId}
          showRankMovement={(room?.currentQuestionIndex ?? 0) > 0}
          resultLabel={`نتائج السؤال ${questionNumber} · أفضل ${RESULTS_LEADERBOARD_LIMIT}`}
          answerCorrectByPlayer={sanitizedDisplayCorrect}
          answeredPlayerIds={displayAnswered}
          freezeLayout={freezeLayout}
        />
      </div>
      <div className="results-messages-area">
        <DisplaySidePanel messages={messages} videoEnabled={videoEnabled} />
      </div>
    </div>
  );
}

function buildPreviewResultsSnapshot({ questionList = [], questionIndex = -1, players = [], allAnswers = [] }) {
  const question = questionList[questionIndex];
  const questionId = question?.questionId || question?.id || null;
  if (!questionId || questionIndex < 0) return null;

  const questionIdsUntilCurrent = new Set(
    questionList
      .slice(0, questionIndex + 1)
      .map((item) => item?.questionId || item?.id)
      .filter(Boolean)
      .map(String)
  );
  const questionIdsBeforeCurrent = new Set(
    questionList
      .slice(0, questionIndex)
      .map((item) => item?.questionId || item?.id)
      .filter(Boolean)
      .map(String)
  );

  const validAnswers = (allAnswers || []).filter((answer) => answer?.playerId && answer?.questionId);
  const currentAnswers = validAnswers.filter((answer) => isValidPlayerAnswerForQuestion(answer, questionId));
  const answersBefore = validAnswers.filter((answer) => questionIdsBeforeCurrent.has(String(answer.questionId)));
  const answersUntilCurrent = validAnswers.filter((answer) => questionIdsUntilCurrent.has(String(answer.questionId)));

  const scoreByPlayerBefore = {};
  const scoreByPlayerAfter = {};
  answersBefore.forEach((answer) => {
    scoreByPlayerBefore[answer.playerId] = Number(scoreByPlayerBefore[answer.playerId] || 0) + Number(answer.points || 0);
  });
  answersUntilCurrent.forEach((answer) => {
    scoreByPlayerAfter[answer.playerId] = Number(scoreByPlayerAfter[answer.playerId] || 0) + Number(answer.points || 0);
  });

  const bonusByPlayer = {};
  const correctByPlayer = {};
  const answeredByPlayer = {};
  currentAnswers.forEach((answer) => {
    answeredByPlayer[answer.playerId] = true;
    bonusByPlayer[answer.playerId] = Number(answer.points || 0);
    correctByPlayer[answer.playerId] = !!answer.isCorrect;
  });

  const snapshotPlayer = (player, score, currentAnswer = null) => ({
    id: player.id,
    name: player.name || "",
    emoji: player.emoji || "",
    score: Number(score || 0),
    jokerUsed: player.jokerUsed || false,
    jokerQuestionId: player.jokerQuestionId || null,
    jokerMultiplier: player.jokerMultiplier || null,
    lastQuestionId: currentAnswer ? questionId : null,
    lastQuestionPoints: currentAnswer ? Number(currentAnswer.points || 0) : 0,
    lastQuestionCorrect: currentAnswer ? !!currentAnswer.isCorrect : null,
  });

  const sortedBefore = [...players]
    .filter((player) => !isVisitorRecord(player))
    .map((player) => snapshotPlayer(player, scoreByPlayerBefore[player.id] || 0))
    .sort((a, b) => Number(b.score || 0) - Number(a.score || 0));

  const currentAnswerByPlayer = new Map(currentAnswers.map((answer) => [answer.playerId, answer]));
  const sortedAfter = [...players]
    .filter((player) => !isVisitorRecord(player))
    .map((player) => snapshotPlayer(player, scoreByPlayerAfter[player.id] || 0, currentAnswerByPlayer.get(player.id) || null))
    .sort((a, b) => Number(b.score || 0) - Number(a.score || 0));

  const beforeRankByPlayer = {};
  sortedBefore.forEach((player, index) => {
    beforeRankByPlayer[player.id] = index + 1;
  });

  const rankMovementByPlayer = {};
  sortedAfter.forEach((player, index) => {
    rankMovementByPlayer[player.id] = (beforeRankByPlayer[player.id] || index + 1) - (index + 1);
  });

  return {
    questionId,
    leaderboardBefore: sortedBefore.slice(0, RESULTS_LEADERBOARD_LIMIT),
    leaderboardAfter: sortedAfter.slice(0, RESULTS_LEADERBOARD_LIMIT),
    bonusByPlayer,
    correctByPlayer,
    answeredByPlayer,
    rankMovementByPlayer,
    calculatedAtMs: getNow(),
  };
}

function FinalCountdownDisplay({ room }) {
  const now = useNow(120);
  const remaining = Math.max(0, Math.ceil((Number(room?.finalCountdownUntilMs || 0) - now) / 1000));
  const displayNumber = remaining || 1;

  return (
    <div className="display-panel final-countdown-screen">
      <span>استعدوا لإعلان الفائزين</span>
      <strong key={displayNumber}>{displayNumber}</strong>
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

function createEmptyVoteChoice() {
  return { category: "", text: "", type: "multiple_choice", options: ["", ""], correctIndex: 0 };
}

function QuestionSettings({ questions, room = null, questionPackages = [], allQuestions = [], embedded = false }) {
  const [editingId, setEditingId] = useState(null);
  const [showForm, setShowForm] = useState(false);
  const [type, setType] = useState("multiple_choice");
  const [text, setText] = useState("");
  const [category, setCategory] = useState(DEFAULT_QUESTION_CATEGORY);
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
  const [voteEnabled, setVoteEnabled] = useState(false);
  const [voteChoices, setVoteChoices] = useState([createEmptyVoteChoice(), createEmptyVoteChoice()]);
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
  // Kept only so older category-group markup remains unreachable while old saved data migrates safely.
  const categoryVotingEnabled = false;
  const categoryGroups = [];
  const activePackageItem = availableQuestionPackages.find((item) => item.id === activePackageId) || {
    id: activePackageId,
    name: activePackageName,
  };

  function resetForm() {
    setEditingId(null);
    setShowForm(false);
    setType("multiple_choice");
    setText("");
    setCategory(DEFAULT_QUESTION_CATEGORY);
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
    setVoteEnabled(false);
    setVoteChoices([createEmptyVoteChoice(), createEmptyVoteChoice()]);
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
    setCategory(getQuestionCategory(question));
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
    setVoteEnabled(isVotingQuestion(question));
    setVoteChoices(isVotingQuestion(question)
      ? question.voteChoices.map((choice) => ({
          category: choice.category || "",
          text: choice.text || "",
          type: "multiple_choice",
          options: choice.options?.length ? choice.options.map(getOptionText) : ["", ""],
          correctIndex: Number(choice.correctIndex || 0),
        }))
      : [createEmptyVoteChoice(), createEmptyVoteChoice()]);
  }

  function updateVoteChoice(choiceIndex, updates) {
    setVoteChoices((current) => current.map((choice, index) => index === choiceIndex ? { ...choice, ...updates } : choice));
  }

  function updateVoteChoiceOption(choiceIndex, optionIndex, value) {
    const nextOptions = [...voteChoices[choiceIndex].options];
    nextOptions[optionIndex] = value;
    updateVoteChoice(choiceIndex, { options: nextOptions });
  }

  function addVoteChoiceOption(choiceIndex) {
    updateVoteChoice(choiceIndex, { options: [...voteChoices[choiceIndex].options, ""] });
  }

  function removeVoteChoiceOption(choiceIndex, optionIndex) {
    const choice = voteChoices[choiceIndex];
    if (choice.options.length <= 2) return;
    const nextOptions = choice.options.filter((_, index) => index !== optionIndex);
    const nextCorrectIndex = choice.correctIndex === optionIndex ? 0 : choice.correctIndex > optionIndex ? choice.correctIndex - 1 : choice.correctIndex;
    updateVoteChoice(choiceIndex, { options: nextOptions, correctIndex: nextCorrectIndex });
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
    const cleanCategory = category.trim() || DEFAULT_QUESTION_CATEGORY;
    const cleanMediaUrl = mediaUrl.trim();
    const cleanImageUrl = imageUrl.trim();
    const cleanOptionImageUrls = optionImageUrls.map((url) => url.trim());
    const cleanOptions = options.map((o, index) => ({ text: o.trim(), imageUrl: cleanOptionImageUrls[index] || "" })).filter((item) => item.text || item.imageUrl);

    const cleanVoteChoices = voteChoices.map((choice) => ({
      category: choice.category.trim(),
      text: choice.text.trim(),
      type: "multiple_choice",
      options: choice.options.map((option) => option.trim()).filter(Boolean),
      correctIndex: Number(choice.correctIndex),
    }));

    if (voteEnabled && voteChoices.some((choice, index) =>
      !cleanVoteChoices[index].category ||
      !cleanVoteChoices[index].text ||
      choice.options.length < 2 ||
      choice.options.some((option) => !option.trim()) ||
      choice.correctIndex < 0 ||
      choice.correctIndex >= choice.options.length
    )) {
      alert("أكمل التصنيفين، واكتب سؤالًا وخيارين على الأقل وحدد الإجابة الصحيحة لكل تصنيف.");
      return;
    }

    if (voteEnabled && cleanVoteChoices[0].category === cleanVoteChoices[1].category) {
      alert("اكتب اسمين مختلفين للتصنيفين.");
      return;
    }

    if (!voteEnabled && (!cleanText || cleanOptions.length < 2)) {
      alert("اكتب السؤال وخيارين على الأقل.");
      return;
    }

    if (!voteEnabled && type === "image" && !cleanImageUrl && !cleanOptions.some((item) => item.imageUrl)) {
      alert("ضع صورة للسؤال أو صورة لواحد من الخيارات على الأقل.");
      return;
    }

    if (!voteEnabled && (type === "audio" || type === "video") && !cleanMediaUrl) {
      alert(type === "video" ? "ضع رابط مقطع الفيديو." : "ضع رابط المقطع الصوتي.");
      return;
    }

    if (!voteEnabled && (correctIndex < 0 || correctIndex >= cleanOptions.length)) {
      alert("اختر الإجابة الصحيحة.");
      return;
    }

    setSaving(true);

    const payload = {
      type: voteEnabled ? "multiple_choice" : type,
      text: voteEnabled ? cleanVoteChoices.map((choice) => choice.category).join(" أو ") : cleanText,
      category: cleanCategory,
      mediaUrl: type === "audio" || type === "video" ? cleanMediaUrl : "",
      audioUrl: type === "audio" ? cleanMediaUrl : "",
      videoUrl: type === "video" ? cleanMediaUrl : "",
      imageUrl: type === "image" ? cleanImageUrl : "",
      optionImageUrls: cleanOptions.map((item) => item.imageUrl || ""),
      options: voteEnabled ? cleanVoteChoices[0].options : cleanOptions.map((item) => item.text || "صورة"),
      correctIndex: voteEnabled ? cleanVoteChoices[0].correctIndex : Number(correctIndex),
      maxPoints: Number(maxPoints),
      minPoints: Number(minPoints),
      seconds: Number(seconds),
      answerRevealDelaySeconds: Number(answerRevealDelaySeconds),
      isPractice: !!isPractice,
      voteEnabled: !!voteEnabled,
      voteChoices: voteEnabled ? cleanVoteChoices : [],
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

          <div className="question-vote-type-picker">
            <strong>طريقة تقديم هذه الجولة</strong>
            <div className="questions-mode-segmented">
              <button type="button" className={`questions-mode-option${!voteEnabled ? " active" : ""}`} onClick={() => setVoteEnabled(false)}>سؤال عادي</button>
              <button type="button" className={`questions-mode-option${voteEnabled ? " active" : ""}`} onClick={() => setVoteEnabled(true)}>تصويت بين تصنيفين</button>
            </div>
          </div>

          {voteEnabled ? (
            <div className="vote-choices-editor">
              <p className="muted">اكتب تصنيفين، ثم جهّز سؤال الاختيار من متعدد الذي سيظهر إذا فاز كل تصنيف.</p>
              {voteChoices.map((choice, choiceIndex) => (
                <section className="vote-choice-editor" key={choiceIndex}>
                  <h3>التصنيف {choiceIndex + 1}</h3>
                  <label>اسم التصنيف</label>
                  <input value={choice.category} onChange={(event) => updateVoteChoice(choiceIndex, { category: event.target.value })} placeholder={choiceIndex === 0 ? "مثال: تاريخ" : "مثال: رياضة"} />
                  <label>سؤال هذا التصنيف</label>
                  <textarea value={choice.text} onChange={(event) => updateVoteChoice(choiceIndex, { text: event.target.value })} placeholder="اكتب السؤال هنا" />
                  <label>الإجابات</label>
                  <div className="options-editor">
                    {choice.options.map((option, optionIndex) => (
                      <div className="option-editor-row vote-option-row" key={optionIndex}>
                        <input value={option} onChange={(event) => updateVoteChoiceOption(choiceIndex, optionIndex, event.target.value)} placeholder={`الإجابة ${optionIndex + 1}`} />
                        <label className="radio-label">
                          <input type="radio" name={`vote-correct-${choiceIndex}`} checked={choice.correctIndex === optionIndex} onChange={() => updateVoteChoice(choiceIndex, { correctIndex: optionIndex })} />
                          الصحيحة
                        </label>
                        {choice.options.length > 2 && <button type="button" className="danger small-button" onClick={() => removeVoteChoiceOption(choiceIndex, optionIndex)}>حذف</button>}
                      </div>
                    ))}
                  </div>
                  <button type="button" className="small-button" onClick={() => addVoteChoiceOption(choiceIndex)}>إضافة خيار آخر</button>
                </section>
              ))}
            </div>
          ) : <>
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
          </>}

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
        ) : categoryVotingEnabled ? (
          <div className="category-groups-view">
            <div className="category-groups-summary">
              <span><strong>{categoryGroups.length}</strong> تصنيف</span>
              <span><strong>{mainQuestionRows.length}</strong> سؤال</span>
            </div>
            {categoryGroups.map(({ category: cat, questions: catQs }) => (
              <div key={cat} className="category-group-card">
                <div className="category-group-header">
                  <strong className="category-group-name">{cat}</strong>
                  <span className="category-group-count">{catQs.length} سؤال</span>
                  {catQs.length < 3 && <span className="category-group-warning">⚠ أسئلة قليلة</span>}
                  <button type="button" className="small-button" onClick={(e) => { e.stopPropagation(); startCreate(false); setCategory(cat); }}>+ إضافة</button>
                </div>
                <div className="category-group-questions">
                  {catQs.map((q) => (
                    <Fragment key={q.id}>
                      <div
                        className={`category-question-card${expandedQuestionId === q.id ? " expanded" : ""}`}
                        onClick={() => setExpandedQuestionId(expandedQuestionId === q.id ? null : q.id)}
                      >
                        <div className="category-question-card-body">
                          <strong className="category-question-card-text">{q.text}</strong>
                          <div className="category-question-card-tags">
                            <span>{getQuestionTypeLabel(q.type)}</span>
                            <span>{q.minPoints || 100}–{q.maxPoints || 1000} نقطة</span>
                            <span>{q.seconds || 20} ث إجابة</span>
                          </div>
                        </div>
                        <div className="question-admin-card-actions">
                          <button className="icon-action-button" title="تعديل" onClick={(e) => { e.stopPropagation(); startEdit(q); }}>✎</button>
                          <button className="danger icon-action-button" title="حذف" onClick={(e) => { e.stopPropagation(); deleteQuestion(q.id); }}>×</button>
                        </div>
                      </div>
                      {expandedQuestionId === q.id && (
                        <div className="question-inline-details category-question-card-details">
                          <span>نوع السؤال <b>{getQuestionTypeLabel(q.type)}</b></span>
                          <span>النقاط <b>{q.minPoints || 100} - {q.maxPoints || 1000}</b></span>
                          <span>وقت الإجابة <b>{q.seconds || 20} ثانية</b></span>
                          <span>ظهور الخيارات <b>{q.answerRevealDelaySeconds ?? 3} ثانية</b></span>
                          <span className="question-detail-wide">الإجابة الصحيحة <b>{getOptionText(q.options?.[q.correctIndex]) || "—"}</b></span>
                          <span className="question-detail-wide">الخيارات <b>{(q.options || []).map(getOptionText).join(" | ")}</b></span>
                          {getQuestionMediaUrl(q) && <span className="question-detail-wide">رابط الوسائط <b>{getQuestionMediaUrl(q)}</b></span>}
                          {getQuestionImageUrl(q) && <img className="question-inline-image" src={getQuestionImageUrl(q)} alt="صورة السؤال" />}
                        </div>
                      )}
                    </Fragment>
                  ))}
                </div>
              </div>
            ))}
          </div>
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
                    <td><button type="button" className="question-title-button"><strong>{getQuestionDisplayText(q)}</strong>{isVotingQuestion(q) && <span className="question-vote-chip">تصويت</span>}{q.isPractice && <span className="question-practice-chip">سؤال تجريبي</span>}</button></td>
                    <td>{q.isPractice ? "سؤال تجريبي" : isVotingQuestion(q) ? "تصويت بين تصنيفين" : getQuestionTypeLabel(q.type)}</td>
                    <td>{q.minPoints || 100} - {q.maxPoints || 1000}</td>
                    <td>{q.seconds || 20} ث</td>
                    <td>{q.answerRevealDelaySeconds ?? 3} ث</td>
                  </tr>
                  {expandedQuestionId === q.id && (
                    <tr className="question-details-row">
                      <td colSpan="7">
                        <div className="question-inline-details">
                          <span>نوع السؤال <b>{isVotingQuestion(q) ? "تصويت بين تصنيفين" : getQuestionTypeLabel(q.type)}</b></span>
                          <span>النقاط <b>{q.minPoints || 100} - {q.maxPoints || 1000}</b></span>
                          <span>وقت الإجابة <b>{q.seconds || 20} ثانية</b></span>
                          <span>ظهور الخيارات <b>{q.answerRevealDelaySeconds ?? 3} ثانية</b></span>
                          {isVotingQuestion(q) ? q.voteChoices.map((choice, choiceIndex) => (
                            <div className="question-detail-wide vote-question-summary" key={choiceIndex}>
                              <strong>{choice.category}</strong>
                              <span>{choice.text}</span>
                              <small>الإجابة الصحيحة: {getOptionText(choice.options?.[choice.correctIndex]) || "—"}</small>
                            </div>
                          )) : <>
                            <span className="question-detail-wide">الإجابة الصحيحة <b>{getOptionText(q.options?.[q.correctIndex]) || "—"}</b></span>
                            <span className="question-detail-wide">الخيارات <b>{(q.options || []).map(getOptionText).join(" | ")}</b></span>
                          </>}
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

        {categoryVotingEnabled && (
          <p className="practice-vote-note">الأسئلة التجريبية تسير بالترتيب دائمًا ولا تشارك في تصويت التصنيف.</p>
        )}
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

function BroadcastQuestionCard({ question, label, variant = "default", compact = false }) {
  const votingRound = isVotingQuestion(question);
  const selectedVoteCategory = question?.selectedVoteCategory || null;

  return (
    <article className={`broadcast-question-card ${variant}${votingRound ? " is-vote" : ""}`}>
      <header className="broadcast-question-card-head">
        <span>{label}</span>
        <div>
          {question ? <b>{votingRound ? "تصويت" : getQuestionTypeLabel(question.type)}</b> : <b>لا يوجد</b>}
          {selectedVoteCategory && <em>فاز: {selectedVoteCategory}</em>}
        </div>
      </header>

      {!question ? (
        <p className="broadcast-empty-question">لا توجد جولة في هذا الموضع.</p>
      ) : votingRound ? (
        <div className="broadcast-vote-round-preview">
          <strong>{getQuestionDisplayText(question)}</strong>
          <div className="broadcast-vote-choice-grid">
            {question.voteChoices.map((choice, index) => (
              <div className={`broadcast-vote-choice category-tone-${index % 4}`} key={`${question.id || "vote"}-${index}`}>
                <span>{choice.category}</span>
                <b>{choice.text}</b>
                <small>الصحيحة: {getOptionText(choice.options?.[choice.correctIndex]) || "—"}</small>
              </div>
            ))}
          </div>
        </div>
      ) : (
        <div className="broadcast-standard-question">
          <strong>{question.text || "سؤال بلا نص"}</strong>
          <div className="broadcast-question-meta">
            <span className="broadcast-category-chip">{selectedVoteCategory || getQuestionCategory(question)}</span>
            <span>{question.seconds || 20} ثانية</span>
          </div>
          {!compact && question.options?.length > 0 && (
            <div className="broadcast-answer-grid">
              {question.options.map((option, index) => (
                <div className={index === Number(question.correctIndex || 0) ? "correct" : ""} key={`${question.id || question.questionId || "question"}-${index}`}>
                  <span>{String.fromCharCode(65 + index)}</span>
                  <b>{getOptionText(option)}</b>
                  {index === Number(question.correctIndex || 0) && <em>صحيحة</em>}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </article>
  );
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
  const adminAdvancingRef = useRef(false);
  const [isAdminSkipping, setIsAdminSkipping] = useState(false);
  const [showAdminEmergencySkip, setShowAdminEmergencySkip] = useState(false);
  const [testModeWorking, setTestModeWorking] = useState(false);
  const [testModeMsg, setTestModeMsg] = useState(null);
  const [quickControlsOpen, setQuickControlsOpen] = useState(false);
  const [selectedPrizeWinnerByPrize, setSelectedPrizeWinnerByPrize] = useState({});
  const [excludePrizeWinners, setExcludePrizeWinners] = useState(true);
  const [isPrizeAddOpen, setIsPrizeAddOpen] = useState(false);
  const [newPrizeTitle, setNewPrizeTitle] = useState("");
  const [expandedPrizeItems, setExpandedPrizeItems] = useState({});
  const [liveExpandedSections, setLiveExpandedSections] = useState({
    players: true,
    questionStats: false,
    playerStats: false,
  });
  const mainQuestions = getMainQuestions(questions);
  const practiceQuestions = getPracticeQuestions(questions);
  const competitionQuestions = mainQuestions;
  const competitionAnswers = allAnswers.filter((answer) => !answer.isPractice);

  const answersByQuestion = competitionQuestions.map((question, index) => {
    const rows = competitionAnswers
      .filter((answer) => answer.questionId === question.id || answer.questionId === question.questionId)
      .map((answer) => {
        const player = players.find((p) => p.id === answer.playerId);
        return { question, questionNumber: index + 1, answer, player, selectedText: getSelectedAnswerText(question, answer) };
      });
    return { question, questionNumber: index + 1, rows };
  });

  const sortedWinners = [...players].sort((a, b) => (b.score || 0) - (a.score || 0)).slice(0, 3);
  const nextAdminQuestion = room?.practiceMode
    ? practiceQuestions[currentQuestionIndex + 1] || (currentQuestionIndex < 0 ? practiceQuestions[0] : null)
    : competitionQuestions[currentQuestionIndex + 1] || (currentQuestionIndex < 0 ? competitionQuestions[0] : null);
  const previousAdminQuestion = currentQuestionIndex > 0
    ? (room?.practiceMode ? practiceQuestions[currentQuestionIndex - 1] : competitionQuestions[currentQuestionIndex - 1])
    : null;
  const registeredCount = players.filter((player) => !isVisitorRecord(player)).length;
  const activeVisitors = visitors.filter((visitor) => Number(visitor.seenAtMs || 0) > adminNow - 120000);
  const openedLinkCount = Math.max(activeVisitors.length, registeredCount);
  const isRegistrationOpenForJoin = stage === "registration" || !!room?.registrationOverrideOpen;
  const adminCurrentQuestionId = room?.currentQuestion?.questionId || room?.currentQuestion?.id || null;
  const adminCurrentProcessed = isSameId(room?.processedQuestionId, adminCurrentQuestionId);
  const currentSkipReport = isSameId(room?.lastSkipReport?.questionId, adminCurrentQuestionId)
    ? room.lastSkipReport
    : null;
  const adminQuestionList = room?.practiceMode ? practiceQuestions : competitionQuestions;
  const nextAdminQuestionNeedsVote = isVotingQuestion(nextAdminQuestion);
  const liveQuestionAnswers = allAnswers.filter((answer) => isSameId(answer.questionId, adminCurrentQuestionId));
  const liveAnsweredPlayerIds = new Set(liveQuestionAnswers.map((answer) => answer.playerId));
  const liveVoteCounts = getCategoryVoteCounts(room?.categoryVote || {});
  const liveVoteTotal = Object.values(liveVoteCounts).reduce((total, count) => total + Number(count || 0), 0);
  const liveVoteTieLabels = stage === "categoryVote" ? getCategoryVoteTieLabels(room?.categoryVote || {}) : [];
  const activeVoteQuestion = stage === "categoryVote"
    ? adminQuestionList.find((question) => isSameId(question.id || question.questionId, room?.categoryVote?.questionId)) || nextAdminQuestion
    : null;
  const adminCurrentIsLastQuestion = currentQuestionIndex >= 0 && currentQuestionIndex >= adminQuestionList.length - 1;
  const adminNextQuestionIsLast = currentQuestionIndex + 1 >= adminQuestionList.length - 1;

  useEffect(() => {
    if (stage !== "results" || adminCurrentProcessed) {
      setShowAdminEmergencySkip(false);
      return undefined;
    }
    const timer = setTimeout(() => setShowAdminEmergencySkip(true), 3000);
    return () => clearTimeout(timer);
  }, [stage, adminCurrentProcessed, adminCurrentQuestionId]);
  const prizeWheel = room?.prizeWheel || {};
  const prizeWinners = prizeWheel.winners || [];
  const prizeItems = Array.isArray(prizeWheel.prizeItems)
    ? prizeWheel.prizeItems
    : DEFAULT_PRIZE_ITEMS;
  const activePrizeItemId = prizeWheel.activePrizeItemId || prizeItems[0]?.id || null;
  const eligiblePrizePlayers = getPrizeWheelPlayers(players, { ...prizeWheel, excludePreviousWinners: excludePrizeWinners });
  const liveStageLabel = getAdminStageLabel(stage);
  const liveQuestionModeLabel = room?.practiceMode
    ? "وضع تجريبي"
    : "تصويت محدد لكل سؤال";
  const liveQuestionPoolLabel = room?.practiceMode
    ? `${practiceQuestions.length} أسئلة تجريبية`
    : `${competitionQuestions.length} أسئلة فعلية`;
  const currentQuestionCategory = getQuestionCategory(room?.currentQuestion);
  const nextQuestionCategory = getQuestionCategory(nextAdminQuestion);
  const currentQuestionType = getQuestionTypeLabel(room?.currentQuestion?.type);
  const nextQuestionType = getQuestionTypeLabel(nextAdminQuestion?.type);
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

  async function savePrizeItems(nextItems) {
    await setDoc(doc(db, "rooms", ROOM_ID), {
      prizeWheel: {
        ...prizeWheel,
        prizeItems: nextItems,
        activePrizeItemId: nextItems.some((item) => item.id === activePrizeItemId) ? activePrizeItemId : nextItems[0]?.id || null,
      },
      updatedAt: serverTimestamp(),
    }, { merge: true });
  }

  async function addPrizeItem() {
    const title = newPrizeTitle.trim();
    if (!title) return;
    const nextItems = [...prizeItems, { id: `prize-${getNow()}`, title }];
    await savePrizeItems(nextItems);
    setNewPrizeTitle("");
    setIsPrizeAddOpen(false);
  }

  async function deletePrizeItem(prizeItemId) {
    const nextItems = prizeItems.filter((item) => item.id !== prizeItemId);
    await savePrizeItems(nextItems);
    setSelectedPrizeWinnerByPrize((prev) => {
      const next = { ...prev };
      delete next[prizeItemId];
      return next;
    });
  }

  function togglePrizeItem(prizeItemId) {
    setExpandedPrizeItems((prev) => ({ ...prev, [prizeItemId]: !prev[prizeItemId] }));
  }

  async function openPrizeWheelStage(prizeItem = null, selectedWinnerId = "") {
    const selectedPrizeItem = prizeItem || prizeItems.find((item) => item.id === activePrizeItemId) || prizeItems[0] || null;
    const selectedPrizeTitle = selectedPrizeItem?.title || "جائزة مفاجئة";
    const previousStage = stage === "prizeWheel"
      ? prizeWheel.previousStage || "registration"
      : stage;
    await setDoc(doc(db, "rooms", ROOM_ID), {
      stage: "prizeWheel",
      prizeWheel: {
        ...prizeWheel,
        previousStage,
        prizeItems,
        activePrizeItemId: selectedPrizeItem?.id || null,
        prizeTitle: selectedPrizeTitle,
        excludePreviousWinners: excludePrizeWinners,
        spinning: false,
        winnerPlayerId: null,
        spinId: null,
        selectedPlayerId: selectedWinnerId || null,
        winners: prizeWinners,
      },
      updatedAt: serverTimestamp(),
    }, { merge: true });
  }

  async function spinPrizeWheel(prizeItem = null, selectedWinnerId = "") {
    const selectedPrizeItem = prizeItem || prizeItems.find((item) => item.id === activePrizeItemId) || prizeItems[0] || null;
    await spinPrizeWheelForRoom(room, players, {
      prizeTitle: selectedPrizeItem?.title || "جائزة مفاجئة",
      activePrizeItemId: selectedPrizeItem?.id || null,
      excludePreviousWinners: excludePrizeWinners,
      selectedPlayerId: selectedWinnerId || null,
    });
  }

  async function closePrizeWheelStage() {
    const fallbackStage = prizeWheel.previousStage || "registration";
    await updateDoc(doc(db, "rooms", ROOM_ID), {
      stage: fallbackStage === "prizeWheel" ? "registration" : fallbackStage,
      "prizeWheel.spinning": false,
      updatedAt: serverTimestamp(),
    });
  }

  async function deletePrizeWinner(spinId) {
    if (!spinId) return;
    const nextWinners = prizeWinners.filter((winner) => winner.spinId !== spinId);
    await updateDoc(doc(db, "rooms", ROOM_ID), {
      "prizeWheel.winners": nextWinners,
      updatedAt: serverTimestamp(),
    });
  }

  async function handleAdminCategoryVoteClose({ selectedCategory = null, chooseRandomTie = false } = {}) {
    if (adminAdvancingRef.current) return;
    adminAdvancingRef.current = true;
    setAdminAdvancing(true);
    try {
      const outcome = await resolveCategoryVote(
        room,
        room?.practiceMode ? practiceQuestions : competitionQuestions,
        { selectedCategory, chooseRandomTie }
      );
      if (!outcome.resolved && outcome.reason !== "tie") {
        if (room?.practiceMode) await finishPracticeAndReturnToStart();
        else await finishGame(players, getMainQuestions(questions), allAnswers || [], messages, room);
      }
    } finally {
      adminAdvancingRef.current = false;
      setAdminAdvancing(false);
    }
  }

  async function advanceFromDashboard(question = (room?.practiceMode ? practiceQuestions[currentQuestionIndex + 1] : competitionQuestions[currentQuestionIndex + 1]), questionIndex = currentQuestionIndex + 1) {
    if (isVotingQuestion(question)) {
      if (adminAdvancingRef.current) return;
      adminAdvancingRef.current = true;
      setAdminAdvancing(true);
      try {
        await startCategoryVote(question, room, questionIndex);
      } finally {
        adminAdvancingRef.current = false;
        setAdminAdvancing(false);
      }
      return;
    }
    const nextQuestion = question;
    if (!nextQuestion || adminAdvancingRef.current) return;
    adminAdvancingRef.current = true;
    setAdminAdvancing(true);
    try {
      const readyDelayMs = 3000;
      const readyUntilMs = getNow() + readyDelayMs;
      await preloadQuestionForReady(nextQuestion, questionIndex, readyUntilMs);
      setTimeout(async () => {
        try {
          const activated = await activatePreloadedQuestion(nextQuestion.id || nextQuestion.questionId, questionIndex);
          if (!activated) {
            console.warn("Dashboard question activation was ignored because it was stale.");
          }
        } finally {
          adminAdvancingRef.current = false;
          setAdminAdvancing(false);
        }
      }, readyDelayMs);
    } catch (error) {
      console.error("Failed to advance dashboard question", error);
      adminAdvancingRef.current = false;
      setAdminAdvancing(false);
    }
  }

  async function handleAdminSkipCalculation() {
    if (isAdminSkipping) return;
    const confirmed = window.confirm(
      "تجاوز هذا السؤال بدون نقاط؟\n\n" +
      "• لن تُضاف أو تُخصم أي نقاط.\n" +
      "• لن يتغير ترتيب المتسابقين.\n" +
      "• ستبقى الإجابات محفوظة في التقرير.\n" +
      "• سيتاح الانتقال للسؤال التالي فورًا.\n\n" +
      "استخدم هذا الخيار فقط إذا تعطل الاحتساب."
    );
    if (!confirmed) return;
    setIsAdminSkipping(true);
    const currentAnswersCount = allAnswers.filter(
      (answer) => answer.questionId === adminCurrentQuestionId
    ).length;
    try {
      await skipQuestionCalculation(room, currentAnswersCount, { source: "admin-control" });
    } catch (error) {
      console.error("Admin skip calculation failed:", error);
    } finally {
      setIsAdminSkipping(false);
    }
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
      registrationOverrideOpen: false,
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
    await setDoc(doc(db, "rooms", ROOM_ID), { practiceMode: false, practiceFinished: true, registrationOverrideOpen: false, currentQuestionIndex: -1, usedQuestionIds: {}, updatedAt: serverTimestamp() }, { merge: true });
    if (isVotingQuestion(firstQuestion)) {
      await startCategoryVote(firstQuestion, room, 0);
    } else {
      await advanceFromDashboard(firstQuestion, 0);
    }
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
            getSelectedAnswerText(question, answer),
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
            <strong><QuizTitleMark compact /></strong>
            <small>{QUIZ_SUBTITLE}</small>
          </div>
        </div>
        <nav className="dashboard-nav">
          <div className="dashboard-nav-group">
            <span>تشغيل</span>
            <button type="button" className={activeAdminSection === "live" ? "active" : ""} onClick={() => openAdminSection("live")}>متابعة البث</button>
            <button type="button" className={activeAdminSection === "prizes" ? "active" : ""} onClick={() => openAdminSection("prizes")}>سحب الجوائز</button>
            <button type="button" className={activeAdminSection === "players" ? "active" : ""} onClick={() => openAdminSection("players")}>المتسابقون</button>
          </div>
          <div className="dashboard-nav-group">
            <span>تجهيز</span>
            <button type="button" className={activeAdminSection === "questions" ? "active" : ""} onClick={() => openAdminSection("questions")}>الأسئلة</button>
            <button type="button" className={activeAdminSection === "displaySettings" ? "active" : ""} onClick={() => openAdminSection("displaySettings")}>العرض</button>
            <button type="button" className={activeAdminSection === "setup" ? "active" : ""} onClick={() => openAdminSection("setup")}>تهيئة</button>
          </div>
          <div className="dashboard-nav-group">
            <span>مراجعة</span>
            <button
              type="button"
              className={["analytics", "questionReports", "playerReports"].includes(activeAdminSection) ? "active" : ""}
              onClick={() => openAdminSection("analytics")}
            >
              التقارير والإحصائيات
            </button>
            <button type="button" className={activeAdminSection === "history" ? "active" : ""} onClick={() => openAdminSection("history")}>سجل المسابقات</button>
          </div>
          <div className="dashboard-nav-group muted">
            <span>تجربة</span>
            <button type="button" className={activeAdminSection === "testMode" ? "active" : ""} onClick={() => openAdminSection("testMode")}>وضع الاختبار</button>
          </div>
        </nav>
        <a className="dashboard-display-button" href="/?view=display" target="_blank" rel="noreferrer">فتح صفحة العرض ↗</a>
        <button className="dashboard-export-button" onClick={exportFullExcel}>استخراج Excel شامل</button>
      </aside>

      <main className="dashboard-main">
      <div className="dashboard-main-header">
        <div>
          <span>لوحة الإدارة</span>
          <strong>لوحة التحكم</strong>
        </div>
        <div className="dashboard-header-actions">
          {previousAdminSection && <button type="button" className="dashboard-back-button" onClick={goBackAdminSection}>عودة</button>}
          {activeAdminSection === "live" && quickControlsOpen && (
            <div className="dashboard-broadcast-controls">
              <button
                type="button"
                className="quick-control-toggle"
                onClick={() => setQuickControlsOpen((value) => !value)}
                aria-expanded={quickControlsOpen}
              >
                أزرار احتياطية
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
                  {stage === "question" && isMediaQuestion(room?.currentQuestion) && !hasMediaEnded(room, room.currentQuestion) && <button className="warning-action" onClick={() => finishMediaQuestion(room.currentQuestion)}>تجاوز المقطع وإظهار الخيارات</button>}
                  {stage === "question" && <button onClick={() => endQuestionAndReveal(room, { allowUndo: true })}>إنهاء السؤال وإظهار الإجابة</button>}
                  {stage === "categoryVote" && liveVoteTieLabels.length === 0 && <button onClick={() => handleAdminCategoryVoteClose()} disabled={adminAdvancing}>إغلاق التصويت وتجهيز السؤال</button>}
                  {stage === "categoryVote" && liveVoteTieLabels.length > 1 && (
                    <>
                      <span className="admin-vote-tie-label">التصويت متعادل</span>
                      <button onClick={() => handleAdminCategoryVoteClose({ chooseRandomTie: true })} disabled={adminAdvancing}>اختيار عشوائي</button>
                      {liveVoteTieLabels.map((label) => (
                        <button key={`quick-tie-${label}`} onClick={() => handleAdminCategoryVoteClose({ selectedCategory: label })} disabled={adminAdvancing}>اختيار {label}</button>
                      ))}
                    </>
                  )}
                  {stage === "reveal" && Number(room?.revealUndoUntilMs || 0) > adminNow && getQuestionTimeLeft(room?.currentQuestion, room, adminNow) > 0 && <button className="warning-action" onClick={() => reopenQuestion(room)}>تراجع</button>}
                  {stage === "reveal" && (!room?.practiceMode && adminCurrentIsLastQuestion ? <button onClick={() => beginFinalCountdown(room)}>إعلان الفائزين</button> : <button onClick={() => showResultsFast(room)}>إظهار النتائج</button>)}
                  {stage === "results" && room?.practiceMode && <button className="secondary-action" onClick={launchInstructionsClarityPoll}>تصويت</button>}
                  {stage === "results" && room?.practiceMode && <button className="warning-action" onClick={finishPracticeAndReturnToStart}>إنهاء التجربة</button>}
                  {stage === "results" && (room?.practiceMode ? practiceQuestions[currentQuestionIndex + 1] : competitionQuestions[currentQuestionIndex + 1]) && <button onClick={advanceFromDashboard} disabled={adminAdvancing || !adminCurrentProcessed}>{!adminCurrentProcessed ? "جاري احتساب النتائج..." : adminAdvancing ? "استعدوا..." : (nextAdminQuestionNeedsVote ? "تصويت السؤال التالي" : (adminNextQuestionIsLast ? "السؤال الأخير" : "السؤال التالي"))}</button>}
                  {stage !== "home" && stage !== "finished" && <button className="secondary-action" onClick={() => launchSystemCheck()}>استفتاء</button>}
                  {stage !== "home" && stage !== "finished" && <button className="danger" onClick={() => { if (window.confirm("هل تريد إنهاء المسابقة الآن؟")) finishGame(players, questions, allAnswers || [], messages, room); }}>إنهاء المسابقة الآن</button>}
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {activeAdminSection === "live" && <div className="broadcast-console-v2">
        <div className="broadcast-top-cluster">
          <section className="broadcast-status-bar" aria-label="حالة البث الآن">
          <div className="broadcast-status-primary">
            <span className="broadcast-live-dot" aria-hidden="true" />
            <small>المرحلة الحالية</small>
            <strong>{liveStageLabel}</strong>
          </div>
          <div>
            <small>{stage === "categoryVote" ? "الأصوات" : stage === "question" ? "الوقت المتبقي" : "رقم الجولة"}</small>
            <strong>{stage === "categoryVote" ? `${liveVoteTotal} / ${registeredCount}` : stage === "question" ? `${getQuestionTimeLeft(room?.currentQuestion, room, adminNow)} ث` : currentQuestionIndex >= 0 ? `${currentQuestionIndex + 1} / ${adminQuestionList.length}` : "—"}</strong>
          </div>
          <div>
            <small>المتسابقون</small>
            <strong>{registeredCount}</strong>
          </div>
          <div>
            <small>التسجيل</small>
            <strong className={isRegistrationOpenForJoin ? "status-open" : "status-closed"}>{isRegistrationOpenForJoin ? "مفتوح" : "مغلق"}</strong>
          </div>
          </section>

          <section className="broadcast-control-panel">
            <div className="broadcast-section-heading">
              <div><span>التحكم المباشر</span><h2>الإجراء المطلوب الآن</h2></div>
              <small>{room?.practiceMode ? "جولة تجريبية" : "المسابقة الفعلية"}</small>
            </div>
            <div className="broadcast-primary-actions">
            {stage === "home" && <button onClick={resetAndStartRegistration}>فتح التسجيل</button>}
            {stage === "registration" && !room?.practiceFinished && <button onClick={showInstructionsPage} disabled={players.length === 0}>عرض معلومات المسابقة</button>}
            {stage === "registration" && room?.practiceFinished && <button onClick={startRealCompetition} disabled={adminAdvancing || competitionQuestions.length === 0 || players.length === 0}>{adminAdvancing ? "جاري البدء..." : "ابدأ المسابقة"}</button>}
            {stage === "instructions" && practiceQuestions.length > 0 && <button className="secondary-action" onClick={startPracticeQuestions} disabled={adminAdvancing || players.length === 0}>بدء التجربة</button>}
            {stage === "instructions" && <button onClick={startRealCompetition} disabled={adminAdvancing || competitionQuestions.length === 0 || players.length === 0}>{adminAdvancing ? "جاري البدء..." : "ابدأ المسابقة"}</button>}
            {stage === "practiceComplete" && <button onClick={startRealCompetition} disabled={adminAdvancing || competitionQuestions.length === 0 || players.length === 0}>ابدأ المسابقة الفعلية</button>}
            {stage === "categoryVote" && liveVoteTieLabels.length === 0 && <button onClick={() => handleAdminCategoryVoteClose()} disabled={adminAdvancing}>{adminAdvancing ? "جاري تجهيز السؤال..." : "إغلاق التصويت وإظهار سؤال الفائز"}</button>}
            {stage === "categoryVote" && liveVoteTieLabels.length > 1 && (
              <div className="broadcast-vote-tie-actions">
                <strong>التصويت متعادل</strong>
                <button type="button" className="tie-random-button" onClick={() => handleAdminCategoryVoteClose({ chooseRandomTie: true })} disabled={adminAdvancing}>اختيار عشوائي</button>
                {liveVoteTieLabels.map((label) => (
                  <button type="button" className="secondary-action" key={`admin-tie-${label}`} onClick={() => handleAdminCategoryVoteClose({ selectedCategory: label })} disabled={adminAdvancing}>اختيار {label}</button>
                ))}
              </div>
            )}
            {stage === "question" && <button onClick={() => endQuestionAndReveal(room, { allowUndo: true })}>إنهاء الوقت وكشف الإجابة</button>}
            {stage === "question" && <button className="secondary-action" onClick={() => extendQuestionTime(room, 10)}>+10 ثوانٍ</button>}
            {stage === "question" && isMediaQuestion(room?.currentQuestion) && !hasMediaEnded(room, room.currentQuestion) && <button className="secondary-action" onClick={() => finishMediaQuestion(room.currentQuestion)}>تجاوز المقطع</button>}
            {stage === "reveal" && (!room?.practiceMode && adminCurrentIsLastQuestion ? <button onClick={() => beginFinalCountdown(room)}>إعلان الفائزين</button> : <button onClick={() => showResultsFast(room)}>إظهار النتائج</button>)}
            {stage === "reveal" && Number(room?.revealUndoUntilMs || 0) > adminNow && getQuestionTimeLeft(room?.currentQuestion, room, adminNow) > 0 && <button className="secondary-action" onClick={() => reopenQuestion(room)}>تراجع عن الكشف</button>}
            {stage === "results" && (room?.practiceMode ? practiceQuestions[currentQuestionIndex + 1] : competitionQuestions[currentQuestionIndex + 1]) && <button onClick={advanceFromDashboard} disabled={adminAdvancing || !adminCurrentProcessed}>{!adminCurrentProcessed ? "جاري احتساب النتائج..." : nextAdminQuestionNeedsVote ? "بدء تصويت الجولة التالية" : adminNextQuestionIsLast ? "عرض السؤال الأخير" : "عرض السؤال التالي"}</button>}
            {stage === "results" && room?.practiceMode && <button className="secondary-action" onClick={finishPracticeAndReturnToStart}>إنهاء التجربة</button>}
            {stage === "finished" && <span className="broadcast-finished-label">انتهت المسابقة — راجع النتائج من قسم التقارير.</span>}
            </div>
          </section>
        </div>

        {stage === "results" && !adminCurrentProcessed && showAdminEmergencySkip && (
          <section className="broadcast-emergency-skip" aria-label="أداة تجاوز احتساب النتائج">
            <div>
              <strong>هل احتساب النتائج متعطل؟</strong>
              <span>استخدم التجاوز فقط بعد التأكد أن إعادة المحاولة لم تنجح.</span>
            </div>
            <button type="button" onClick={handleAdminSkipCalculation} disabled={isAdminSkipping}>
              {isAdminSkipping ? "جاري التجاوز..." : "تجاوز السؤال بدون نقاط"}
            </button>
          </section>
        )}

        {currentSkipReport && (
          <section className="broadcast-skip-report" role="status" aria-live="polite">
            <div className="broadcast-skip-report-title">
              <span>تقرير التجاوز</span>
              <div>
                <strong>تم تجاوز السؤال {currentSkipReport.questionNumber || currentQuestionIndex + 1}</strong>
                <small>{currentSkipReport.questionText}</small>
              </div>
            </div>
            <div className="broadcast-skip-report-facts">
              <span><b>{currentSkipReport.answersCount || 0}</b> إجابة محفوظة</span>
              <span><b>0</b> تغيير في النقاط</span>
              <span><b>ثابت</b> ترتيب المتسابقين</span>
              <span><b>متاح</b> السؤال التالي</span>
            </div>
            <small className="broadcast-skip-report-time">
              {currentSkipReport.skippedAtMs ? new Date(currentSkipReport.skippedAtMs).toLocaleTimeString("ar-SA", { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : ""}
            </small>
          </section>
        )}

        {stage === "categoryVote" && activeVoteQuestion ? (
          <section className="broadcast-live-vote-panel">
            <div className="broadcast-section-heading">
              <div><span>تصويت مباشر</span><h2>{getQuestionDisplayText(activeVoteQuestion)}</h2></div>
              <small>{liveVoteTotal} صوت</small>
            </div>
            <div className="broadcast-live-vote-grid">
              {activeVoteQuestion.voteChoices.map((choice, index) => {
                const count = Number(liveVoteCounts[choice.category] || 0);
                const percent = liveVoteTotal ? Math.round((count / liveVoteTotal) * 100) : 0;
                return <div className={`broadcast-live-vote-choice category-tone-${index % 4}`} key={`${activeVoteQuestion.id || "live-vote"}-${index}`}>
                  <div><span>{choice.category}</span><strong>{count}</strong></div>
                  <i><b style={{ width: `${percent}%` }} /></i>
                  <p>{choice.text}</p>
                  <small>الإجابة: {getOptionText(choice.options?.[choice.correctIndex]) || "—"}</small>
                </div>;
              })}
            </div>
          </section>
        ) : (
          <section className={`broadcast-question-focus-grid${room?.currentQuestion ? "" : " single-card"}`}>
            {room?.currentQuestion && <BroadcastQuestionCard question={room.currentQuestion} label="المعروض الآن" variant="current" />}
            <BroadcastQuestionCard question={nextAdminQuestion} label="الجولة التالية" variant="next" compact={!isVotingQuestion(nextAdminQuestion)} />
          </section>
        )}

        {players.length > 0 && <section className="broadcast-participants-panel">
          <div className="broadcast-section-heading">
            <div><span>متابعة سريعة</span><h2>المتسابقون</h2></div>
            <small>{adminCurrentQuestionId ? `${liveQuestionAnswers.length} أجابوا من ${registeredCount}` : `${registeredCount} مسجلين`}</small>
          </div>
          {players.length === 0 ? <p className="broadcast-empty-question">لا يوجد متسابقون حتى الآن.</p> : (
            <div className="broadcast-participant-grid">
              {[...players].sort((a, b) => Number(b.score || 0) - Number(a.score || 0)).map((player) => (
                <div className={`broadcast-participant${adminCurrentQuestionId && liveAnsweredPlayerIds.has(player.id) ? " answered" : ""}`} key={player.id}>
                  <span>{player.emoji || "👤"}</span>
                  <div><strong>{player.name}</strong><small>{adminCurrentQuestionId ? (liveAnsweredPlayerIds.has(player.id) ? "أجاب" : "بانتظار الإجابة") : "مسجل"}</small></div>
                  <b>{player.score || 0}</b>
                  {player.pendingJoker && <em title="الجوكر مفعل">🃏</em>}
                </div>
              ))}
            </div>
          )}
        </section>}

        {stage !== "registration" && stage !== "home" && stage !== "finished" && (
          <div className="broadcast-secondary-tools">
            <button type="button" onClick={() => setTemporaryRegistrationOpen(!room?.registrationOverrideOpen)}>{room?.registrationOverrideOpen ? "إغلاق التسجيل المؤقت" : "فتح التسجيل للمتأخرين"}</button>
            <button type="button" onClick={() => openAdminSection("analytics")}>فتح التقارير التفصيلية</button>
          </div>
        )}
      </div>}

      {activeAdminSection === "live" && liveExpandedSections.legacy && <div className="dashboard-live-workspace">
      <section className="live-command-strip" aria-label="ملخص متابعة البث">
        <div className="live-command-card live-command-card-stage">
          <span>مرحلة البث</span>
          <strong>{liveStageLabel}</strong>
          <small>{stage === "question" ? `${getQuestionTimeLeft(room?.currentQuestion, room, adminNow)} ثانية متبقية` : "متابعة مباشرة"}</small>
        </div>
        <div className="live-command-card live-command-card-mode">
          <span>وضع الأسئلة</span>
          <strong>{liveQuestionModeLabel}</strong>
          <small>{liveQuestionPoolLabel}</small>
        </div>
        <div className="live-command-card live-command-card-current">
          <span>السؤال الحالي</span>
          <strong>{room?.currentQuestion ? currentQuestionType : "غير معروض"}</strong>
          <small>{room?.currentQuestion ? currentQuestionCategory : "لا يوجد تصنيف"}</small>
        </div>
        <div className="live-command-card live-command-card-next">
          <span>الجاهز بعده</span>
          <strong>{nextAdminQuestion ? nextQuestionType : "لا يوجد"}</strong>
          <small>{nextAdminQuestion ? nextQuestionCategory : "نهاية القائمة"}</small>
        </div>
      </section>
      <section className="live-registration-mini" aria-label="جاهزية التسجيل">
        <div className="live-registration-mini-title">
          <span className={isRegistrationOpenForJoin ? "registration-state open" : "registration-state closed"}>
            {isRegistrationOpenForJoin ? "التسجيل مفتوح" : "التسجيل مغلق"}
          </span>
          <strong>جاهزية التسجيل</strong>
        </div>
        <p><b>{openedLinkCount}</b><small>فتحوا الرابط</small></p>
        <p><b>{registeredCount}</b><small>مسجلين</small></p>
        {stage !== "registration" && stage !== "home" && stage !== "finished" && !room?.registrationOverrideOpen && (
          <button
            type="button"
            className="reopen-registration-button"
            onClick={() => {
              if (window.confirm("فتح التسجيل مؤقتًا للمتأخرين بدون تغيير شاشة المسابقة الحالية؟")) {
                setTemporaryRegistrationOpen(true);
              }
            }}
          >
            فتح التسجيل مؤقتًا
          </button>
        )}
        {stage !== "registration" && room?.registrationOverrideOpen && (
          <button
            type="button"
            className="reopen-registration-button close"
            onClick={() => setTemporaryRegistrationOpen(false)}
          >
            إغلاق التسجيل المؤقت
          </button>
        )}
      </section>
      <div className="dashboard-live-top-row">
        <div className="admin-next-question-card admin-previous-question-main">
          <span>السؤال السابق</span>
          <div className="admin-question-meta-row">
            <small>{previousAdminQuestion ? getQuestionTypeLabel(previousAdminQuestion.type) : "لا يوجد"}</small>
            <small>{previousAdminQuestion ? getQuestionCategory(previousAdminQuestion) : "قبل البداية"}</small>
          </div>
          <strong>{previousAdminQuestion?.text || "لا يوجد سؤال سابق"}</strong>
          {getQuestionImageUrl(previousAdminQuestion) ? (
            <button
              type="button"
              className="admin-question-media-slot admin-question-media-button"
              onClick={() => window.open(getQuestionImageUrl(previousAdminQuestion), "_blank", "noopener,noreferrer")}
            >
              <img className="admin-next-question-image" src={getQuestionImageUrl(previousAdminQuestion)} alt="صورة السؤال السابق" />
            </button>
          ) : (
            <div className="admin-question-media-slot empty" aria-hidden="true" />
          )}
          {previousAdminQuestion?.options?.length > 0 && (
            <div className="admin-next-question-options">
              {previousAdminQuestion.options.map((option, index) => {
                const optionImage = getOptionImage(option, previousAdminQuestion.optionImageUrls || [], index);
                const isCorrect = index === Number(previousAdminQuestion.correctIndex || 0);
                return (
                  <div className={isCorrect ? "admin-next-option correct" : "admin-next-option"} key={`${previousAdminQuestion.id || "previous-top"}-${index}`}>
                    {optionImage && <img src={optionImage} alt="" />}
                    <b>{getOptionText(option)}</b>
                    {isCorrect && <em>الإجابة الصحيحة</em>}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div className="admin-next-question-card admin-current-question-main">
          <span>السؤال الحالي</span>
          <div className="admin-question-meta-row">
            <small>{room?.currentQuestion ? currentQuestionType : "بانتظار العرض"}</small>
            <small>{room?.currentQuestion ? currentQuestionCategory : liveStageLabel}</small>
          </div>
          <strong>{room?.currentQuestion?.text || "لا يوجد سؤال معروض الآن"}</strong>
          {getQuestionImageUrl(room?.currentQuestion) ? (
            <button
              type="button"
              className="admin-question-media-slot admin-question-media-button"
              onClick={() => window.open(getQuestionImageUrl(room?.currentQuestion), "_blank", "noopener,noreferrer")}
            >
              <img className="admin-next-question-image" src={getQuestionImageUrl(room?.currentQuestion)} alt="صورة السؤال الحالي" />
            </button>
          ) : (
            <div className="admin-question-media-slot empty" aria-hidden="true" />
          )}
          {room?.currentQuestion?.options?.length > 0 && (
            <div className="admin-next-question-options">
              {room.currentQuestion.options.map((option, index) => {
                const optionImage = getOptionImage(option, room.currentQuestion.optionImageUrls || [], index);
                const isCorrect = index === Number(room.currentQuestion.correctIndex || 0);
                return (
                  <div className={isCorrect ? "admin-next-option correct" : "admin-next-option"} key={`${room.currentQuestion.questionId || room.currentQuestion.id || "current-top"}-${index}`}>
                    {optionImage && <img src={optionImage} alt="" />}
                    <b>{getOptionText(option)}</b>
                    {isCorrect && <em>الإجابة الصحيحة</em>}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div className="admin-next-question-card admin-next-question-main">
          <span>السؤال القادم</span>
          <div className="admin-question-meta-row">
            <small>{nextAdminQuestion ? nextQuestionType : "لا يوجد"}</small>
            <small>{nextAdminQuestion ? nextQuestionCategory : "نهاية الجولة"}</small>
          </div>
          <strong>{nextAdminQuestion?.text || "لا يوجد سؤال تالٍ"}</strong>
          {getQuestionImageUrl(nextAdminQuestion) ? (
            <button
              type="button"
              className="admin-question-media-slot admin-question-media-button"
              onClick={() => window.open(getQuestionImageUrl(nextAdminQuestion), "_blank", "noopener,noreferrer")}
            >
              <img className="admin-next-question-image" src={getQuestionImageUrl(nextAdminQuestion)} alt="صورة السؤال القادم" />
            </button>
          ) : (
            <div className="admin-question-media-slot empty" aria-hidden="true" />
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

      </div>
      <div className="dashboard-live-grid">
        <section className="question-report-card live-report-card live-question-stats-section">
          <button type="button" className="question-report-header" onClick={() => toggleLiveSection("players")}>
            <div className="question-report-title"><strong>المتسابقون الآن</strong><span>{registeredCount} مسجلين، {openedLinkCount} فتحوا الرابط</span></div>
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
            <div className="question-report-title"><strong>مراقبة الأسئلة</strong><span>أداء كل سؤال حسب الإجابات والتصنيفات.</span></div>
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
                  {expanded && <div className="question-report-body">{rows.length === 0 ? <span className="muted">لا توجد إجابات لهذا السؤال.</span> : <div className="admin-table-wrap"><table className="admin-table live-question-answers-table"><thead><tr><th>المتسابق</th><th>الاسم الثلاثي</th><th>الإجابة</th><th>النتيجة</th><th>النقاط</th><th>الوقت</th><th>جوكر</th></tr></thead><tbody>{rows.map(({ answer, player, selectedText }) => <tr className={answer.isCorrect ? "live-answer-row-correct" : "live-answer-row-wrong"} key={answer.id}><td><strong>{player?.name || answer.playerName}</strong></td><td>{player?.fullName || answer.fullName || "—"}</td><td>{selectedText}</td><td style={{ color: answer.isCorrect ? "#18733a" : "#a51f1f", fontWeight: 900 }}>{answer.isCorrect ? "صح" : "خطأ"}</td><td><strong>{answer.points || 0}</strong></td><td>{formatAnswerTime(answer)}</td><td>{answer.jokerApplied ? "\u{1F0CF}" : "—"}</td></tr>)}</tbody></table></div>}</div>}
                </div>
              );
            })}</div>
          </div>}
        </section>
        <section className="question-report-card live-report-card live-player-stats-section">
          <button type="button" className="question-report-header" onClick={() => toggleLiveSection("playerStats")}>
            <div className="question-report-title"><strong>مراقبة المتسابقين</strong><span>تتبع الإجابات والنقاط لكل متسابق.</span></div>
            <span className="expand-indicator">{liveExpandedSections.playerStats ? "−" : "+"}</span>
          </button>
          {liveExpandedSections.playerStats && <div className="question-report-body">
            <div className="question-list live-collapsible-list">{players.map((player) => {
              const expanded = !!expandedPlayers[player.id];
              const playerAnswers = competitionQuestions.map((question, index) => {
                const answer = competitionAnswers.find((item) => item.playerId === player.id && (item.questionId === question.id || item.questionId === question.questionId));
                return { question, questionNumber: index + 1, answer, selectedText: answer ? getSelectedAnswerText(question, answer) : "لم يجب" };
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
                  {expanded && <div className="player-report-body"><div className="admin-table-wrap"><table className="admin-table live-player-answers-table"><thead><tr><th>رقم السؤال</th><th>السؤال</th><th>إجابة المتسابق</th><th>النتيجة</th><th>النقاط</th><th>الوقت</th></tr></thead><tbody>{playerAnswers.map(({ question, questionNumber, answer, selectedText }) => <tr className={answer ? (answer.isCorrect ? "live-answer-row-correct" : "live-answer-row-wrong") : ""} key={`${player.id}-${question.id}`}><td>{questionNumber}</td><td>{question.text} {answer?.jokerApplied && <span className="inline-joker-mark" title="استخدم الجوكر">{"\u{1F0CF}"}</span>}</td><td>{selectedText}</td><td style={{ fontWeight: 900, color: answer ? (answer.isCorrect ? "#18733a" : "#a51f1f") : undefined }}>{answer ? (answer.isCorrect ? "صح" : "خطأ") : "—"}</td><td>{answer?.points ?? "—"}</td><td>{answer ? formatAnswerTime(answer) : "—"}</td></tr>)}</tbody></table></div></div>}
                </div>
              );
            })}</div>
          </div>}
        </section>
      </div>
      </div>}

      {activeAdminSection === "setup" && (
      <div className="setup-console">
        <div className="setup-console-head">
          <div>
            <span>مركز التشغيل</span>
            <h2>تهيئة المسابقة</h2>
            <p>إجراءات جاهزة قبل البث وأثناء التجربة. الأسئلة ونماذج الأسئلة لا تُحذف من هذه الصفحة.</p>
          </div>
          <div className="setup-status-grid">
            <span><b>{registeredCount}</b><small>متسابق</small></span>
            <span><b>{competitionQuestions.length}</b><small>سؤال فعلي</small></span>
            <span><b>{practiceQuestions.length}</b><small>تجريبي</small></span>
            <span><b>{stage}</b><small>المرحلة</small></span>
          </div>
        </div>

        <div className="setup-section-card primary">
          <div className="setup-section-title">
            <strong>تجهيز البث</strong>
            <span>أزرار آمنة لا تحذف المتسابقين.</span>
          </div>
          <div className="setup-action-list">
            <div className="setup-action-row">
              <div><strong>فتح التسجيل مع إبقاء المتسابقين</strong><span>يرجع الشاشة إلى صفحة التسجيل وينظف حالة السؤال والنتائج والسحب بدون حذف الأسماء.</span></div>
              <button onClick={() => { if (window.confirm("العودة للتسجيل مع إبقاء المتسابقين؟")) returnToRegistrationKeepingPlayers(); }}>فتح</button>
            </div>
            <div className="setup-action-row">
              <div><strong>عرض معلومات المسابقة</strong><span>ينقل شاشة العرض والمتسابقين إلى صفحة التعليمات قبل بدء اللعب.</span></div>
              <button onClick={showInstructionsPage} disabled={players.length === 0}>عرض</button>
            </div>
            <div className="setup-action-row">
              <div><strong>إيقاف وضع الاختبار</strong><span>يوقف الإجابات الوهمية وتأخير النتائج التجريبي إن كان مفعّلًا.</span></div>
              <button className="secondary-action" onClick={() => setDoc(doc(db, "rooms", ROOM_ID), { testMode: { autoAnswerEnabled: false, slowResultsEnabled: false, slowResultsDelayMs: 15000 }, updatedAt: serverTimestamp() }, { merge: true })}>إيقاف</button>
            </div>
            <div className="setup-action-row">
              <div><strong>إغلاق شاشة السحب</strong><span>يرجع العرض من صفحة سحب الجوائز إلى المرحلة السابقة ويوقف الحركة.</span></div>
              <button className="secondary-action" onClick={closePrizeWheelStage} disabled={stage !== "prizeWheel"}>إغلاق</button>
            </div>
          </div>
        </div>

        <div className="setup-section-card">
          <div className="setup-section-title">
            <strong>تنظيف سريع</strong>
            <span>مفيد بين التجارب أو قبل بداية البث.</span>
          </div>
          <div className="setup-action-list">
            <div className="setup-action-row">
              <div><strong>مسح الرسائل فقط</strong><span>يحذف رسائل المتسابقين دون التأثير على الأسماء أو النقاط أو الإجابات.</span></div>
              <button className="warning-action" onClick={() => { if (window.confirm("مسح رسائل المتسابقين فقط؟")) clearMessagesOnly(); }}>مسح</button>
            </div>
            <div className="setup-action-row">
              <div><strong>مسح الإجابات والرسائل</strong><span>يبقي المتسابقين، ويمسح إجابات الجولة والرسائل ويعيد العرض للصفحة الرئيسية.</span></div>
              <button className="warning-action" onClick={() => { if (window.confirm("مسح الإجابات والرسائل مع إبقاء المتسابقين؟")) clearAnswersAndMessages(); }}>مسح</button>
            </div>
          </div>
        </div>

        <div className="setup-section-card danger-zone">
          <div className="setup-section-title">
            <strong>بداية جديدة</strong>
            <span>هذه الأزرار تحذف بيانات المشاركين أو الجولة الحالية.</span>
          </div>
          <div className="setup-action-list">
            <div className="setup-action-row danger-row">
              <div><strong>فتح تسجيل جديد بالكامل</strong><span>يمسح المتسابقين والإجابات والرسائل، ثم يفتح التسجيل لجولة جديدة.</span></div>
              <button className="danger" onClick={() => { if (window.confirm("مسح المتسابقين والإجابات والرسائل وفتح تسجيل جديد؟")) resetAndStartRegistration(); }}>فتح جديد</button>
            </div>
            <div className="setup-action-row danger-row">
              <div><strong>تصفير كل شيء</strong><span>يمسح المتسابقين والإجابات والرسائل ويعيد المسابقة إلى الصفحة الرئيسية.</span></div>
              <button className="danger" onClick={() => { if (window.confirm("تصفير الجولة بالكامل؟")) hardResetGame(); }}>تصفير</button>
            </div>
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

      {activeAdminSection === "prizes" && (
      <div className="card prize-control-card">
        <div className="prize-control-head">
          <div>
            <h2>سحب الجوائز</h2>
            <p className="muted">جوائز جانبية لا تغيّر النقاط ولا ترتيب المتسابقين.</p>
          </div>
          <div className="prize-head-actions">
            <span>{eligiblePrizePlayers.length} متاح</span>
            <button type="button" onClick={() => setIsPrizeAddOpen(true)}>+ إضافة جائزة</button>
          </div>
        </div>

        <div className="prize-settings-strip">
          <label className="prize-checkbox-row">
            <input
              type="checkbox"
              checked={excludePrizeWinners}
              onChange={(event) => setExcludePrizeWinners(event.target.checked)}
            />
            <span>استبعاد من فاز سابقًا</span>
          </label>
        </div>

        <div className="prize-ready-list">
          {prizeItems.length === 0 && (
            <div className="prize-empty-state">لا توجد جوائز جاهزة. أضف جائزة من الزر بالأعلى.</div>
          )}
          {prizeItems.map((item) => {
            const itemWinners = prizeWinners.filter((winner) => winner.prizeItemId === item.id || (!winner.prizeItemId && winner.prizeTitle === item.title));
            const expanded = !!expandedPrizeItems[item.id];
            const isActivePrize = activePrizeItemId === item.id;
            const selectedWinnerId = selectedPrizeWinnerByPrize[item.id] || "";
            return (
              <section className={isActivePrize ? "prize-ready-card active" : "prize-ready-card"} key={item.id}>
                <div className="prize-ready-main">
                  <button type="button" className="prize-ready-toggle" onClick={() => togglePrizeItem(item.id)} aria-expanded={expanded}>
                    <strong>{item.title}</strong>
                    <span>{itemWinners.length} فائز</span>
                    <i>{expanded ? "−" : "+"}</i>
                  </button>
                  <div className="prize-ready-actions">
                    <select
                      className="prize-winner-select"
                      value={selectedWinnerId}
                      onChange={(event) => setSelectedPrizeWinnerByPrize((prev) => ({ ...prev, [item.id]: event.target.value }))}
                      title="اختيار الفائز"
                      aria-label={`اختيار فائز ${item.title}`}
                    >
                      <option value="">فائز عشوائي</option>
                      {eligiblePrizePlayers.map((player) => (
                        <option value={player.id} key={player.id}>
                          {player.emoji || ""} {player.name}{player.fullName ? ` (${player.fullName})` : ""}
                        </option>
                      ))}
                    </select>
                    {stage === "prizeWheel" && isActivePrize ? (
                      <>
                        <button type="button" className="warning-action" onClick={() => spinPrizeWheel(item, selectedWinnerId)} disabled={players.length === 0 || prizeWheel.spinning}>سحب</button>
                        <button type="button" className="secondary-action" onClick={closePrizeWheelStage}>إغلاق</button>
                      </>
                    ) : (
                      <button type="button" onClick={() => openPrizeWheelStage(item, selectedWinnerId)} disabled={players.length === 0}>عرض السحب</button>
                    )}
                    <button
                      type="button"
                      className="danger icon-action-button"
                      title="حذف الجائزة"
                      aria-label="حذف الجائزة"
                      onClick={() => {
                        if (window.confirm(`حذف جائزة "${item.title}" من القائمة؟`)) deletePrizeItem(item.id);
                      }}
                    >
                      ×
                    </button>
                  </div>
                </div>
                {expanded && (
                  <div className="prize-ready-details">
                    {itemWinners.length === 0 ? (
                      <span className="muted">لا يوجد فائز لهذه الجائزة بعد.</span>
                    ) : (
                      itemWinners.slice().reverse().map((winner) => (
                        <div className="prize-winner-row compact" key={winner.spinId || `${winner.playerId}-${winner.awardedAtMs}`}>
                          <div>
                            <strong>{winner.playerEmoji || ""} {winner.playerName}</strong>
                            <small>{winner.playerFullName || "لا يوجد اسم ثلاثي"}</small>
                          </div>
                          <small>{winner.awardedAtMs ? new Date(winner.awardedAtMs).toLocaleTimeString("ar-SA") : "—"}</small>
                          <button type="button" className="danger icon-action-button" title="حذف من السجل" aria-label="حذف من السجل" onClick={() => deletePrizeWinner(winner.spinId)}>×</button>
                        </div>
                      ))
                    )}
                  </div>
                )}
              </section>
            );
          })}
        </div>

        {isPrizeAddOpen && (
          <div className="modal-backdrop" onClick={() => setIsPrizeAddOpen(false)}>
            <div className="modal-card prize-add-modal" onClick={(event) => event.stopPropagation()}>
              <h2>إضافة جائزة</h2>
              <label>
                اسم الجائزة
                <input
                  value={newPrizeTitle}
                  onChange={(event) => setNewPrizeTitle(event.target.value)}
                  placeholder="مثال: 100 ريال"
                  autoFocus
                  onKeyDown={(event) => {
                    if (event.key === "Enter") addPrizeItem();
                  }}
                />
              </label>
              <div className="prize-add-modal-actions">
                <button type="button" onClick={addPrizeItem} disabled={!newPrizeTitle.trim()}>حفظ</button>
                <button type="button" className="secondary-action" onClick={() => setIsPrizeAddOpen(false)}>إلغاء</button>
              </div>
            </div>
          </div>
        )}
      </div>
      )}

      {activeAdminSection === "testMode" && (
      <div className="tm-panel">
        <div className="tm-panel-header">
          <div className="tm-title-block">
            <span className="tm-panel-title">وضع الاختبار</span>
            <span className="tm-panel-desc muted">أدوات تجربة قبل البث. كل بطاقة توضّح ماذا يفعل زرها.</span>
          </div>
          <span className="tm-count-badge">{players.filter((p) => p.isFake).length} وهمي</span>
          <span className={`tm-status-badge ${room?.testMode?.autoAnswerEnabled ? "tm-status-on" : "tm-status-off"}`}>
            {room?.testMode?.autoAnswerEnabled ? "تلقائي ✓" : "تلقائي ✗"}
          </span>
          <span className={`tm-status-badge ${room?.testMode?.slowResultsEnabled ? "tm-status-warn" : "tm-status-off"}`}>
            {room?.testMode?.slowResultsEnabled ? `تأخير ${Math.round((room?.testMode?.slowResultsDelayMs || 15000) / 1000)}ث` : "بلا تأخير"}
          </span>
        </div>

        <div className="tm-scenarios">
          <div className="tm-scenario tm-scenario-primary">
            <div>
              <span className="tm-scenario-kicker">ابدأ من هنا</span>
              <h3>تجربة سريعة</h3>
              <p>يضيف 5 متسابقين وهميين ويشغّل الإجابات التلقائية بدون تأخير. مناسب للتأكد أن السؤال والنتائج واللوحة تعمل.</p>
            </div>
            <button type="button" className="tm-btn tm-btn-primary" disabled={testModeWorking}
              onClick={async () => { setTestModeWorking(true); try { await createFakePlayers(5); await updateTestMode({ autoAnswerEnabled: true, slowResultsEnabled: false, slowResultsDelayMs: 15000 }); } catch (e) { console.error(e); } finally { setTestModeWorking(false); } }}>
              {testModeWorking ? "جاري..." : "تجهيز سريع"}
            </button>
          </div>

          <div className="tm-scenario">
            <div>
              <span className="tm-scenario-kicker">اختبار شكل البث</span>
              <h3>محاكاة 30 متسابق</h3>
              <p>يضيف عددًا كبيرًا من الوهميين ويشغّل إجابات تلقائية، حتى ترى شكل لوحة المتصدرين والجداول عند الزحمة.</p>
            </div>
            <button type="button" className="tm-btn" disabled={testModeWorking}
              onClick={async () => { setTestModeWorking(true); try { await createFakePlayers(30); await updateTestMode({ autoAnswerEnabled: true, slowResultsEnabled: false, slowResultsDelayMs: 15000 }); } catch (e) { console.error(e); } finally { setTestModeWorking(false); } }}>
              محاكاة 30
            </button>
          </div>

          <div className="tm-scenario">
            <div>
              <span className="tm-scenario-kicker">أثناء السؤال</span>
              <h3>إجابات السؤال الحالي</h3>
              <p>يرسل إجابات للوهميين على السؤال المعروض فقط. استخدمه إذا أردت اختبار احتساب النتائج بدون انتظار.</p>
            </div>
            <div className="tm-scenario-actions">
              <button type="button" className="tm-btn" disabled={testModeWorking}
                onClick={async () => {
                  setTestModeWorking(true); setTestModeMsg(null);
                  try {
                    const result = await sendFakeAnswersForQuestion(players, room);
                    if (result.error === "no-fake-players") setTestModeMsg({ type: "error", text: "لا يوجد لاعبون وهميون." });
                    else if (result.error === "no-question") setTestModeMsg({ type: "error", text: "لا يوجد سؤال حالي." });
                    else if (result.noOptions > 0 && result.written === 0) setTestModeMsg({ type: "error", text: "تعذر تحديد خيارات السؤال." });
                    else setTestModeMsg({ type: "success", text: `كُتبت ${result.written} إجابة${result.duplicates > 0 ? ` (${result.duplicates} مكررة)` : ""}` });
                  } catch (e) { setTestModeMsg({ type: "error", text: `خطأ: ${e.message}` }); } finally { setTestModeWorking(false); }
                }}>
                {testModeWorking ? "جاري..." : "إرسال إجابات"}
              </button>
              <button type="button" className="tm-btn tm-btn-soft-danger" disabled={testModeWorking || !adminCurrentQuestionId}
                onClick={async () => {
                  if (!window.confirm("حذف إجابات الوهميين للسؤال الحالي فقط؟")) return;
                  setTestModeWorking(true); setTestModeMsg(null);
                  try {
                    const deleted = await deleteFakeAnswersForQuestion(adminCurrentQuestionId);
                    setTestModeMsg({ type: "success", text: `حُذفت ${deleted} إجابة وهمية.` });
                  } catch (e) {
                    setTestModeMsg({ type: "error", text: `خطأ: ${e.message}` });
                  } finally {
                    setTestModeWorking(false);
                  }
                }}>
                حذف إجابات السؤال
              </button>
            </div>
            {testModeMsg && (
              <p className={testModeMsg.type === "error" ? "tm-warning" : "tm-success-msg"}>{testModeMsg.text}</p>
            )}
          </div>

          <div className="tm-scenario">
            <div>
              <span className="tm-scenario-kicker">تشغيل تلقائي</span>
              <h3>إجابة تلقائية مستمرة</h3>
              <p>عند تشغيله، الوهميون يجاوبون تلقائيًا في كل سؤال جديد. أوقفه قبل التجربة اليدوية.</p>
            </div>
            {!room?.testMode?.autoAnswerEnabled ? (
              <button type="button" className="tm-btn tm-btn-activate"
                onClick={async () => { await updateTestMode({ autoAnswerEnabled: true }); }}>
                تشغيل التلقائي
              </button>
            ) : (
              <button type="button" className="tm-btn tm-btn-danger"
                onClick={async () => { await updateTestMode({ autoAnswerEnabled: false }); }}>
                إيقاف التلقائي
              </button>
            )}
          </div>

          <div className="tm-scenario tm-scenario-warning">
            <div>
              <span className="tm-scenario-kicker">اختبار طارئ فقط</span>
              <h3>محاكاة بطء النتائج</h3>
              <p>يجعل شاشة “جاري احتساب النتائج” تتأخر عمدًا. اتركه مطفأ أثناء البث الحقيقي.</p>
            </div>
            <div className="tm-scenario-actions">
              <label className="tm-inline-label">
                <span>ثوانٍ</span>
                <input type="number" className="tm-number-input" min="5" max="60"
                  defaultValue={Math.round((room?.testMode?.slowResultsDelayMs || 15000) / 1000)}
                  onBlur={async (e) => { const ms = Math.max(5000, Math.min(60000, Number(e.target.value) * 1000)); await updateTestMode({ slowResultsDelayMs: ms }); }} />
              </label>
              {!room?.testMode?.slowResultsEnabled ? (
                <button type="button" className="tm-btn tm-btn-activate"
                  onClick={async () => { await updateTestMode({ slowResultsEnabled: true }); }}>
                  تفعيل التأخير
                </button>
              ) : (
                <button type="button" className="tm-btn tm-btn-danger"
                  onClick={async () => { await updateTestMode({ slowResultsEnabled: false }); }}>
                  إيقاف التأخير
                </button>
              )}
            </div>
          </div>

          <div className="tm-scenario tm-scenario-cleanup">
            <div>
              <span className="tm-scenario-kicker">تنظيف</span>
              <h3>إنهاء الاختبار</h3>
              <p>إيقاف الاختبار فقط يحافظ على الوهميين. إيقاف وتنظيف يحذفهم ويطفئ كل وضع الاختبار.</p>
            </div>
            <div className="tm-scenario-actions">
              <button type="button" className="tm-btn" disabled={testModeWorking}
                onClick={async () => { await updateTestMode({ autoAnswerEnabled: false, slowResultsEnabled: false, slowResultsDelayMs: 15000 }); }}>
                إيقاف الاختبار فقط
              </button>
              <button type="button" className="tm-btn tm-btn-danger" disabled={testModeWorking}
                onClick={async () => { if (!window.confirm("إيقاف وضع الاختبار وحذف الوهميين؟")) return; setTestModeWorking(true); try { await deleteFakePlayers(players); await updateTestMode({ autoAnswerEnabled: false, slowResultsEnabled: false }); } catch (e) { console.error(e); } finally { setTestModeWorking(false); } }}>
                إيقاف وتنظيف
              </button>
            </div>
          </div>
        </div>
      </div>
      )}

      {activeAdminSection === "analytics" && (
      <div className="dashboard-analytics-hub">
        <section className="analytics-hero-card">
          <div>
            <span>مركز المراجعة</span>
            <h2>التقارير والإحصائيات في مكان واحد</h2>
            <p>هنا تراجع أداء الأسئلة والمتسابقين بعد أو أثناء المسابقة. أما صفحة متابعة البث فتبقى للمراقبة السريعة فقط.</p>
          </div>
          <div className="analytics-hero-stats">
            <span><b>{competitionQuestions.length}</b> سؤال</span>
            <span><b>{players.length}</b> متسابق</span>
            <span><b>{competitionAnswers.length}</b> إجابة</span>
          </div>
        </section>

        <div className="analytics-card-grid">
          <button type="button" className="analytics-entry-card questions-entry" onClick={() => openAdminSection("questionReports")}>
            <span>إحصائيات الأسئلة</span>
            <strong>اعرف أي سؤال كان واضحًا أو صعبًا</strong>
            <small>نسبة الصح، عدد الإجابات، الجوكر، وتفاصيل كل سؤال.</small>
            <b>{answersByQuestion.filter((item) => item.rows.length > 0).length} / {competitionQuestions.length}</b>
          </button>
          <button type="button" className="analytics-entry-card players-entry" onClick={() => openAdminSection("playerReports")}>
            <span>إحصائيات المتسابقين</span>
            <strong>راجع أداء كل متسابق بالتفصيل</strong>
            <small>إجاباته، توقيته، نقاطه، والأسئلة التي استخدم فيها الجوكر.</small>
            <b>{players.length}</b>
          </button>
          <button type="button" className="analytics-entry-card history-entry" onClick={() => openAdminSection("history")}>
            <span>سجل المسابقات</span>
            <strong>الأرشيف الكامل لكل مسابقة</strong>
            <small>النتائج، الفائزون، السحب، الإجابات، وتصدير Excel.</small>
            <b>{gameHistory.length}</b>
          </button>
        </div>
      </div>
      )}

      {activeAdminSection === "players" && (
      <div className="card">
        <div className="report-section-title players-tools-title">
          <h2>المتسابقون المسجلون</h2>
        </div>
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
              return { question, questionNumber: index + 1, answer, selectedText: answer ? getSelectedAnswerText(question, answer) : "لم يجب" };
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
  const [isManuallyCalculating, setIsManuallyCalculating] = useState(false);
  const [isAdvancingDisplayQuestion, setIsAdvancingDisplayQuestion] = useState(false);
  const [isSkippingCalculation, setIsSkippingCalculation] = useState(false);
  const [skipNoticeQuestionId, setSkipNoticeQuestionId] = useState(null);
  const [isStartingCompetition, setIsStartingCompetition] = useState(false);
  const [startCompetitionError, setStartCompetitionError] = useState(null);
  const [isShowingResults, setIsShowingResults] = useState(false);
  const [forceRetryError, setForceRetryError] = useState(null);
  const [showFinalQuestionResults, setShowFinalQuestionResults] = useState(false);
  const [showInstructionsContinue, setShowInstructionsContinue] = useState(false);
  const readyTimerRef = useRef(null);
  const advanceSafetyTimerRef = useRef(null);
  const displayAdvancingRef = useRef(false);
  const displayNow = useNow(250);

  const stage = room?.stage || "home";
  const displayStage = previewStage || stage;
  const displayVideoSlotEnabled = !!room?.displayVideoSlotEnabled;
  const currentQuestion = room?.currentQuestion || null;
  const currentQuestionIndex = room?.currentQuestionIndex ?? -1;
  const syncedReadyCountdown = Math.max(0, Math.ceil((Number(room?.nextQuestionReadyUntilMs || 0) - displayNow) / 1000));
  // Firestore's shared deadline is authoritative, so the countdown stays correct
  // even when another tab starts the question or background timers are throttled.
  const visibleReadyCountdown = syncedReadyCountdown > 0 ? syncedReadyCountdown : (readyCountdown ?? 1);
  const displayQuestionList = room?.practiceMode ? getPracticeQuestions(questions) : getMainQuestions(questions);
  const finalQuestionIndex = Math.max(0, displayQuestionList.length - 1);
  const finalQuestionSource = displayQuestionList[finalQuestionIndex] || currentQuestion;
  const finalQuestion = finalQuestionSource
    ? { ...finalQuestionSource, questionId: finalQuestionSource.questionId || finalQuestionSource.id }
    : null;
  const finalQuestionAnswers = finalQuestion
    ? (allAnswers || []).filter((answer) => answer.questionId === finalQuestion.questionId)
    : [];
  const finalQuestionPlayers = players;
  const finalQuestionRoom = finalQuestion
    ? {
        ...room,
        currentQuestion: { ...finalQuestion, answerRevealAtMs: 1, answerStartAtMs: 1, answerEndAtMs: 1 },
        currentQuestionIndex: finalQuestionIndex,
        processedQuestionId: finalQuestion.questionId,
        collectingBonusByPlayer: Object.fromEntries(finalQuestionAnswers.map((answer) => [answer.playerId, Number(answer.points || 0)])),
        collectingBonusJokerByPlayer: Object.fromEntries(finalQuestionAnswers.filter((answer) => answer.jokerApplied).map((answer) => [answer.playerId, getJokerTimingLabel(answer.jokerMultiplier || 3)])),
        collectingAnswerCorrectByPlayer: Object.fromEntries(finalQuestionAnswers.map((answer) => [answer.playerId, !!answer.isCorrect])),
        rankMovementByPlayer: {},
      }
    : room;
  const nextQuestion = displayQuestionList?.[currentQuestionIndex + 1];
  const nextQuestionNeedsVote = isVotingQuestion(nextQuestion);
  const displayVoteTieLabels = stage === "categoryVote" ? getCategoryVoteTieLabels(room?.categoryVote || {}) : [];
  const isCurrentLastQuestion = currentQuestionIndex >= 0 && currentQuestionIndex >= displayQuestionList.length - 1;
  const nextQuestionIsLast = !!nextQuestion && currentQuestionIndex + 1 >= displayQuestionList.length - 1;
  const displayQuestionIndex = previewStage && previewQuestionIndex !== null ? previewQuestionIndex : currentQuestionIndex;
  const displayQuestionSource = previewStage && displayQuestionIndex >= 0 ? displayQuestionList?.[displayQuestionIndex] : currentQuestion;
  const displayQuestion = displayQuestionSource
    ? { ...displayQuestionSource, questionId: displayQuestionSource.questionId || displayQuestionSource.id }
    : null;
  const displayAnswers = previewStage && displayQuestion
    ? (allAnswers || []).filter((answer) => answer.questionId === displayQuestion.questionId)
    : answers;
  const previewResultsSnapshot =
    previewStage === "results" && displayQuestion
      ? buildPreviewResultsSnapshot({
          questionList: displayQuestionList,
          questionIndex: displayQuestionIndex,
          players,
          allAnswers,
        })
      : null;
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
        resultsDisplaySnapshot: previewResultsSnapshot || room?.resultsDisplaySnapshot || null,
      }
    : room;

  const liveQuestionId = room?.currentQuestion?.questionId || room?.currentQuestion?.id || null;
  const currentProcessed = isSameId(room?.processedQuestionId, liveQuestionId);

  useEffect(() => {
    if (stage !== "instructions") setShowInstructionsContinue(false);
  }, [stage]);

  useEffect(() => {
    const keepLocalReadyTimer = stage === "ready" && displayAdvancingRef.current;
    if (keepLocalReadyTimer) {
      setPreviewStage("ready");
      return;
    }

    setPreviewStage(null);
    setPreviewQuestionIndex(null);
    setReadyCountdown(null);
    if (readyTimerRef.current) {
      clearInterval(readyTimerRef.current);
      readyTimerRef.current = null;
    }
    if (advanceSafetyTimerRef.current) {
      clearTimeout(advanceSafetyTimerRef.current);
      advanceSafetyTimerRef.current = null;
    }
    displayAdvancingRef.current = false;
    setIsAdvancingDisplayQuestion(false);
  }, [stage, room?.currentQuestion?.questionId]);

  useEffect(() => {
    if (stage !== "results" || currentProcessed) {
      setShowForceProcess(false);
      return;
    }

    const timeout = setTimeout(() => setShowForceProcess(true), 3500);
    return () => clearTimeout(timeout);
  }, [stage, currentProcessed, room?.currentQuestion?.questionId]);

  useEffect(() => {
    if (stage !== "finished") {
      setShowFinalQuestionResults(false);
    }
  }, [stage]);

  useEffect(() => {
    return () => {
      if (readyTimerRef.current) clearInterval(readyTimerRef.current);
      if (advanceSafetyTimerRef.current) clearTimeout(advanceSafetyTimerRef.current);
    };
  }, []);

  useEffect(() => {
    setSkipNoticeQuestionId(null);
  }, [liveQuestionId]);

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
      if (index === currentQuestionIndex && stage === "results") {
        setPreviewQuestionIndex(null);
        setPreviewStage(null);
      } else {
        setPreviewQuestionIndex(index);
        setPreviewStage("results");
      }
    } else if (displayStage === "results" && index < currentQuestionIndex) {
      setPreviewQuestionIndex(index + 1);
      setPreviewStage("question");
    } else {
      setPreviewStage(null);
      setPreviewQuestionIndex(null);
    }
  }

  async function startCompetition() {
    if (isStartingCompetition) return;
    const firstQuestion = getMainQuestions(questions)[0];
    if (!firstQuestion) {
      alert("أضف سؤالًا فعليًا واحدًا على الأقل قبل بدء المسابقة.");
      return;
    }
    setIsStartingCompetition(true);
    setStartCompetitionError(null);
    try {
      const playersSnap = await getDocs(collection(db, "rooms", ROOM_ID, "players"));
      const resetBatch = writeBatch(db);
      playersSnap.docs.forEach((playerDoc) => {
        resetBatch.update(playerDoc.ref, {
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
        });
      });
      await resetBatch.commit();
      await setDoc(doc(db, "rooms", ROOM_ID), { practiceMode: false, practiceFinished: true, currentQuestionIndex: -1, usedQuestionIds: {}, updatedAt: serverTimestamp() }, { merge: true });
      if (isVotingQuestion(firstQuestion)) {
        await startCategoryVote(firstQuestion, room, 0);
      } else {
        await startReadyThenSend(firstQuestion, 0, { force: true });
      }
    } catch (error) {
      console.error("Failed to start competition:", error);
      setStartCompetitionError("حدث خطأ أثناء بدء المسابقة. حاول مرة أخرى.");
    } finally {
      setIsStartingCompetition(false);
    }
  }

  async function handleSkipReadyCountdown() {
    const question = room?.currentQuestion;
    const questionId = question?.questionId || question?.id;
    if (!questionId) return;
    if (readyTimerRef.current) {
      clearInterval(readyTimerRef.current);
      readyTimerRef.current = null;
    }
    setReadyCountdown(null);
    try {
      await activatePreloadedQuestion(questionId, room?.currentQuestionIndex ?? 0);
    } catch (err) {
      console.error("Skip ready countdown failed:", err);
    } finally {
      setPreviewStage(null);
      displayAdvancingRef.current = false;
      setIsAdvancingDisplayQuestion(false);
    }
  }

  async function startReadyThenSend(question, questionIndex, { force = false } = {}) {
    if (displayAdvancingRef.current && !force) return false;
    if (force && readyTimerRef.current) {
      clearInterval(readyTimerRef.current);
      readyTimerRef.current = null;
    }
    if (advanceSafetyTimerRef.current) {
      clearTimeout(advanceSafetyTimerRef.current);
      advanceSafetyTimerRef.current = null;
    }
    displayAdvancingRef.current = true;
    setIsAdvancingDisplayQuestion(true);
    if (readyTimerRef.current) clearInterval(readyTimerRef.current);
    advanceSafetyTimerRef.current = setTimeout(() => {
      console.warn("Display advance safety timeout reset local loading state.");
      if (readyTimerRef.current) {
        clearInterval(readyTimerRef.current);
        readyTimerRef.current = null;
      }
      setPreviewStage(null);
      setReadyCountdown(null);
      displayAdvancingRef.current = false;
      setIsAdvancingDisplayQuestion(false);
    }, 7000);

    try {
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
        try {
          const activated = await activatePreloadedQuestion(question.id || question.questionId, questionIndex);
          if (!activated) {
            console.warn("Display question activation was ignored because it was stale.");
          }
        } finally {
          if (advanceSafetyTimerRef.current) {
            clearTimeout(advanceSafetyTimerRef.current);
            advanceSafetyTimerRef.current = null;
          }
          setPreviewStage(null);
          displayAdvancingRef.current = false;
          setIsAdvancingDisplayQuestion(false);
        }
      }, 1000);
      return true;
    } catch (error) {
      console.error("Failed to advance display question", error);
      if (advanceSafetyTimerRef.current) {
        clearTimeout(advanceSafetyTimerRef.current);
        advanceSafetyTimerRef.current = null;
      }
      setPreviewStage(null);
      setReadyCountdown(null);
      displayAdvancingRef.current = false;
      setIsAdvancingDisplayQuestion(false);
      return false;
    }
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
    if (nextQuestionNeedsVote) {
      await startCategoryVote(nextQuestion, room, currentQuestionIndex + 1);
      return;
    }

    if (!nextQuestion) {
      if (room?.practiceMode) {
        await finishPracticeToRegistration();
        return;
      }
      await finishGame(players, getMainQuestions(questions), allAnswers || [], messages, room);
      return;
    }

    await startReadyThenSend(nextQuestion, currentQuestionIndex + 1);
  }

  async function finishCategoryVoteFromDisplay({ selectedCategory = null, chooseRandomTie = false } = {}) {
    if (isAdvancingDisplayQuestion) return;
    setIsAdvancingDisplayQuestion(true);
    try {
      const outcome = await resolveCategoryVote(
        room,
        room?.practiceMode ? getPracticeQuestions(questions) : getMainQuestions(questions),
        { selectedCategory, chooseRandomTie }
      );
      if (!outcome.resolved && outcome.reason !== "tie") {
        if (room?.practiceMode) await finishPracticeToRegistration();
        else await finishGame(players, getMainQuestions(questions), allAnswers || [], messages, room);
      }
    } finally {
      setIsAdvancingDisplayQuestion(false);
    }
  }

  async function handleManualResultCalculation() {
    if (isManuallyCalculating) return;
    if (currentProcessed) return; // already done, noop
    setIsManuallyCalculating(true);
    setForceRetryError(null);
    try {
      await forceProcessResults(room);
    } catch (error) {
      console.error("Manual result calculation failed:", error);
      setForceRetryError("فشلت إعادة المحاولة، استخدم زر التجاوز الاضطراري إذا استمر التعليق.");
    } finally {
      setIsManuallyCalculating(false);
    }
  }

  async function handleSkipCalculation() {
    if (isSkippingCalculation) return;
    const confirmed = window.confirm(
      "تجاوز هذا السؤال بدون نقاط؟\n\nلن تتغير النقاط أو المراكز، وستبقى الإجابات محفوظة، وسيصبح السؤال التالي متاحًا."
    );
    if (!confirmed) return;
    setIsSkippingCalculation(true);
    try {
      await skipQuestionCalculation(room, answers.length, { source: "presenter-display" });
      setSkipNoticeQuestionId(liveQuestionId);
    } catch (error) {
      console.error("Skip calculation failed:", error);
    } finally {
      setIsSkippingCalculation(false);
    }
  }

  async function handleAnnounceFinalWinners() {
    await beginFinalCountdown(room);
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

    if (isVotingQuestion(firstPractice)) {
      await startCategoryVote(firstPractice, { ...room, practiceMode: true }, 0);
    } else {
      await startReadyThenSend(firstPractice, 0);
    }
  }

  function renderDisplayButton() {
    let mainButton = null;

    if (stage === "home") {
      mainButton = <button onClick={resetAndStartRegistration}>فتح التسجيل</button>;
    } else if (stage === "instructions") {
      mainButton = (
        <button className="display-main-action" onClick={() => setShowInstructionsContinue(true)}>
          استمرار
        </button>
      );
    } else if (stage === "registration" || stage === "practiceComplete") {
      const wantsStart = stage === "practiceComplete" || room?.practiceFinished;
      mainButton = (
        <>
          <button
            onClick={wantsStart ? startCompetition : showInstructionsPage}
            disabled={players.length === 0 || (room?.practiceFinished && getMainQuestions(questions).length === 0) || (wantsStart && isStartingCompetition)}
          >
            {wantsStart ? (isStartingCompetition ? "جاري البدء..." : "ابدأ المسابقة") : "عرض معلومات المسابقة"}
          </button>
          {startCompetitionError && <p className="display-start-error">{startCompetitionError}</p>}
        </>
      );
    } else if (stage === "categoryVote") {
      mainButton = displayVoteTieLabels.length > 1 ? (
        <div className="display-vote-tie-actions">
          <strong>التصويت متعادل</strong>
          <button type="button" className="tie-random-button" onClick={() => finishCategoryVoteFromDisplay({ chooseRandomTie: true })} disabled={isAdvancingDisplayQuestion}>اختيار عشوائي</button>
          {displayVoteTieLabels.map((label) => (
            <button type="button" className="display-secondary-action" key={`display-tie-${label}`} onClick={() => finishCategoryVoteFromDisplay({ selectedCategory: label })} disabled={isAdvancingDisplayQuestion}>اختيار {label}</button>
          ))}
        </div>
      ) : (
        <button onClick={finishCategoryVoteFromDisplay} disabled={isAdvancingDisplayQuestion}>
          {isAdvancingDisplayQuestion ? "جاري تجهيز السؤال..." : "إغلاق التصويت وتجهيز السؤال"}
        </button>
      );
    } else if (stage === "question") {
      mainButton = <button onClick={() => endQuestionAndReveal(room, { allowUndo: true })}>إنهاء السؤال الآن وإظهار الإجابة الصحيحة</button>;
    } else if (stage === "reveal") {
      mainButton = !room?.practiceMode && isCurrentLastQuestion
        ? <button onClick={handleAnnounceFinalWinners}>إعلان الفائزين</button>
        : (
          <button
            disabled={isShowingResults}
            onClick={async () => {
              if (isShowingResults) return;
              setIsShowingResults(true);
              try { await showResultsFast(room); } catch (e) { console.error(e); } finally { setIsShowingResults(false); }
            }}
          >
            {isShowingResults ? "جاري تحضير النتائج..." : "إظهار النتائج"}
          </button>
        );
    } else if (stage === "results") {
      mainButton = (
        <>
          <div className="results-primary-actions">
            <button onClick={goNextQuestion} disabled={!currentProcessed || isAdvancingDisplayQuestion}>
              {!currentProcessed ? "جاري تجميع النتائج..." : isAdvancingDisplayQuestion ? "جاري تجهيز السؤال..." : (nextQuestionNeedsVote ? "تصويت السؤال التالي" : (nextQuestion ? (nextQuestionIsLast ? "السؤال الأخير" : "السؤال التالي") : (room?.practiceMode ? "إنهاء التجربة" : "إنهاء المسابقة")))}
            </button>
            {!currentProcessed && showForceProcess && (
              <button
                type="button"
                className="force-process-button"
                onClick={handleManualResultCalculation}
                disabled={isManuallyCalculating}
                title="يعيد محاولة احتساب السؤال الحالي فقط، ولا يضاعف النقاط إذا كان محسوبًا مسبقًا."
              >
                {isManuallyCalculating ? "جاري إعادة المحاولة..." : "إعادة المحاولة"}
              </button>
            )}
            {!currentProcessed && showForceProcess && (
              <button
                type="button"
                className="skip-calculation-button"
                onClick={handleSkipCalculation}
                disabled={isSkippingCalculation}
                title="يتجاوز السؤال بدون نقاط ويحفظ الإجابات ويفتح الانتقال للسؤال التالي"
              >
                {isSkippingCalculation ? "جاري التجاوز..." : "تجاوز بدون نقاط"}
              </button>
            )}
          </div>
          {forceRetryError && <span className="display-retry-error">{forceRetryError}</span>}
          {skipNoticeQuestionId === liveQuestionId && (
            <div className="skip-calculation-notice">
              تم التجاوز: النقاط والترتيب لم يتغيرا، والإجابات محفوظة.
            </div>
          )}
        </>
      );
    } else if (stage === "finished") {
      mainButton = showFinalQuestionResults
        ? <button onClick={() => setShowFinalQuestionResults(false)}>العودة للفائزين</button>
        : <button onClick={() => setShowFinalQuestionResults(true)} disabled={!finalQuestion}>نتائج السؤال الأخير</button>;
    } else if (stage === "prizeWheel") {
      mainButton = <button onClick={async () => {
        const fallbackStage = room?.prizeWheel?.previousStage || "registration";
        await updateDoc(doc(db, "rooms", ROOM_ID), {
          stage: fallbackStage === "prizeWheel" ? "registration" : fallbackStage,
          "prizeWheel.spinning": false,
          updatedAt: serverTimestamp(),
        });
      }}>إغلاق سحب الجوائز</button>;
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
    if (stage === "home" || stage === "finished" || stage === "prizeWheel") return null;

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
        {stage === "question" && isMediaQuestion(currentQuestion) && !hasMediaEnded(room, currentQuestion) && (
          <button
            type="button"
            className="display-corner-button media-skip"
            onClick={() => finishMediaQuestion(currentQuestion)}
          >
            تجاوز المقطع وإظهار الخيارات
          </button>
        )}
        {stage === "ready" && (
          <button
            type="button"
            className="display-corner-button ready-skip"
            onClick={handleSkipReadyCountdown}
            title="تخطي العد وبدء السؤال فورًا"
          >
            تخطي العد
          </button>
        )}
        {stage === "results" && room?.practiceMode && currentProcessed && (
          <button
            type="button"
            className="display-corner-button poll"
            onClick={launchInstructionsClarityPoll}
          >
            تصويت
          </button>
        )}
        {stage === "instructions" ? (
          <button type="button" className="display-corner-button poll" onClick={launchInstructionsClarityPoll}>تصويت وضوح المعلومات</button>
        ) : (
          <button type="button" className="display-corner-button poll" onClick={launchSystemCheck}>استفتاء</button>
        )}
      </div>
    );
  }

  return (
    <div className="display-frame">
      <AutoRevealCorrectAnswer room={room} />
      <AutoEndQuestionOnTimer room={room} />
      <AutoActivateReadyQuestion room={room} />
      <AutoLockJokers room={room} players={players} />
      <AutoProcessResults room={room} answers={answers} players={players} />
      <AutoFinishFinalCountdown room={room} players={players} questions={questions} allAnswers={allAnswers} messages={messages} />

      <div className="display-content-area">
        {displayStage === "ready" && (
          <div className="display-panel ready-countdown-screen">
            <div className="ready-countdown-card">
              <span className="ready-countdown-number" key={visibleReadyCountdown}>{visibleReadyCountdown}</span>
              <span className="ready-countdown-label">استعدوا للسؤال التالي</span>
            </div>
          </div>
        )}

        {displayStage === "home" && (
          <div className="display-panel display-home" aria-label={QUIZ_TITLE} />
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

            <DisplaySidePanel messages={messages} videoEnabled={displayVideoSlotEnabled} registrationMode />
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

        {displayStage === "categoryVote" && (
          <div className="display-grid-main">
            <CategoryVoteScreen room={room} players={players} displayMode />
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
          <ResultsDisplay room={displayRoom} players={displayPlayers} messages={messages} answers={displayAnswers} />
        )}

        {displayStage === "prizeWheel" && (
          <PrizeWheelDisplay room={room} players={players} />
        )}

        {displayStage === "finalCountdown" && (
          <FinalCountdownDisplay room={room} />
        )}

        {displayStage === "finished" && (
          showFinalQuestionResults
            ? <ResultsDisplay room={finalQuestionRoom} players={finalQuestionPlayers} messages={messages} answers={finalQuestionAnswers} />
            : <FinishedDisplay players={players} messages={messages} />
        )}
      </div>

      {displayStage !== "home" && displayStage !== "ready" && displayStage !== "prizeWheel" && displayStage !== "finalCountdown" && (
        <div className="display-history-nav" aria-label="التنقل بين مراحل العرض">
          <button type="button" className="display-nav-button display-next-button" onClick={previewNextStep} disabled={!previewStage}>التالي</button>
          <button type="button" className="display-nav-button display-back-button" onClick={previewPreviousStep}>السابق</button>
          {!previewStage && stage === "reveal" && Number(room?.revealUndoUntilMs || 0) > displayNow && getQuestionTimeLeft(currentQuestion, room, displayNow) > 0 && (
            <button type="button" className="display-nav-button display-undo-button" onClick={() => reopenQuestion(room)}>تراجع</button>
          )}
        </div>
      )}

      <div className={`display-presenter-bottom-dock stage-${stage}`} aria-label="أدوات تحكم المقدم">
        <div className="display-control-bar">{renderDisplayButton()}</div>
        {renderBottomDisplayActions()}
      </div>

      {stage === "instructions" && showInstructionsContinue && (
        <div className="modal-backdrop display-continue-backdrop" onClick={() => setShowInstructionsContinue(false)}>
          <div className="modal-card instructions-continue-modal" role="dialog" aria-modal="true" aria-labelledby="instructions-continue-title" onClick={(event) => event.stopPropagation()}>
            <span>الخطوة التالية</span>
            <h2 id="instructions-continue-title">كيف تريد المتابعة؟</h2>
            <div className="instructions-continue-choices">
              <button
                type="button"
                className="continue-real-competition"
                onClick={startCompetition}
                disabled={getMainQuestions(questions).length === 0 || players.length === 0 || isStartingCompetition}
              >
                <strong>{isStartingCompetition ? "جاري البدء..." : "بدء المسابقة الفعلية"}</strong>
                <small>الانتقال مباشرة إلى أسئلة المسابقة والنقاط الرسمية.</small>
              </button>
              <button
                type="button"
                className="continue-practice-questions"
                onClick={startPracticeFromDisplay}
                disabled={players.length === 0 || getPracticeQuestions(questions).length === 0}
              >
                <strong>بدء الأسئلة التجريبية</strong>
                <small>تشغيل تجربة قصيرة قبل بدء المسابقة الفعلية.</small>
              </button>
            </div>
            {startCompetitionError && <p className="display-start-error">{startCompetitionError}</p>}
            <button type="button" className="instructions-continue-cancel" onClick={() => setShowInstructionsContinue(false)}>إلغاء</button>
          </div>
        </div>
      )}
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
  const selectedPrizeWinners = selectedGame?.prizeWinners || [];
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
      {
        name: "فائزون سحب الجوائز",
        headers: ["الفائز", "الاسم الثلاثي", "الجائزة", "المسابقة", "الوقت"],
        rows: (selectedGame.prizeWinners || []).map((winner) => [
          winner.playerName || "",
          winner.playerFullName || "",
          winner.prizeTitle || "",
          winner.gameTitle || selectedGame.title || "",
          winner.awardedAtMs ? new Date(winner.awardedAtMs).toLocaleString("ar-SA") : "",
        ]),
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
        <a className="link-button" href="/?view=control">لوحة التحكم</a>
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

            {renderArchiveSection("prizeWinners", "فائزون سحب الجوائز", selectedPrizeWinners.length === 0 ? <p className="muted">لا توجد جوائز سحب محفوظة في هذه المسابقة.</p> : <div className="archive-table-wrap"><table className="admin-bordered-table archive-table"><thead><tr><th>الفائز</th><th>الاسم الثلاثي</th><th>الجائزة</th><th>المسابقة</th><th>الوقت</th></tr></thead><tbody>{selectedPrizeWinners.map((winner, index) => <tr key={winner.spinId || `${winner.playerId}-${index}`}><td>{winner.playerEmoji || ""} {winner.playerName || "—"}</td><td>{winner.playerFullName || "—"}</td><td>{winner.prizeTitle || "—"}</td><td>{winner.gameTitle || selectedGame.title || "—"}</td><td>{winner.awardedAtMs ? new Date(winner.awardedAtMs).toLocaleString("ar-SA") : "—"}</td></tr>)}</tbody></table></div>)}
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
      <AutoEndQuestionOnTimer room={room} />
      <AutoActivateReadyQuestion room={room} />
      <AutoLockJokers room={room} players={players} />
      <AutoProcessResults room={room} answers={answers} players={players} />
      <AutoFinishFinalCountdown room={room} players={players} questions={questions} allAnswers={allAnswers} messages={messages} />
      <AutoFakeAnswers room={room} players={players} />
    </>
  );

  if (initialView === "settings") {
    return (
      <>
        {alwaysOnAutomations}
        <div className="admin-toolbar card">
          <a className="link-button" href="/?view=control">
            لوحة التحكم
          </a>

          <a
            className="link-button"
            href="/?view=display"
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

function PlayerJoinHero({ subtitle = QUIZ_SUBTITLE }) {
  return (
    <div className="player-join-hero">
      <img className="player-page-logo" src={GROUP_NAME_IMAGE_SRC} alt="قروب العائلة" />
      <p>{subtitle}</p>
    </div>
  );
}

function PlayerPageShell({
  player,
  rank = null,
  rankMovement = null,
  questionNumber = null,
  totalQuestions = null,
  children,
  showStats = true,
  variant = "default",
}) {
  if (!player?.name) return <>{children}</>;

  const lastPoints = Number(player.lastQuestionPoints || 0);
  const hasLastPoints = player.lastQuestionId != null || lastPoints !== 0;
  const movement = Number(rankMovement ?? player.lastRankMovement ?? 0);
  const hasQuestionProgress = Number(totalQuestions) > 0 && Number(questionNumber) > 0;
  const shellClassName =
    variant === "question"
      ? "player-page player-page-question-mode"
      : "player-page";

  return (
    <div className={shellClassName}>
      <div className="player-page-top">
        <div className="player-brand-block">
          <img className="player-page-logo" src={GROUP_NAME_IMAGE_SRC} alt="قروب العائلة" />
        </div>

        <section className="player-overview" aria-label="ملخص المتسابق">
          <div className="player-name-block">
            <span>المتسابق</span>
            <strong>{player.name}</strong>
          </div>

          <div className="player-overview-scoreboard">
            {showStats && (
              <div className="player-total-score-block">
                <span>مجموع النقاط</span>
                <strong><AnimatedNumber value={player.score || 0} /></strong>
                <small>نقطة</small>
              </div>
            )}

            <div className="player-standing-block">
              {rank ? (
                <div className="player-standing-rank">
                  <span>الترتيب</span>
                  <strong>#{rank}</strong>
                </div>
              ) : null}

              {rank ? (
                <div className={`player-standing-movement ${movement > 0 ? "up" : movement < 0 ? "down" : "steady"}`}>
                  <span>من السؤال السابق</span>
                  <strong aria-label={movement > 0 ? `صعد ${movement}` : movement < 0 ? `نزل ${Math.abs(movement)}` : "الترتيب ثابت"}>
                    <b aria-hidden="true">{movement > 0 ? "↑" : movement < 0 ? "↓" : "•"}</b>
                    {movement !== 0 ? Math.abs(movement) : "ثابت"}
                  </strong>
                </div>
              ) : null}
            </div>
          </div>

          {(hasQuestionProgress || showStats) && (
            <div className="player-round-strip">
              {hasQuestionProgress && (
                <div className="player-round-progress">
                  <span>تقدم المسابقة</span>
                  <strong>السؤال {questionNumber} <small>من {totalQuestions}</small></strong>
                </div>
              )}
              {showStats && (
                <div className="player-round-last">
                  <span>نقاط آخر سؤال</span>
                  <strong className={lastPoints > 0 ? "positive" : lastPoints < 0 ? "negative" : "neutral"}>
                    {hasLastPoints ? `${lastPoints > 0 ? "+" : ""}${lastPoints}` : "—"}
                  </strong>
                </div>
              )}
            </div>
          )}
        </section>
      </div>

      <div className="player-page-body">{children}</div>
    </div>
  );
}

function EmojiPicker({ value, onChange, label = "اختيار الإيموجي" }) {
  const [open, setOpen] = useState(false);

  return (
    <div className="emoji-picker">
      <button
        type="button"
        className={value ? "emoji-picker-button" : "emoji-picker-button no-emoji-selected"}
        onClick={() => setOpen((current) => !current)}
        aria-label={label}
        aria-expanded={open}
      >
        {value ? <span>{value}</span> : <small>اختيار</small>}
      </button>

      {open && (
        <div className="emoji-picker-menu" role="listbox" aria-label={label}>
          <button
            type="button"
            className={!value ? "emoji-picker-option no-emoji-option selected" : "emoji-picker-option no-emoji-option"}
            onClick={() => {
              onChange("");
              setOpen(false);
            }}
          >
            <span className="no-emoji-mark" aria-hidden="true" />
            <small>بدون</small>
          </button>
          {PLAYER_EMOJIS.map((item) => (
            <button
              type="button"
              className={value === item ? "emoji-picker-option selected" : "emoji-picker-option"}
              key={item}
              onClick={() => {
                onChange(item);
                setOpen(false);
              }}
            >
              {item}
            </button>
          ))}
        </div>
      )}
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

    if (room?.stage !== "registration" && !room?.registrationOverrideOpen) {
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

  if (room?.stage !== "registration" && !room?.registrationOverrideOpen) {
    return (
      <div className="player-guest-page">
        <PlayerJoinHero />
        <div className="join-card card">
          <h2>بانتظار فتح التسجيل</h2>
          <p className="muted">عندما يفتح المقدم التسجيل، سيظهر لك نموذج الدخول هنا.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="player-guest-page">
      <PlayerJoinHero />
      <div className="join-card card">
      <h2>انضم للمسابقة</h2>
      <p className="muted">اكتب بياناتك. الاسم المستعار هو الذي سيظهر أثناء البث.</p>

      <div className="nickname-emoji-row">
        <EmojiPicker value={emoji} onChange={setEmoji} label="إيموجي اختياري" />
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
    </div>
  );
}

function PlayerChat({ playerId, playerName }) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [open, setOpen] = useState(false);

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
    setOpen(false);
  }

  return (
    <div className={open ? "player-chat open" : "player-chat"}>
      <button
        type="button"
        className="player-chat-toggle"
        onClick={() => setOpen((current) => !current)}
        aria-expanded={open}
        aria-controls="player-chat-panel"
      >
        <span aria-hidden="true">💬</span>
        <b>المقدم</b>
      </button>
      {open && (
        <div className="player-chat-panel" id="player-chat-panel">
          <div className="player-chat-panel-head">
            <strong>رسالة للمقدم</strong>
            <button type="button" onClick={() => setOpen(false)} aria-label="إغلاق المحادثة">×</button>
          </div>
          <label className="player-chat-label" htmlFor="player-chat-input">ستظهر الرسالة مباشرة في لوحة المقدم</label>
          <div className="player-chat-input-wrap">
            <input
              id="player-chat-input"
              autoFocus
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && sendMessage()}
              placeholder="اكتب رسالتك"
            />
            <button type="button" onClick={sendMessage} disabled={!text.trim() || sending}>
              {sending ? "..." : "إرسال"}
            </button>
          </div>
        </div>
      )}
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

  if (stage === "reveal") {
    title = "بانتظار إظهار النتائج";
    text = "سيعرض المقدم نتيجة السؤال بعد قليل.";
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

  const showJoker =
    (((stage === "registration" || stage === "practiceComplete") && room?.practiceFinished) ||
      (stage === "results" && hasNextQuestion));

  return (
    <PlayerPageShell player={player} rank={rank > 0 ? rank : null}>
      <div className="player-status-card player-home-card">
        <div className="player-status-head">
          <div className="player-status-spinner" aria-hidden="true" />
          <div>
            <h2>{title}</h2>
            <p className="muted">{text}</p>
          </div>
        </div>

        {stage === "registration" && (
          <div className="edit-name-box">
            {editingInfo ? (
              <>
                <input
                  value={newNickname}
                  onChange={(e) => setNewNickname(e.target.value)}
                  placeholder="الاسم المستعار"
                />
                <EmojiPicker value={newEmoji} onChange={setNewEmoji} label="تعديل الإيموجي" />
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
              <button type="button" className="player-edit-profile-btn" onClick={() => setEditingInfo(true)}>
                تعديل البيانات
              </button>
            )}
          </div>
        )}

        {showJoker && (
          <div className="player-joker-slot player-home-joker-slot">
            <JokerControl player={player} stage={stage} room={room} />
          </div>
        )}
      </div>

      <PlayerChat playerId={player.id} playerName={player.name} />
    </PlayerPageShell>
  );
}

function PlayerResultSummary({ player, lastAnswer, stage, hasNextQuestion = false, currentQuestion = null, currentQuestionIndex = 0, totalQuestions = null, room = null, rank = null, rankMovement = null }) {
  const points = Number(lastAnswer?.points || 0);
  const basePoints = Number(lastAnswer?.basePoints || 0);
  const isCorrect = !!lastAnswer?.isCorrect;
  const jokerApplied = !!lastAnswer?.jokerApplied;
  const jokerMultiplier = Number(lastAnswer?.jokerMultiplier || 3);
  const answerTimeLabel = lastAnswer ? formatAnswerTime(lastAnswer) : "";
  const isResults = stage === "results";
  const currentQuestionId = currentQuestion?.questionId || currentQuestion?.id || null;
  const isResultsReady = isResults && isSameId(room?.processedQuestionId, currentQuestionId);
  const wasQuestionSkipped = isResultsReady && room?.calculationStatus === "skipped";
  const showBetweenQuestionJoker =
    stage === "results" &&
    hasNextQuestion &&
    (!currentQuestion?.isPractice || currentQuestionIndex === 0);
  const resultPlayer = {
    ...player,
    lastQuestionPoints: points,
    lastQuestionId: lastAnswer?.questionId || player?.lastQuestionId,
  };

  if (isResults && !isResultsReady) {
    return (
      <PlayerPageShell player={player} rank={rank} rankMovement={rankMovement} questionNumber={currentQuestionIndex + 1} totalQuestions={totalQuestions}>
        <div className="player-status-card">
          <div className="player-status-head">
            <div className="player-status-spinner" aria-hidden="true" />
            <div>
              <h2>جاري احتساب نتيجتك</h2>
              <p className="muted">ستظهر النقاط بعد لحظات.</p>
            </div>
          </div>
        </div>
      </PlayerPageShell>
    );
  }

  if (wasQuestionSkipped) {
    return (
      <PlayerPageShell player={player} rank={rank} rankMovement={rankMovement} questionNumber={currentQuestionIndex + 1} totalQuestions={totalQuestions}>
        <div className="player-result-card">
          <div className="player-result-icon">↷</div>
          <h2>تم تجاوز هذا السؤال</h2>
          <p className="muted">لم تُضف أو تُخصم أي نقاط، وترتيبك لم يتغير.</p>
        </div>
      </PlayerPageShell>
    );
  }

  return (
    <PlayerPageShell player={resultPlayer} rank={rank} rankMovement={rankMovement} questionNumber={currentQuestionIndex + 1} totalQuestions={totalQuestions}>
      <div className={`player-result-card ${lastAnswer ? (isCorrect ? "correct" : "wrong") : ""}`}>
        {lastAnswer ? (
          <>
            <div className="player-result-icon">{isCorrect ? "✅" : "❌"}</div>
            <h2>{isCorrect ? "إجابتك صحيحة" : "إجابتك خاطئة"}</h2>

            {isResults ? (
              <div className="player-result-score-strip">
                <div className={`player-result-mini-stat last${points < 0 ? " negative" : ""}`}>
                  <span>نقاط هذا السؤال</span>
                  <strong>
                    {points > 0 ? "+" : ""}{points}
                    {jokerApplied && <span className="player-result-joker-badge">🃏</span>}
                  </strong>
                  {jokerApplied && isCorrect && basePoints > 0 && (
                    <small className="player-result-joker-detail">{basePoints} × {getJokerTimingLabel(jokerMultiplier)}</small>
                  )}
                  {jokerApplied && !isCorrect && (
                    <small className="player-result-joker-detail">الجوكر: خصم النقاط</small>
                  )}
                </div>
                {answerTimeLabel && answerTimeLabel !== "—" && (
                  <div className="player-result-mini-stat total">
                    <span>وقت إجابتك</span>
                    <strong className="player-result-time-val">{answerTimeLabel}</strong>
                  </div>
                )}
              </div>
            ) : (
              <p className="muted">سيتم حساب نقاطك عند إظهار النتائج.</p>
            )}
          </>
        ) : (
          <>
            <div className="player-result-icon">⏳</div>
            <h2>لم تجب على هذا السؤال</h2>
            {isResults && <p className="muted">لا نقاط لهذا السؤال.</p>}
          </>
        )}
      </div>

      {showBetweenQuestionJoker && (
        <div className="player-joker-slot player-home-joker-slot between-question-joker-wrap">
          {currentQuestion?.isPractice && currentQuestionIndex === 0 && (
            <PracticeJokerHint room={room} player={player} inline />
          )}
          <JokerControl player={player} stage={stage} room={{ ...(room || {}), practiceMode: !!currentQuestion?.isPractice }} />
        </div>
      )}

      <PlayerChat playerId={player.id} playerName={player.name} />
    </PlayerPageShell>
  );
}

function PlayerFinalScreen({ player, players }) {
  const rank = players.findIndex((item) => item.id === player?.id) + 1;
  const isWinner = rank >= 1 && rank <= 3;

  return (
    <PlayerPageShell player={player} rank={rank > 0 ? rank : null}>
      <div className={isWinner ? "player-final-card winner" : "player-final-card"}>
        {isWinner && <FallingConfetti />}
        <div className="player-result-icon">{isWinner ? "\u{1F3C6}" : "\u{1F389}"}</div>
        <h2 className={isWinner ? "winner-final-title" : ""}>{isWinner ? `مبروك! فزت بالمركز ${rank}` : "حظ أوفر"}</h2>
        {!isWinner && <p className="muted">ترتيبك النهائي: {rank || "—"}</p>}
      </div>

      <PlayerChat playerId={player.id} playerName={player.name} />
    </PlayerPageShell>
  );
}

function PlayerReadyScreen({ player, rank = null, seconds }) {
  return (
    <PlayerPageShell player={player} rank={rank}>
      <div className="player-ready-card">
        <strong className="player-ready-countdown">{seconds > 0 ? seconds : "..."}</strong>
        <h2>استعد للسؤال التالي</h2>
        <p className="muted">السؤال القادم على وشك البدء</p>
      </div>
    </PlayerPageShell>
  );
}

function PlayerPrizeWinnerScreen({ player, prize, rank = null }) {
  return (
    <PlayerPageShell player={player} rank={rank}>
      <div className="player-prize-card">
        <div className="player-result-icon">🎁</div>
        <h2>مبروك الفوز!</h2>
        <p>فزت في سحب الجوائز</p>
        <strong>{prize?.prizeTitle || "جائزة مفاجئة"}</strong>
      </div>
      <PlayerChat playerId={player.id} playerName={player.name} />
    </PlayerPageShell>
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
  const activeQuestionList = room?.practiceMode
    ? getPracticeQuestions(questions)
    : getMainQuestions(questions);
  const totalQuestions = activeQuestionList.length;
  const hasNextQuestion = !!activeQuestionList[currentQuestionIndex + 1];
  const currentQuestionId = currentQuestion?.questionId || currentQuestion?.id || null;
  const lastAnswer = answers.find((answer) =>
    answer.playerId === playerId &&
    currentQuestionId &&
    String(answer.questionId) === String(currentQuestionId)
  );
  const localAnswerLock = readLocalAnswerLock(playerId, currentQuestion?.questionId);
  const playerRank = players.findIndex((item) => item.id === playerId) + 1;
  const playerRankMovement = Number(
    room?.rankMovementByPlayer?.[playerId] ?? player?.lastRankMovement ?? 0
  );
  const lastAnswerId = lastAnswer?.id;
  const lastAnswerIsCorrect = lastAnswer?.isCorrect;
  const playerNow = useNow(250);
  const readySeconds = Math.max(0, Math.ceil((Number(room?.nextQuestionReadyUntilMs || 0) - playerNow) / 1000));
  const latestPrizeWinner = (room?.prizeWheel?.winners || []).slice(-1)[0] || null;
  const isCurrentPrizeWinner =
    stage === "prizeWheel" &&
    !!latestPrizeWinner &&
    latestPrizeWinner.playerId === playerId &&
    room?.prizeWheel?.winnerPlayerId === playerId;
  const isWaitingForReadyQuestion =
    stage === "ready" ||
    Number(room?.nextQuestionReadyQuestionIndex ?? -1) > currentQuestionIndex &&
    (stage === "instructions" || stage === "registration" || stage === "practiceComplete" || stage === "reveal" || stage === "results");

  useEffect(() => {
    const shouldTrackVisitor =
      !player?.id &&
      (stage === "home" || stage === "registration" || stage === "instructions");

    if (!shouldTrackVisitor) return undefined;

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
  }, [player?.id, player?.name, playerName, stage]);

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
    if (isCurrentPrizeWinner) {
      vibrateDevice([120, 60, 120, 60, 220]);
    }
  }, [isCurrentPrizeWinner, latestPrizeWinner?.spinId]);

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
    const answerStartAtMs = getAnswerStartMs(currentQuestion);
    const answerTimeSeconds = answerStartAtMs ? Math.max(0, (answeredAt - answerStartAtMs) / 1000) : null;

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
      voteCategory: currentQuestion.selectedVoteCategory || null,
      points,
      answeredAt,
      answerStartAtMs,
      answerTimeSeconds,
      createdAt: serverTimestamp(),
    });
  }

  async function handleCategoryVote(categoryLabel) {
    if (!player) return;
    await submitCategoryVote(player, categoryLabel);
  }

  if (stage === "home") {
    return (
      <div className="player-guest-page">
        <PlayerJoinHero />
        <div className="join-card card">
          <h2>بانتظار فتح التسجيل</h2>
          <p className="muted">عندما يفتح المقدم التسجيل، سيظهر لك نموذج الدخول هنا.</p>
        </div>
      </div>
    );
  }

  if ((readySeconds > 0 || isWaitingForReadyQuestion) && player) {
    return (
      <>
        <PlayerHealthCheck room={room} player={player} />
        <PlayerReadyScreen player={player} rank={playerRank || null} seconds={readySeconds} />
      </>
    );
  }

  if (stage === "instructions") {
    return (
      <>
        <PlayerHealthCheck room={room} player={player || { id: localStorage.getItem("familyQuizGuestId") || "", name: "زائر" }} />
        {player ? (
          <PlayerPageShell player={player} rank={playerRank || null}>
            <InstructionsPage />
            {room?.practiceFinished && (
              <div className="player-status-card post-practice-joker-card">
                <div className="player-status-head">
                  <div className="player-status-spinner" aria-hidden="true" />
                  <div>
                    <h2>المسابقة الفعلية بتبدأ بعد قليل</h2>
                    <p className="muted">فعّل الجوكر الآن إذا أردت استخدامه في السؤال الأول.</p>
                  </div>
                </div>
                <div className="player-joker-slot">
                  <JokerControl player={player} stage="registration" />
                </div>
              </div>
            )}
          </PlayerPageShell>
        ) : (
          <>
            <PlayerJoinHero />
            <InstructionsPage />
          </>
        )}
      </>
    );
  }

  if (!playerId || !player) {
    return (
      (stage === "registration" || room?.registrationOverrideOpen) ? (
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
        <div className="player-guest-page">
          <PlayerJoinHero />
          <div className="join-card card">
            <h2>التسجيل مغلق</h2>
            <p className="muted">بانتظار المقدم للخطوة التالية.</p>
          </div>
        </div>
      )
    );
  }

  if (stage === "finished") {
    return (
      <>
        <PlayerHealthCheck room={room} player={player} />
        <PlayerFinalScreen player={player} players={players} />
      </>
    );
  }

  if (stage === "finalCountdown") {
    return (
      <>
        <PlayerHealthCheck room={room} player={player} />
        <PlayerPageShell player={player} rank={playerRank || null}>
          <div className="player-status-card">
            <div className="player-status-head">
              <div className="player-status-spinner" aria-hidden="true" />
              <div>
                <h2>إعلان الفائزين بعد لحظات</h2>
                <p className="muted">استعدوا للنتيجة النهائية.</p>
              </div>
            </div>
          </div>
        </PlayerPageShell>
      </>
    );
  }

  if (isCurrentPrizeWinner) {
    return (
      <>
        <PlayerHealthCheck room={room} player={player} />
        <PlayerPrizeWinnerScreen player={player} prize={latestPrizeWinner} rank={playerRank || null} />
      </>
    );
  }

  if (stage === "categoryVote") {
    return (
      <>
        <PlayerHealthCheck room={room} player={player} />
        <PlayerPageShell player={player} rank={playerRank || null}>
          <CategoryVoteScreen room={room} players={players} player={player} onVote={handleCategoryVote} />
          <PlayerChat playerId={playerId} playerName={player?.name || playerName} />
        </PlayerPageShell>
      </>
    );
  }

  if (readySeconds > 0 || isWaitingForReadyQuestion) {
    return (
      <>
        <PlayerHealthCheck room={room} player={player} />
        <PlayerReadyScreen player={player} rank={playerRank || null} seconds={readySeconds} />
      </>
    );
  }

  if (stage === "results" && currentQuestion) {
    return (
      <>
        <PlayerHealthCheck room={room} player={player} />
        <PlayerResultSummary
        player={player}
        lastAnswer={lastAnswer}
        stage={stage}
        hasNextQuestion={hasNextQuestion}
        currentQuestion={currentQuestion}
        currentQuestionIndex={currentQuestionIndex}
        room={room}
        rank={playerRank || null}
        rankMovement={playerRankMovement}
        totalQuestions={totalQuestions}
      />
      </>
    );
  }

  if (stage !== "question" || !currentQuestion) {
    return (
      <>
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
      <PlayerHealthCheck room={room} player={player} />
      <PlayerPageShell
        player={player}
        rank={playerRank || null}
        rankMovement={playerRankMovement}
        questionNumber={currentQuestionIndex + 1}
        totalQuestions={totalQuestions}
        variant="question"
      >
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
      </PlayerPageShell>
    </>
  );
}

/* App */

function AppCredit() {
  return <div className="app-credit">قام ببرمجة المسابقة: علي إبراهيم ال مطرود</div>;
}

function AdminAccessDisabled() {
  return (
    <div className="app player-app" dir="rtl">
      <div className="card center-card">
        <h2>لوحة الإدارة معطلة مؤقتًا</h2>
        <p className="muted">لوحة الإدارة معطلة مؤقتًا لحين تفعيل نظام الدخول الآمن.</p>
      </div>
      <AppCredit />
    </div>
  );
}

export default function App() {
  const searchParams = new URLSearchParams(window.location.search);
  const viewParam = searchParams.get("view");
  const isDisplayView = viewParam === "display";
  const isAdminViewRequest =
    searchParams.has("admin") ||
    viewParam === "settings" ||
    viewParam === "control" ||
    viewParam === "lastgame";

  if (isDisplayView) {
    return (
      <div className="display-app" dir="rtl">
        <AdminPanel initialView="display" />
        <AppCredit />
      </div>
    );
  }

  if (isAdminViewRequest) {
    if (!LOCAL_ADMIN_DEV_BYPASS) {
      return <AdminAccessDisabled />;
    }

    const adminView =
      viewParam === "settings" || viewParam === "lastgame"
        ? viewParam
        : "control";

    return (
      <div className="app" dir="rtl">
        <AdminPanel initialView={adminView} />
        <AppCredit />
      </div>
    );
  }

  return (
    <div className="app player-app" dir="rtl">
      <PlayerPanel />
      <AppCredit />
    </div>
  );
}
