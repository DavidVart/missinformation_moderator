import { Injectable } from "@angular/core";
import type { SpeakerRole } from "@project-veritas/contracts";
import { BehaviorSubject, Subject } from "rxjs";

import { buildChunkPayload, calculateChunkSampleCount, mergeFloat32Arrays } from "./audio-utils";

const CHUNK_MS = 4000;
const CHUNK_STEP_MS = 3000;
const TARGET_SAMPLE_RATE = 16000;
// V2 client-side VAD: if the peak normalized level stays below this for the
// entire chunk, we consider it silent and skip emitting it. Saves bandwidth
// + matches server-side silence gating.
const SILENCE_PEAK_THRESHOLD = 0.03;

export type EncodedAudioChunk = {
  seq: number;
  startedAt: string;
  endedAt: string;
  pcm16Mono: string;
  speakerRole: SpeakerRole;
};

/** A provider of the current speaker role; invoked on every chunk emit. */
export type SpeakerRoleProvider = () => SpeakerRole;

@Injectable({ providedIn: "root" })
export class AudioCaptureService {
  private audioContext: AudioContext | null = null;
  private mediaStream: MediaStream | null = null;
  private workletNode: AudioWorkletNode | null = null;
  private mutedGainNode: GainNode | null = null;
  private currentBuffer = new Float32Array();
  private currentChunkStartedAtMs: number | null = null;
  private sourceSamplesPerChunk = calculateChunkSampleCount(TARGET_SAMPLE_RATE, CHUNK_MS);
  private sourceSamplesPerStep = calculateChunkSampleCount(TARGET_SAMPLE_RATE, CHUNK_STEP_MS);
  private suppressedUntilMs = 0;
  private sequence = 0;
  /**
   * V2: speaker role provider, set by app.component via startSession.
   * Called once per chunk so a mid-session toggle takes effect immediately.
   */
  private speakerRoleProvider: SpeakerRoleProvider = () => "opponent";

  readonly chunks$ = new Subject<EncodedAudioChunk>();
  readonly levels$ = new BehaviorSubject<number>(0);

  setSpeakerRoleProvider(provider: SpeakerRoleProvider) {
    this.speakerRoleProvider = provider;
  }

  async start() {
    this.sequence = 0;
    this.currentBuffer = new Float32Array();
    this.currentChunkStartedAtMs = null;
    this.suppressedUntilMs = 0;
    this.levels$.next(0);

    if (!globalThis.isSecureContext) {
      throw new Error("Microphone access requires HTTPS or a native app on this device.");
    }

    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error("This browser cannot access the microphone in the current context.");
    }

    this.mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      }
    });

    this.audioContext = new AudioContext();
    this.sourceSamplesPerChunk = calculateChunkSampleCount(this.audioContext.sampleRate, CHUNK_MS);
    this.sourceSamplesPerStep = calculateChunkSampleCount(this.audioContext.sampleRate, CHUNK_STEP_MS);
    await this.audioContext.audioWorklet.addModule("/audio/audio-worklet-processor.js");

    const source = this.audioContext.createMediaStreamSource(this.mediaStream);
    const filter = this.audioContext.createBiquadFilter();
    filter.type = "highpass";
    filter.frequency.value = 100;
    filter.Q.value = 0.707;

    this.workletNode = new AudioWorkletNode(this.audioContext, "moderator-audio-processor");
    this.mutedGainNode = this.audioContext.createGain();
    this.mutedGainNode.gain.value = 0;

    this.workletNode.port.onmessage = (event: MessageEvent<Float32Array>) => {
      const payload = event.data;
      const samples = payload instanceof Float32Array ? payload : new Float32Array(payload);

      if (Date.now() < this.suppressedUntilMs) {
        this.levels$.next(0);
        return;
      }

      const rms = Math.sqrt(samples.reduce((sum, sample) => sum + sample * sample, 0) / Math.max(samples.length, 1));
      const normalizedLevel = Math.min(1, rms * 8);
      this.levels$.next(normalizedLevel);
      this.currentBuffer = mergeFloat32Arrays(this.currentBuffer, samples);

      if (this.currentChunkStartedAtMs === null) {
        this.currentChunkStartedAtMs = Date.now();
      }

      while (this.currentBuffer.length >= this.sourceSamplesPerChunk) {
        const chunkSamples = this.currentBuffer.slice(0, this.sourceSamplesPerChunk);
        this.currentBuffer = this.currentBuffer.slice(this.sourceSamplesPerStep);

        const chunkStartedAtMs: number = this.currentChunkStartedAtMs ?? Date.now();
        const chunkEndedAtMs: number = chunkStartedAtMs + CHUNK_MS;

        // V2 client-side VAD: check the chunk's peak amplitude. If it never
        // exceeds our silence threshold, skip this chunk entirely (don't send
        // to the backend). Saves bandwidth + avoids paying Whisper to
        // hallucinate on near-silent audio.
        let peakAmplitude = 0;
        for (let i = 0; i < chunkSamples.length; i += 1) {
          const abs = Math.abs(chunkSamples[i] ?? 0);
          if (abs > peakAmplitude) {
            peakAmplitude = abs;
          }
        }

        this.currentChunkStartedAtMs = chunkStartedAtMs + CHUNK_STEP_MS;

        if (peakAmplitude < SILENCE_PEAK_THRESHOLD) {
          // Silent chunk — bump the sequence but don't emit to preserve
          // monotonic seq numbers across the session.
          this.sequence += 1;
          continue;
        }

        const chunk = buildChunkPayload(
          chunkSamples,
          this.audioContext?.sampleRate ?? TARGET_SAMPLE_RATE,
          new Date(chunkStartedAtMs).toISOString(),
          new Date(chunkEndedAtMs).toISOString()
        );

        this.sequence += 1;
        this.chunks$.next({
          seq: this.sequence,
          ...chunk,
          speakerRole: this.speakerRoleProvider()
        });
      }
    };

    source.connect(filter);
    filter.connect(this.workletNode);
    this.workletNode.connect(this.mutedGainNode);
    this.mutedGainNode.connect(this.audioContext.destination);
  }

  suppressFor(durationMs: number) {
    this.suppressedUntilMs = Math.max(this.suppressedUntilMs, Date.now() + Math.max(durationMs, 0));
    this.currentBuffer = new Float32Array();
    this.currentChunkStartedAtMs = null;
    this.levels$.next(0);
  }

  async stop() {
    this.workletNode?.disconnect();
    this.mutedGainNode?.disconnect();

    // Flush remaining buffer as a final chunk so the last few seconds aren't lost
    const minSamples = calculateChunkSampleCount(
      this.audioContext?.sampleRate ?? TARGET_SAMPLE_RATE,
      1000 // at least 1 second of audio to be worth sending
    );
    if (this.currentBuffer.length >= minSamples && this.currentChunkStartedAtMs !== null) {
      const chunkStartedAtMs = this.currentChunkStartedAtMs;
      const durationMs = Math.round((this.currentBuffer.length / (this.audioContext?.sampleRate ?? TARGET_SAMPLE_RATE)) * 1000);
      const chunk = buildChunkPayload(
        this.currentBuffer,
        this.audioContext?.sampleRate ?? TARGET_SAMPLE_RATE,
        new Date(chunkStartedAtMs).toISOString(),
        new Date(chunkStartedAtMs + durationMs).toISOString()
      );
      this.sequence += 1;
      this.chunks$.next({ seq: this.sequence, ...chunk, speakerRole: this.speakerRoleProvider() });
    }

    this.mediaStream?.getTracks().forEach((track) => track.stop());
    this.mediaStream = null;

    if (this.audioContext && this.audioContext.state !== "closed") {
      await this.audioContext.close();
    }

    this.audioContext = null;
    this.workletNode = null;
    this.mutedGainNode = null;
    this.currentBuffer = new Float32Array();
    this.currentChunkStartedAtMs = null;
    this.sourceSamplesPerChunk = calculateChunkSampleCount(TARGET_SAMPLE_RATE, CHUNK_MS);
    this.sourceSamplesPerStep = calculateChunkSampleCount(TARGET_SAMPLE_RATE, CHUNK_STEP_MS);
    this.suppressedUntilMs = 0;
    this.levels$.next(0);
  }
}
