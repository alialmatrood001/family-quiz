# Operation 3 — Firebase Emulator baseline tests

Date: 2026-07-23
Branch: `feature/reliability-upgrade`
Starting commit (Operation 2): `b1567eb4ba495364fa10682bbddba9f078f385b5`

## 1. Scope and safety

This operation added tests and documentation only. It did not change:

- `src/App.jsx`
- `functions/index.js`
- Firestore or Realtime Database rules
- scoring, joker, ranking, question, answer, or results behavior
- production configuration or secrets

No deploy or push was run. All integration data used the Firebase demo project namespace
`demo-family-quiz`; Firebase CLI explicitly reports that a demo project cannot reach
non-emulated services.

The test bootstrap refuses to run unless Firestore, Authentication, and Realtime Database
emulator hosts are present and local (`127.0.0.1`, `localhost`, or `::1`). It additionally:

- requires a Functions Emulator signal or the explicit demo project namespace;
- invokes `finalizeQuestion` only at `http://127.0.0.1:5001`;
- rejects a non-demo Google Cloud project ID;
- rejects `GOOGLE_APPLICATION_CREDENTIALS`;
- initializes Firebase Admin with only `{ projectId: "demo-family-quiz" }`;
- cleans every synthetic room before and after its test.

A direct run outside `firebase emulators:exec` was intentionally attempted and stopped before
any connection with: `FIRESTORE_EMULATOR_HOST is required; refusing to run outside Firebase Emulator Suite`.

## 2. Test framework and files

The suite uses the Node.js built-in test runner (`node:test`) and the existing
`firebase-admin` dependency under `functions`. No package was installed or upgraded.

Environment:

| Component | Version or value |
|---|---|
| Node.js | 24.15.0 |
| npm | 11.12.1 |
| Firebase CLI | 15.20.0 |
| Java | OpenJDK/Temurin 21.0.11 LTS |
| Test framework | Node.js built-in test runner |
| Local project ID | `demo-family-quiz` |
| Emulator UI | `127.0.0.1:4000` |
| Functions | `127.0.0.1:5001` |
| Firestore | `127.0.0.1:8080` |
| Realtime Database | `127.0.0.1:9000` |
| Authentication | `127.0.0.1:9099` |

Structure:

```text
functions/tests/
  helpers/emulator.mjs
  fixtures/scenarios.mjs
  integration/baseline-50.test.mjs
  integration/idempotency.test.mjs
  integration/edge-cases.test.mjs
  integration/performance.test.mjs
```

Root commands:

```text
npm run test:baseline
npm run test:baseline:50
npm run test:baseline:edge
npm run test:baseline:performance
```

Each root command starts the required emulators, runs its tests, and shuts the emulators down
automatically.

## 3. Current data contract captured by the tests

Firestore paths used by `finalizeQuestion`:

```text
rooms/{roomId}
rooms/{roomId}/players/{playerId}
rooms/{roomId}/answers/{answerId}
```

Relevant room fields:

- `stage`
- `currentQuestion`
- `questionIgnored`
- `processedQuestionId`
- `resultsCalculated`
- `resultsCalculatedQuestionId`
- `processingQuestionId`
- `processingStartedAtMs`
- `questionResultsById`
- `collectingBonusByPlayer`
- `collectingBonusJokerByPlayer`
- `collectingAnswerCorrectByPlayer`
- `rankMovementByPlayer`
- `resultsDisplaySnapshot`
- `calculationStatus`

Relevant player fields:

- `id`, `name`, `emoji`, `score`, `answeredCount`
- `jokerUsed`, `jokerQuestionId`, `jokerMultiplier`
- `lastQuestionId`, `lastQuestionPoints`, `lastQuestionCorrect`, `lastAnswerAt`

An answer is eligible when it has a `playerId`, a matching `questionId`, and a non-negative
integer `selectedIndex`. The result function then consumes client-supplied `points`,
`isCorrect`, `jokerApplied`, `jokerMultiplier`, and `answeredAt`.

Callable input:

```json
{
  "roomId": "optional; defaults to family-quiz-001",
  "questionId": "required",
  "nextStage": "results by default, or null"
}
```

Successful output is `{ "success": true, "skipped": false }`. A repeated or busy call returns
`{ "success": false, "skipped": true, "reason": "already-processed-or-busy" }`.

## 4. Scoring, joker, ranking, snapshot, and lock baseline

The client currently calculates base points linearly:

```text
round(minPoints + clamp((seconds - elapsedSeconds) / seconds, 0, 1)
      * (maxPoints - minPoints))
```

Final client points are:

- correct without joker: `basePoints`;
- wrong without joker: `0`;
- correct with joker: `basePoints * jokerMultiplier`;
- wrong with joker: `-basePoints` (the penalty is not multiplied).

`finalizeQuestion` does not recalculate that formula. It adds the answer document's `points`
value to the current player score. Joker multiplier `2` is displayed as `x2`; every other
truthy/ defaulted multiplier is displayed as `x3`.

Players are sorted by descending numeric score before and after the update. There is no
explicit secondary tie-breaker. The Functions snapshot contains all non-visitor players in
`leaderboardBefore` and `leaderboardAfter`.

The duplicate-prevention lock uses `processingQuestionId` and `processingStartedAtMs`.
A lock for the same question is considered fresh for 9,000 ms. Completed-question fields and
`player.lastQuestionId` provide additional repeat guards.

## 5. Deterministic 50-player baseline

Each of three consecutive runs created:

- 50 synthetic players;
- 35 correct answers;
- 10 wrong answers;
- 5 players without answers;
- answer times spread deterministically from fast to near the end;
- x2 and x3 joker cases;
- a wrong x3 joker answer using the current `-basePoints` behavior;
- different initial scores for six players.

All three runs passed. Every run verified:

- exactly 50 players remained and no player was added;
- exactly 45 answers remained;
- all expected scores matched the current formula and stored answer points;
- unanswered player scores did not change;
- the result snapshot contained all 50 players;
- `answersCount = 45` and `correctCount = 35`;
- unrelated room and player sentinel fields remained intact;
- the leaderboard matched descending score order.

Measured callable time:

| Run | Time |
|---|---:|
| 1 (cold) | 2,155.55 ms |
| 2 | 152.71 ms |
| 3 | 151.17 ms |

Fixture creation timings in the same run:

| Run | Create 50 players | Create 45 answers |
|---|---:|---:|
| 1 | 62.62 ms | 38.74 ms |
| 2 | 27.99 ms | 27.88 ms |
| 3 | 24.46 ms | 24.88 ms |

An earlier complete-suite execution measured 2,039.77 ms cold, then 147.79 ms and
149.51 ms for the callable round trip.

The fixture and callable write counts are approximately:

- fixture: 96 writes (one room, 50 players, 45 answers);
- `finalizeQuestion`: 51 writes (50 player updates and one room update);
- cleanup writes are additional and are limited to the demo emulator namespace.

## 6. Repeated and concurrent invocation

The concurrent test issued two requests for the same room/question at the same time:

- exactly one returned success;
- exactly one returned `already-processed-or-busy`;
- the pair completed in 1,559.54 ms in the recorded run;
- a third sequential call returned the same skip response;
- player scores and the result snapshot were byte-for-byte equivalent before and after the
  third call.

Current idempotency behavior therefore passed this baseline: points were not applied twice.

## 7. Edge-case baseline

| Case | Captured current behavior | Status |
|---|---|---|
| Missing room | Creates the room and finalizes an empty result instead of rejecting | Diagnostic risk |
| Missing `questionId` | Function throws, but caller receives only `INTERNAL` | Diagnostic risk |
| Unknown question in existing room | Accepted and finalized | Diagnostic risk |
| No answers | Finishes safely, preserves scores, writes zero-answer result | Passed |
| Answer for missing player | Does not crash; orphan remains in result maps/count | Diagnostic risk |
| Duplicate answers | Both count; chronologically later answer supplies the score | Diagnostic risk |
| Absurd client points | `99,999,999` is accepted and added | Critical diagnostic risk |
| Missing optional answer fields | Points become `0`; correctness becomes `false` | Captured |
| Negative `selectedIndex` | Answer is ignored | Passed |
| Joker multiplier `99` | Supplied points are trusted and display label becomes `x3` | Diagnostic risk |
| No Authentication | Callable request succeeds | Critical diagnostic risk |
| Prior `questionResultsById` entry | Replaced by the new one | High diagnostic risk |
| Fresh processing lock | Returns `already-processed-or-busy` | Passed |
| Cleanup | Synthetic room is deleted | Passed |

The dedicated edge suite passed 14/14 after its expectation was aligned with the callable
protocol's actual `INTERNAL` error response. No production behavior was changed.

## 8. Performance diagnostic

A deterministic run with 100 players and 90 answers completed successfully:

- create 100 players: 98.16 ms;
- create 90 answers: 58.16 ms;
- callable round trip/result completion: 2,229.87 ms;
- Functions Emulator execution: 630.89 ms;
- 100 players remained;
- 90 answers remained;
- the after-results snapshot contained all 100 players;
- no timeout or partial result occurred.

Its fixture used 191 writes (one room, 100 players, 90 answers), and
`finalizeQuestion` performed approximately 101 writes (100 players plus the room result).
The callable response is returned only after the room result update completes, so the measured
callable round trip is also the observed result-completion time.

This is a local emulator measurement, not a production capacity guarantee.

## 9. Limitations

- Emulator timings do not predict production latency or capacity.
- These tests preserve the current behavior, including behavior that is unsafe or incorrect.
- The callable has no Authentication authorization requirement at this baseline.
- Firestore and Realtime Database rules are temporary permissive development rules.
- The tests do not copy or depend on production data.

## 10. Risks discovered or confirmed

### Critical

1. `finalizeQuestion` accepts unauthenticated requests.
2. It trusts client-supplied `points`, `isCorrect`, and joker metadata; an absurd score is
   applied without server-side validation.

### High

3. A missing room and an unrelated question ID are accepted and finalized.
4. A new result replaces the entire `questionResultsById` map, removing prior entries.
5. Duplicate answers are counted individually while the later answer determines the player's
   applied points.
6. Player-score writes and the room result write are separate commits, so a failure between
   them can leave partial state.

### Medium

7. Orphan answers affect counts and result maps even though no player receives their points.
8. Invalid joker multipliers are not validated and are displayed as `x3`.
9. Missing `questionId` reaches the client only as a generic `INTERNAL` error.
10. Ranking ties have no explicit deterministic secondary key.

These findings are intentionally not fixed in Operation 3.

## 11. Commands and results

| Command | Result |
|---|---|
| `npm run test:baseline:50` | Passed, 3/3 |
| `npm --prefix functions run test:baseline:50` outside emulators | Refused as designed |
| `npm run test:baseline` (initial) | 17/18; one test expectation exposed callable `INTERNAL` masking |
| `npm run test:baseline:edge` after expectation correction | Passed, 14/14 |
| `npm run test:baseline:performance` | Passed, 1/1 |
| `npm run test:baseline` (final) | Passed, 18/18 |
| `npm run build` | Passed; Vite warned that the main chunk exceeds 500 kB |
| `npm run lint` | Failed only on the 6 pre-existing CommonJS `no-undef` errors in `functions/index.js` |

The final complete-suite rerun measured the three 50-player calls at 2,339.30 ms cold,
191.59 ms, and 147.58 ms. Its concurrent invocation pair measured 1,828.47 ms.

## 12. Recommended next operation

The next operation should use these tests as a fixed safety net while hardening
`finalizeQuestion`: require authenticated/authorized admin access, validate the room and active
question, calculate trusted results server-side from validated answer inputs, preserve prior
question-result history, and make score plus room-result persistence atomic or recoverable.

That work is not part of Operation 3 and was not executed here.
