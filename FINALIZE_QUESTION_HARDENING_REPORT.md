# Operation 4 — Server-side question finalization hardening

Date: 2026-07-23

## 1. Goal

`finalizeQuestion` is now the authoritative server implementation for question correctness,
points, joker application, ranking, idempotency, and result persistence. The callable no
longer trusts result fields supplied by an answer document. React was intentionally left
unchanged and is not connected to this hardened callable yet.

## 2. New callable contract

Accepted data:

```json
{
  "roomId": "safe non-empty identifier, maximum 128 characters",
  "questionId": "safe non-empty identifier, maximum 128 characters"
}
```

No other input field is accepted. In particular, the callable rejects client-supplied
`points`, `isCorrect`, joker data, ranks, score deltas, correct answers, or result snapshots.

Authentication:

- `request.auth` is required;
- `request.auth.token.admin` must be exactly `true`.

Success:

```json
{
  "success": true,
  "status": "finalized",
  "questionId": "...",
  "runId": "...",
  "counts": {}
}
```

A call after success returns the same official result identity with
`status: "already-finalized"`.

Expected errors:

| Code | Meaning |
|---|---|
| `unauthenticated` | No authenticated Firebase user |
| `permission-denied` | Authenticated user lacks the Admin custom claim |
| `invalid-argument` | Invalid ID or an unexpected input field |
| `not-found` | Room missing or requested question is not active |
| `failed-precondition` | Invalid room stage, incomplete question contract, legacy partial state, or more than 400 players |
| `aborted` | A live finalization owns the lock |
| `internal` | Unexpected internal failure, without exposing a stack or player data |

## 3. Sources of truth

| Value | Authoritative source |
|---|---|
| Active question and correct answer | `rooms/{roomId}.currentQuestion.correctIndex` |
| Question value and duration | Active question `minPoints`, `maxPoints`, and `seconds` |
| Official question start/end | Active question `answerStartAtMs` and `answerEndAtMs` |
| Player selection | Answer document `selectedIndex` |
| Answer time | Answer document `createdAt` Firestore server Timestamp |
| Joker state | Player document question ID, timing, multiplier, and server `jokerLockedAt` |
| Correctness | Server comparison of `selectedIndex` with `correctIndex` |
| Points | Server-only pure calculation |
| Ranking | Server-only score sort |
| Historical result | `rooms/{roomId}/questionResults/{questionId}` |

The answer document's `answeredAt`, `points`, `basePoints`, `isCorrect`, `jokerApplied`, and
`jokerMultiplier` are not trusted for official scoring.

## 4. Security validation

The callable validates Authentication and the Admin claim before reading the room. It then
validates:

- both IDs and the absence of extra input;
- room existence;
- active question identity;
- allowed stage (`question` or `results`);
- options and `correctIndex`;
- finite point limits, positive duration, and valid start/end times;
- the atomic player limit;
- absence of a legacy partial player update.

Emulator tests create synthetic Admin and normal users in Authentication Emulator, apply
custom claims with the emulator Admin SDK, and obtain real emulator ID tokens. No service
account or default Google credentials are used.

## 5. Points and joker rules

Base points preserve the React baseline formula:

```text
elapsed = max(0, answer.createdAt - question.answerStartAtMs)
ratio = clamp((seconds - elapsedSeconds) / seconds, 0, 1)
basePoints = round(minPoints + ratio * (maxPoints - minPoints))
```

Rules:

- correct without joker: `basePoints`;
- wrong without joker: `0`;
- correct official x2: `basePoints × 2`;
- correct official x3: `basePoints × 3`;
- wrong with an official joker: `-basePoints`.

The joker is applied only when the player document proves:

- it belongs to the current question;
- timing is `before` with x3 or `during` with x2;
- multiplier is exactly 2 or 3;
- `jokerLockedAt` is a server Timestamp consistent with question/answer timing.

Invalid joker state is ignored and counted diagnostically. It is never defaulted to x3.

## 6. Idempotency, locking, and recovery

Finalization uses a generated `runId` and two short transactions:

1. claim the room using `finalization.status = "processing"`;
2. atomically read, calculate, and commit all player updates, the result document, and the
   completed room state.

A live lock is valid for 30 seconds. Another call receives `aborted`. A stale or failed lock
may be claimed by a later Admin call. After success, the independent result document is the
idempotency authority and later calls return `already-finalized`.

The scoring transaction updates all players, creates the result, and marks the room completed
atomically. It cannot publish half the scores. If a post-claim failure occurs, a guarded
transaction changes only the matching `runId` to `failed`, clears the legacy processing
fields, and leaves all scores unchanged. This was tested with 401 synthetic players.

The atomic implementation supports at most 400 non-visitor players. This keeps player writes,
the result create, and room update below Firestore's 500-write transaction limit.

## 7. Answer selection and result storage

For duplicate answers, the official answer is the first valid answer ordered by:

1. Firestore server `createdAt`;
2. answer document ID as deterministic tie-breaker.

Malformed answers are ignored and counted. Orphan answers are counted diagnostically but do
not create players or enter player results. With no answers, every player receives zero
question points and the question completes normally.

Every result is stored independently at:

```text
rooms/{roomId}/questionResults/{questionId}
```

It contains `questionId`, `runId`, server finalization time, counts, and one compact official
result per player. The compatibility fields used by the current interface remain on the room,
and `questionResultsById` is merged per question rather than replaced.

Ranking is score descending, then `playerId` ascending for deterministic ties. Player
documents receive official score, rank, question points, correctness, and last-answer data.

## 8. Test results

Environment: Node 24.15.0, npm 11.12.1, Firebase CLI 15.20.0, Java 21.0.11,
Node built-in test runner, project `demo-family-quiz`.

| Test group | Result | Notes |
|---|---|---|
| Pure unit tests | 8/8 passed | Formula, input, Admin, answer selection, joker, ranking |
| Full integration suite | 19/19 passed | Auth, correctness, safety, history, failure, concurrency |
| 50 players | 3/3 passed | 35 correct, 10 wrong, 5 unanswered |
| 100 players | 1/1 passed | 100 players, 90 answers |
| Authentication | Passed | Admin accepted; unauthenticated and normal user rejected |
| Client result tampering | Passed | Absurd `points` and false `isCorrect` ignored |
| Duplicate answers | Passed | Earliest valid server Timestamp wins |
| Missing/inactive data | Passed | Clear `not-found` / `failed-precondition` |
| Orphan/malformed answers | Passed | Diagnostic only |
| No answers | Passed | Safe zero-point completion |
| Invalid joker | Passed | Ignored and counted |
| Historical results | Passed | Previous document and compatibility entry preserved |
| Concurrent/repeated calls | Passed | No double score or duplicate result |
| Stale lock | Passed | Recovered after 30-second threshold |
| Post-claim failure | Passed | `failed` state, zero partial score writes |
| Production-safety guard | Passed | Tests refuse to run without local emulator hosts |
| Build | Passed | Existing Vite large-chunk warning only |
| ESLint | Passed | Root and Functions files clean |

Final measured callable round trips:

| Scenario | Run 1 (cold) | Run 2 | Run 3 |
|---|---:|---:|---:|
| 50 players | 2,429.51 ms | 276.58 ms | 194.23 ms |
| 100 players | 2,682.34 ms | — | — |

Approximate finalization writes are 53 for 50 players and 103 for 100 players: one lock
write, one update per player, one official result create, and one completed room update.

## 9. Baseline comparison

| Area | Operation 3 baseline | Operation 4 |
|---|---|---|
| Authentication | None | Firebase Authentication + `admin === true` |
| Correctness | Trusted answer `isCorrect` | Compared server-side |
| Points | Trusted answer `points` | Recalculated server-side |
| Answer time | Client numeric field | Firestore server `createdAt` |
| Joker | Trusted answer metadata | Validated player state |
| Duplicates | Later answer won; both counted | Earliest valid server-timestamped answer wins |
| Orphans | Entered result maps | Diagnostic count only |
| Result history | Room map replaced | Independent result document + merged compatibility map |
| Atomicity | Player batch then room update | One atomic scoring transaction |
| Repeat response | Busy/processed skip | Official `already-finalized` result identity |
| Failure recovery | Lock release best effort | Owned `failed` state and stale-lock recovery |
| Tie ranking | No explicit tie-breaker | `playerId` ascending |

Compared with the recorded Operation 3 baseline, 50-player cold time rose from 2,155.55 ms
to 2,429.51 ms (about 13%). Warm times rose from 152.71/151.17 ms to
276.58/194.23 ms. The 100-player time rose from 2,229.87 ms to 2,682.34 ms (about 20%).
The increase is expected from token verification, the explicit lock transaction, server-side
validation, and the independent result document.

## 10. Remaining risks

- React still calculates and writes result-like answer fields locally; those fields are now
  ignored by this function but the competing React result path remains until the next operation.
- React is not authenticated as an Admin and is not yet connected to this callable.
- `createdAt` is a trusted server Timestamp, but direct answer writes are still allowed by the
  temporary permissive emulator rules.
- The official question start/end values are stored on the room but are currently written by
  the client flow; production rules/server orchestration must protect them.
- Player joker fields are server-timestamped but are currently written directly by the client
  under permissive rules.
- Firestore and Realtime Database rules remain temporary development rules and were not changed.
- The atomic limit is 400 players.
- The result document stores one compact row per player; document-size monitoring is still
  recommended if the player schema or limit grows.

## 11. Next operation

Connect the Admin React flow to authenticated `finalizeQuestion`, remove the competing local
result calculation path, and update the interface to consume the official result document.
Production Authentication and restrictive Rules should be designed alongside that integration.

That work was not performed in Operation 4.
