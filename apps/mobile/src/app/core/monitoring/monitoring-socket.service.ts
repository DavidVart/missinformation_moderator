import { Injectable } from "@angular/core";
import { interventionMessageSchema, SessionMode, transcriptSegmentSchema } from "@project-veritas/contracts";
import { BehaviorSubject, Subject } from "rxjs";
import { io, Socket } from "socket.io-client";
import { environment } from "../../../environments/environment";

type SocketAck = {
  ok: boolean;
  sessionId?: string;
  error?: string;
};

const SOCKET_TIMEOUT_MS = 4000;
const BACKEND_OFFLINE_MESSAGE = "Fact-check backend is offline. Start the ingestion service and try again.";

function preferredLanguage() {
  const rawLanguage = globalThis.navigator?.language?.trim();
  if (!rawLanguage) {
    return undefined;
  }

  const [language] = rawLanguage.split("-");
  return language?.toLowerCase();
}

/** Detect Capacitor native runtime via the injected Capacitor global. */
function isCapacitorNative(): boolean {
  const cap = (globalThis as Record<string, unknown>)["Capacitor"] as
    | { isNativePlatform?: () => boolean }
    | undefined;
  return !!cap?.isNativePlatform?.();
}

const RENDER_SOCKET_URL = "https://real-talk-ingestion.onrender.com";

function resolveSocketUrl(): string {
  // 1. Explicit environment config (production)
  if (environment.socketUrl) {
    return environment.socketUrl;
  }

  // 2. Runtime override via global variable
  const globalOverride = (globalThis as typeof globalThis & { __VERITAS_SOCKET_URL__?: string }).__VERITAS_SOCKET_URL__;
  if (globalOverride) {
    return globalOverride;
  }

  // 3. Capacitor native — always use deployed backend
  if (isCapacitorNative()) {
    return RENDER_SOCKET_URL;
  }

  // 4. Local dev — same hostname, port 4000
  const defaultHost = globalThis.location?.hostname || "localhost";
  return `http://${defaultHost}:4000`;
}

@Injectable({ providedIn: "root" })
export class MonitoringSocketService {
  private readonly socket: Socket;
  readonly transcript$ = new Subject<ReturnType<typeof transcriptSegmentSchema.parse>>();
  readonly intervention$ = new Subject<ReturnType<typeof interventionMessageSchema.parse>>();
  readonly connectionState$ = new BehaviorSubject<"connecting" | "connected" | "offline">("connecting");

  constructor() {
    const socketUrl = resolveSocketUrl();

    this.socket = io(socketUrl, {
      autoConnect: false,
      transports: ["polling", "websocket"]
    });

    this.socket.on("connect", () => {
      this.connectionState$.next("connected");
    });

    this.socket.on("disconnect", () => {
      this.connectionState$.next("offline");
    });

    this.socket.on("connect_error", () => {
      this.connectionState$.next("offline");
    });

    this.socket.on("transcript:update", (payload) => {
      this.transcript$.next(transcriptSegmentSchema.parse(payload));
    });

    this.socket.on("intervention:created", (payload) => {
      this.intervention$.next(interventionMessageSchema.parse(payload));
    });
  }

  connect() {
    if (!this.socket.connected) {
      this.socket.connect();
    }
  }

  async startSession(deviceId: string, mode: SessionMode = "debate_live", userId?: string) {
    await this.ensureConnected();

    const ack = await this.emitWithAck("session:start", {
      deviceId,
      ...(userId ? { userId } : {}),
      mode,
      chunkMs: 4000,
      sampleRate: 16000,
      preferredLanguage: preferredLanguage()
    });

    if (ack.ok && ack.sessionId) {
      return ack.sessionId;
    }

    throw new Error(ack.error ?? "Unable to start monitoring session");
  }

  async sendChunk(payload: {
    sessionId: string;
    seq: number;
    startedAt: string;
    endedAt: string;
    pcm16Mono: string;
  }) {
    const ack = await this.emitWithAck("audio:chunk", payload);

    if (!ack.ok) {
      throw new Error(ack.error ?? "Unable to send audio chunk");
    }
  }

  async stopSession(sessionId: string) {
    if (!this.socket.connected) {
      return;
    }

    const ack = await this.emitWithAck("session:stop", { sessionId });

    if (!ack.ok) {
      throw new Error(ack.error ?? "Unable to stop session");
    }
  }

  private async ensureConnected() {
    if (this.socket.connected) {
      this.connectionState$.next("connected");
      return;
    }

    this.connectionState$.next("connecting");

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const timeoutHandle = globalThis.setTimeout(() => {
        if (settled) {
          return;
        }

        settled = true;
        cleanup();
        this.connectionState$.next("offline");
        reject(new Error(BACKEND_OFFLINE_MESSAGE));
      }, SOCKET_TIMEOUT_MS);

      const cleanup = () => {
        globalThis.clearTimeout(timeoutHandle);
        this.socket.off("connect", onConnect);
        this.socket.off("connect_error", onConnectError);
      };

      const onConnect = () => {
        if (settled) {
          return;
        }

        settled = true;
        cleanup();
        this.connectionState$.next("connected");
        resolve();
      };

      const onConnectError = () => {
        if (settled) {
          return;
        }

        settled = true;
        cleanup();
        this.connectionState$.next("offline");
        reject(new Error(BACKEND_OFFLINE_MESSAGE));
      };

      this.socket.once("connect", onConnect);
      this.socket.once("connect_error", onConnectError);
      this.socket.connect();
    });
  }

  private emitWithAck<TPayload extends object>(event: string, payload: TPayload) {
    return new Promise<SocketAck>((resolve, reject) => {
      if (!this.socket.connected) {
        reject(new Error(BACKEND_OFFLINE_MESSAGE));
        return;
      }

      this.socket.timeout(SOCKET_TIMEOUT_MS).emit(event, payload, (error: Error | null, ack: SocketAck) => {
        if (error) {
          reject(new Error(BACKEND_OFFLINE_MESSAGE));
          return;
        }

        resolve(ack);
      });
    });
  }
}
