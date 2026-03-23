FROM node:22-bullseye-slim

WORKDIR /app

COPY package.json package-lock.json tsconfig.base.json ./
COPY apps/mobile/package.json ./apps/mobile/package.json
COPY packages/contracts/package.json ./packages/contracts/package.json
COPY packages/config/package.json ./packages/config/package.json
COPY packages/observability/package.json ./packages/observability/package.json
COPY services/ingestion/package.json ./services/ingestion/package.json
COPY services/transcription/package.json ./services/transcription/package.json
COPY services/reasoning/package.json ./services/reasoning/package.json
COPY services/notification/package.json ./services/notification/package.json
COPY services/history/package.json ./services/history/package.json

RUN npm ci

COPY . .

ENV NODE_ENV=development

CMD ["node", "--import", "tsx", "services/ingestion/src/index.ts"]
