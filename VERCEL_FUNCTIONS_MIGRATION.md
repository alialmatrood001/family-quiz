# Vercel Functions migration layer

## Scope

Operation 8 added the local Vercel-compatible HTTP layer. Operation 9 routes the existing React client wrappers through one transport adapter without deleting Firebase Cloud Functions, connecting production, or deploying anything.

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

- `FIREBASE_ADMIN_AUTH_MODE`
- `FIREBASE_ADMIN_PROJECT_ID`
- `FIREBASE_PRODUCTION_PROJECT_ID`
- `CONFIRM_STAGING_PROJECT`
- `FIREBASE_DATABASE_URL`
- `GOOGLE_CLOUD_PROJECT`
- `GCP_PROJECT_NUMBER`
- `GCP_WORKLOAD_IDENTITY_POOL_ID`
- `GCP_WORKLOAD_IDENTITY_PROVIDER_ID`
- `GCP_SERVICE_ACCOUNT_EMAIL`
- `VERCEL_OIDC_ISSUER`
- `VERCEL_OIDC_AUDIENCE`
- `VERCEL_OIDC_SUBJECT`
- `STAGING_ORIGIN`
- `PRODUCTION_ORIGIN`
- `VERCEL_ALLOWED_ORIGINS`

`VERCEL_OIDC_TOKEN` is supplied by Vercel to the function request and is never a
manually configured application variable. The runtime exchanges it in memory
through Google Workload Identity Federation and service-account impersonation.
No credential file or private key is required. The legacy
`FIREBASE_ADMIN_CLIENT_EMAIL` plus `FIREBASE_ADMIN_PRIVATE_KEY` mode remains
available only when explicitly selected and cannot coexist with OIDC settings.

No values or credentials are committed. Emulator tests refuse service-account
credentials and require project namespace `demo-family-quiz`.

## Temporary compatibility

Firebase Cloud Functions remain exported from `functions/index.js`. Their Callable wrappers now call the shared registry, so existing React calls continue to use Firebase Functions with unchanged response shapes and authorization behavior.

React wrappers now use `src/server-api-client.js`. `VITE_SERVER_TRANSPORT=vercel` selects the relative `/api/*` routes, while an absent value or `VITE_SERVER_TRANSPORT=callable` keeps the existing Firebase Callable path. Any other value fails clearly instead of silently selecting a transport. No production domain, Vercel project, Firebase production project, environment secret, or deployment was configured.

## React operation transport table

| Operation | Old transport | New adapter | Vercel endpoint | Authentication |
|---|---|---|---|---|
| `registerPlayer` | Firebase Callable | `serverApiClient.registerPlayer` | `/api/player` | Anonymous Firebase user |
| `recoverPlayer` | Firebase Callable | `serverApiClient.recoverPlayer` | `/api/player` | Anonymous Firebase user |
| `submitAnswer` | Firebase Callable | `serverApiClient.submitAnswer` | `/api/player` | Player ID token; ownership checked server-side |
| `activateJoker` | Firebase Callable | `serverApiClient.activateJoker` | `/api/player` | Player ID token; ownership checked server-side |
| `cancelJoker` | Firebase Callable | `serverApiClient.cancelJoker` | `/api/player` | Player ID token; ownership checked server-side |
| `updatePlayerProfile` | Firebase Callable | `serverApiClient.updatePlayerProfile` | `/api/player` | Owner or admin, enforced server-side |
| `prepareQuestion` | Firebase Callable | `serverApiClient.prepareQuestion` | `/api/quiz` | Admin claim |
| `startQuestion` | Firebase Callable | `serverApiClient.startQuestion` | `/api/quiz` | Admin claim |
| `controlQuestion` | Firebase Callable | `serverApiClient.controlQuestion` | `/api/quiz` | Admin claim |
| `finalizeQuestion` | Firebase Callable | `serverApiClient.finalizeQuestion` | `/api/quiz` | Admin claim |
| `adjustPlayerScore` | Firebase Callable | `serverApiClient.adjustPlayerScore` | `/api/admin` | Admin claim |
| `getPlayerPrivateDetails` | Firebase Callable | `serverApiClient.getPlayerPrivateDetails` | `/api/admin` | Admin claim |
| `deletePlayer` | Firebase Callable | `serverApiClient.deletePlayer` | `/api/admin` | Admin claim |
| `resetPracticeScores` | Firebase Callable | `serverApiClient.resetPracticeScores` | `/api/admin` | Admin claim |
| `resetQuizData` | Firebase Callable | `serverApiClient.resetQuizData` | `/api/admin` | Admin claim |

The Vercel transport sends the current Firebase ID token. A 401 response triggers exactly one forced token refresh and one retry. Other failures are not retried. Normal operations time out after 10 seconds; `finalizeQuestion` uses 25 seconds. Existing single-flight wrappers remain in place.

## Rollback

Set:

```dotenv
VITE_SERVER_TRANSPORT=callable
```

Then rebuild the client. This switches every migrated operation back to Firebase Callable without changing React components or server data.

## PWA and caching

The project currently has no Service Worker, Workbox configuration, or Vite PWA plugin. `/api/*` therefore remains browser network-only. Vercel requests also set `cache: "no-store"`. Tests prevent adding a direct API cache strategy or moving `httpsCallable` outside the dedicated adapter.

## Local verification

- `npm run test:vercel-api`
- `npm run test:vercel-smoke`
- `npm run test:server-client`
- `npm run vercel:emulator-safety` (must run inside an active Emulator Suite environment)

The complete existing Firebase test commands, lint, and build remain available from the root `package.json`.

## Proposed operation 10 (not executed)

- Add production secrets through the hosting platform's encrypted environment settings after an explicit security review.
- Confirm the Vercel build installs server-only dependencies from the intended package boundary.
- Configure the exact staging Vercel origin through `VERCEL_ALLOWED_ORIGINS`.
- Configure a Vercel staging project and `VITE_SERVER_TRANSPORT=vercel` only after explicit authorization.
- Run real staging-domain CORS, token-refresh, timeout, and rollback smoke tests.
- Observe error rates and latency before considering any production transport change.
- Keep Firebase Callable available until staging acceptance and a rollback exercise are complete.

No deployment has been performed.
