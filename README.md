# Project Veritas

Project Veritas is a real-time fact-checking platform built as a TypeScript microservices monorepo. The v1 stack combines an Ionic Angular client, Redis Streams, Postgres persistence, a Faster-Whisper worker, and an OpenAI/Tavily reasoning pipeline.

## Workspaces

- `apps/mobile`: Ionic Angular monitoring client with Web Audio capture, live transcript feed, and intervention playback.
- `services/ingestion`: Socket.io edge service for audio ingestion and session routing.
- `services/transcription`: Redis consumer that forwards audio chunks to the Faster-Whisper worker.
- `services/reasoning`: Claim detection and live verification pipeline using LangChain.
- `services/notification`: Intervention formatter and publisher.
- `services/history`: Postgres-backed history API and persistence consumer.
- `packages/contracts`: Shared event schemas and TypeScript contracts.
- `packages/config`: Shared configuration, environment validation, and stream constants.
- `packages/observability`: Structured logging helpers.

## Local development

1. Install dependencies with `npm install`.
2. Copy `.env.example` to `.env` and provide API keys for live reasoning.
3. Start the local workspace with `npm run workspace:local:start`.
4. Open `http://127.0.0.1:4200` on the laptop or the printed LAN URL on another device.
5. Stop everything with `npm run workspace:local:stop`.

The local workspace script starts Redis in Docker, boots the Faster-Whisper worker, launches the five Node services, and serves the built mobile client over the LAN. Live verification requires `OPENAI_API_KEY` and `TAVILY_API_KEY`.
