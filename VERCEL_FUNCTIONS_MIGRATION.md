# Vercel Functions migration layer

## Scope

Operation 8 adds a local Vercel-compatible HTTP layer without changing the React client, deleting Firebase Cloud Functions, connecting production, or deploying anything.

## Architecture

The server has one business-operation registry:

- `functions/server/operations.js` constructs the existing secure-write and finalization handlers once.
- `functions/server/firebase-admin.js` owns the singleton Firebase Admin runtime.
- `functions/server/firebase-callable.js` adapts the shared operations to Firebase Callable requests.
- `api/_lib/http.js` adapts the same operations to a bounded HTTP protocol for Vercel.

The scoring, ranking, joker, answer, privacy, and finalization implementations remain in their existing domain and handler modules. The API layer does not copy them.

## HTTP routes

All operation routes accept `POST` with:

```json
{
  "action": "submitAnswer",
  "data": {}
}
```

Successful responses use `{ "ok": true, "data": {} }`. Failed responses use `{ "ok": false, "error": { "code": "...", "message": "..." } }`.

- `/api/player`: `registerPlayer`, `recoverPlayer`, `submitAnswer`, `activateJoker`, `cancelJoker`, `updatePlayerProfile` for the authenticated owner only
- `/api/quiz`: `prepareQuestion`, `startQuestion`, `controlQuestion`, `finalizeQuestion`
- `/api/admin`: `adjustPlayerScore`, `getPlayerPrivateDetails`, `updatePlayerProfile`, `deletePlayer`, `resetPracticeScores`, `resetQuizData`
- `/api/health`: safe `GET` health check; it does not initialize Firebase or return project details

Browser preflight `OPTIONS` is accepted only for allowed origins. Other methods are rejected.

## Authentication and privacy

Operation routes require a Firebase ID token in `Authorization: Bearer <token>`. The server verifies it with Firebase Admin Auth and derives the UID only from the verified token. `/api/admin` and `/api/quiz` additionally require the exact custom claim `admin: true`; an email address is never an authorization signal.

Player ownership remains enforced by the shared transaction handlers against `playerPrivate.authUid`. The owner profile action accepts only the existing profile allowlist (`name`, `emoji`, `fullName`, and `phone`) and rejects score, rank, joker, identity, and other administrative fields. The admin route can use the same operation for any player after the endpoint verifies `admin: true`. Public player responses and documents do not include `phone`, `fullName`, or `authUid`. Private details are exposed only by the admin route.

The HTTP adapter:

- limits JSON request bodies to 32 KiB;
- allows local Vite origins plus explicitly configured origins;
- maps domain/Firebase errors to stable HTTP statuses and codes;
- never sends a stack trace;
- does not log tokens, phone numbers, or private player data.

## Environment variable names

Local emulator execution:

- `GCLOUD_PROJECT`
- `FIRESTORE_EMULATOR_HOST`
- `FIREBASE_AUTH_EMULATOR_HOST`
- `FIREBASE_DATABASE_EMULATOR_HOST`

Future Vercel server runtime:

- `FIREBASE_ADMIN_PROJECT_ID`
- `FIREBASE_ADMIN_CLIENT_EMAIL`
- `FIREBASE_ADMIN_PRIVATE_KEY`
- `FIREBASE_DATABASE_URL`
- `VERCEL_ALLOWED_ORIGINS`

No values or credentials are committed. Emulator tests refuse service-account credentials and require project namespace `demo-family-quiz`.

## Temporary compatibility

Firebase Cloud Functions remain exported from `functions/index.js`. Their Callable wrappers now call the shared registry, so existing React calls continue to use Firebase Functions with unchanged response shapes and authorization behavior.

React has not been converted to `/api/*`. No production domain, Vercel project, Firebase production project, environment secret, or deployment was configured in this operation.

## Local verification

- `npm run test:vercel-api`
- `npm run test:vercel-smoke`
- `npm run vercel:emulator-safety` (must run inside an active Emulator Suite environment)

The complete existing Firebase test commands, lint, and build remain available from the root `package.json`.

## Deferred to operation 9

- Add production secrets through the hosting platform's encrypted environment settings after an explicit security review.
- Confirm the Vercel build installs server-only dependencies from the intended package boundary.
- Configure the exact staging Vercel origin through `VERCEL_ALLOWED_ORIGINS`.
- Convert React calls endpoint by endpoint, preserving fallback/rollback to Firebase Callable.
- Add deployment configuration and staged network-level smoke tests only after explicit authorization.
