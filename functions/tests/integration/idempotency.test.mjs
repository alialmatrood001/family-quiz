import assert from "node:assert/strict";
import test from "node:test";
import {
  callFinalizeQuestion,
  deleteRoom,
  emitMetric,
  readState,
  writeScenario,
} from "../helpers/emulator.mjs";
import { buildScenario } from "../fixtures/scenarios.mjs";

test("concurrent and sequential repeats do not apply points twice", { timeout: 30_000 }, async (t) => {
  const scenario = buildScenario({
    roomId: "baseline-idempotency",
    playerCount: 12,
    correctCount: 8,
    wrongCount: 2,
  });
  t.after(() => deleteRoom(scenario.roomId));
  await writeScenario(scenario);

  const startedAt = performance.now();
  const concurrent = await Promise.allSettled([
    callFinalizeQuestion({ roomId: scenario.roomId, questionId: scenario.questionId }),
    callFinalizeQuestion({ roomId: scenario.roomId, questionId: scenario.questionId }),
  ]);
  emitMetric("idempotency_concurrent_pair", performance.now() - startedAt);

  const fulfilled = concurrent.filter((item) => item.status === "fulfilled").map((item) => item.value);
  const rejected = concurrent.filter((item) => item.status === "rejected").map((item) => item.reason);
  assert.equal(fulfilled.filter((item) => item.status === "finalized").length, 1);
  assert.ok(
    fulfilled.some((item) => item.status === "already-finalized") ||
      rejected.some((error) => error.code === "ABORTED")
  );

  const afterConcurrent = await readState(scenario.roomId);
  const scoresAfterConcurrent = Object.fromEntries(
    afterConcurrent.players.map((player) => [player.id, player.score])
  );
  const snapshotAfterConcurrent = afterConcurrent.room.resultsDisplaySnapshot;

  const sequential = await callFinalizeQuestion({
    roomId: scenario.roomId,
    questionId: scenario.questionId,
  });
  assert.equal(sequential.success, true);
  assert.equal(sequential.status, "already-finalized");
  assert.equal(
    sequential.runId,
    fulfilled.find((item) => item.status === "finalized").runId
  );

  const afterSequential = await readState(scenario.roomId);
  assert.deepEqual(
    Object.fromEntries(afterSequential.players.map((player) => [player.id, player.score])),
    scoresAfterConcurrent
  );
  assert.deepEqual(afterSequential.room.resultsDisplaySnapshot, snapshotAfterConcurrent);
});
