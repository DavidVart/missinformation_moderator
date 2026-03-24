# Real Talk (Project Veritas) — Claude Code Guidelines

## Project Overview
Real Talk is a real-time misinformation detection app. Users speak into their phone, audio is transcribed via Whisper, claims are fact-checked via OpenAI + Tavily, and corrections are pushed back in real-time.

## Architecture
- **Frontend**: Angular + Ionic mobile app (`apps/mobile/`) deployed on Vercel
- **Backend**: Node.js microservices (`services/`) deployed on Render, communicating via Redis Streams (Upstash)
- **Database**: Supabase (PostgreSQL)
- **Auth**: Clerk (Google, X, email sign-in)
- **Pipeline**: Audio → Ingestion (Socket.IO) → Transcription (OpenAI Whisper API) → Reasoning (OpenAI + Tavily) → Notification → Client

## Key Rules

### Sentry Monitoring (MANDATORY)
Every bug fix or feature that touches error-prone paths MUST include Sentry instrumentation:
- Use `Sentry.captureException(error)` for caught errors in backend services
- Use `Sentry.captureMessage()` for important state transitions or degraded-mode fallbacks
- Add `Sentry.setContext()` or `Sentry.setTag()` to enrich error reports with session/user context
- Backend services import Sentry from `@project-veritas/observability`
- Frontend (Angular) uses the existing `@sentry/angular` integration in `sentry.service.ts`
- Never swallow errors silently — if a catch block doesn't rethrow, it must report to Sentry

### Code Style
- All services are ESM (`"type": "module"`)
- TypeScript strict mode
- Zod for runtime validation
- Pino for structured logging (via `@project-veritas/observability`)
- Environment variables validated with `createEnv()` from `@project-veritas/config`

### Deployment
- Frontend: Vercel (auto-deploys from `main`)
- Backend: Render (7 services defined in `render.yaml`)
- Secrets managed via Render Environment Groups (`real-talk-env`)
- CORS_ORIGIN must match the Vercel deployment URL

### Testing
- Run `npm run build -w <workspace>` to verify compilation
- Each service has `npm run typecheck` for type-only validation
- Tests use Vitest: `npm test -w <workspace>`

### Common Pitfalls
- Ionic's `ion-content` uses Shadow DOM — avoid `position: fixed` inside it; use plain flexbox layouts instead
- Clerk's `openSignIn()` requires UI components to be loaded first — always guard with `isReady` check or use `redirectToSignIn()` as fallback
- Bundle budgets in `angular.json` may need increasing when adding large SDKs
- Redis Streams consumer groups must be unique per service instance (use UUID suffix)
