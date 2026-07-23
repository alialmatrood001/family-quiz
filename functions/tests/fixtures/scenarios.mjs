export function calculateBasePoints({ maxPoints = 1000, minPoints = 100, seconds = 20, elapsedSeconds }) {
  const ratio = Math.max(0, Math.min(1, (seconds - elapsedSeconds) / seconds));
  return Math.round(minPoints + ratio * (maxPoints - minPoints));
}

export function calculateFinalPoints({ isCorrect, basePoints, jokerApplied, jokerMultiplier = 3 }) {
  if (jokerApplied) return isCorrect ? basePoints * Number(jokerMultiplier || 3) : -basePoints;
  return isCorrect ? basePoints : 0;
}

export function buildScenario({
  roomId,
  questionId = "question-baseline-01",
  playerCount = 50,
  correctCount = 35,
  wrongCount = 10,
} = {}) {
  const answerStartAtMs = 1_800_000_000_000;
  const question = {
    id: questionId,
    questionId,
    text: "Baseline emulator question",
    options: ["A", "B", "C", "D"],
    correctIndex: 1,
    maxPoints: 1000,
    minPoints: 100,
    seconds: 20,
    answerStartAtMs,
    answerEndAtMs: answerStartAtMs + 20_000,
    resultsCalculated: false,
  };

  const players = Array.from({ length: playerCount }, (_, index) => {
    const number = index + 1;
    const id = `player-${String(number).padStart(3, "0")}`;
    const jokerMultiplier = number % 10 === 0 ? 3 : number % 7 === 0 ? 2 : null;
    const jokerTiming = jokerMultiplier === 3 ? "before" : jokerMultiplier === 2 ? "during" : null;
    return {
      id,
      name: `Player ${String(number).padStart(3, "0")}`,
      emoji: number % 2 ? "🟦" : "🟩",
      score: number <= 6 ? number * 25 : 0,
      answeredCount: number % 4,
      jokerUsed: jokerMultiplier !== null,
      jokerQuestionId: jokerMultiplier !== null ? questionId : null,
      jokerMultiplier,
      jokerTiming,
      jokerLockedAtMs:
        jokerTiming === "before"
          ? answerStartAtMs - 1_000
          : jokerTiming === "during"
            ? answerStartAtMs + 500
            : null,
      unrelatedPlayerField: `keep-${id}`,
    };
  });

  const answers = [];
  const answeredCount = Math.min(playerCount, correctCount + wrongCount);
  for (let index = 0; index < answeredCount; index += 1) {
    const number = index + 1;
    const player = players[index];
    const isCorrect = index < correctCount;
    const elapsedSeconds = 1 + ((index * 7) % 19);
    const basePoints = calculateBasePoints({ elapsedSeconds });
    const jokerApplied = player.jokerMultiplier !== null;
    const points = calculateFinalPoints({
      isCorrect,
      basePoints,
      jokerApplied,
      jokerMultiplier: player.jokerMultiplier || 3,
    });
    answers.push({
      id: `answer-${String(number).padStart(3, "0")}`,
      playerId: player.id,
      playerName: player.name,
      questionId,
      selectedIndex: isCorrect ? 1 : 0,
      isCorrect,
      basePoints,
      jokerApplied,
      jokerMultiplier: jokerApplied ? player.jokerMultiplier : null,
      jokerTiming: jokerApplied ? (player.jokerMultiplier === 2 ? "during" : "before") : null,
      points,
      answeredAt: answerStartAtMs + elapsedSeconds * 1000,
      createdAtMs: answerStartAtMs + elapsedSeconds * 1000,
      answerStartAtMs,
      answerTimeSeconds: elapsedSeconds,
    });
  }

  return {
    roomId,
    questionId,
    question,
    room: {
      stage: "question",
      currentQuestion: question,
      currentQuestionIndex: 0,
      resultsCalculated: false,
      questionIgnored: false,
      unrelatedSentinel: { operation: 3, keep: true },
      updatedAtMs: answerStartAtMs,
    },
    players,
    answers,
  };
}

export function expectedScoreByPlayer(scenario) {
  const points = new Map(scenario.answers.map((answer) => [answer.playerId, Number(answer.points || 0)]));
  return new Map(
    scenario.players.map((player) => [
      player.id,
      Number(player.score || 0) + Number(points.get(player.id) || 0),
    ])
  );
}
