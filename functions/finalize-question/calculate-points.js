"use strict";

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function calculateBasePoints({
  maxPoints,
  minPoints,
  seconds,
  answerStartAtMs,
  answeredAtMs,
}) {
  const elapsedSeconds = Math.max(0, answeredAtMs - answerStartAtMs) / 1000;
  const ratio = clamp((seconds - elapsedSeconds) / seconds, 0, 1);
  return Math.round(minPoints + ratio * (maxPoints - minPoints));
}

function calculateQuestionPoints({
  isCorrect,
  maxPoints,
  minPoints,
  seconds,
  answerStartAtMs,
  answeredAtMs,
  jokerMultiplier = null,
}) {
  const basePoints = calculateBasePoints({
    maxPoints,
    minPoints,
    seconds,
    answerStartAtMs,
    answeredAtMs,
  });
  if (!jokerMultiplier) {
    return { basePoints, points: isCorrect ? basePoints : 0 };
  }
  return {
    basePoints,
    points: isCorrect ? basePoints * jokerMultiplier : -basePoints,
  };
}

module.exports = { calculateBasePoints, calculateQuestionPoints };
