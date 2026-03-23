import { Injectable } from "@angular/core";
import { BehaviorSubject, Subject } from "rxjs";

import { buildChunkPayload, calculateChunkSampleCount, mergeFloat32Arrays } from "./audio-utils";

const CHUNK_MS = 4000;
const CHUNK_STEP_MS = 2000;
const TARGET_SAMPLE_RATE = 16000;

export type EncodedAudioChunk = {
  seq: number;
  startedAt: string;
  endedAt: string;
  pcm16Mono: string;
};

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

  readonly chunks$ = new Subject<EncodedAudioChunk>();
  readonly levels$ = new BehaviorSubject<number>(0);

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
        const chunk = buildChunkPayload(
          chunkSamples,
          this.audioContext?.sampleRate ?? TARGET_SAMPLE_RATE,
          new Date(chunkStartedAtMs).toISOString(),
          new Date(chunkEndedAtMs).toISOString()
        );

        this.sequence += 1;
        this.chunks$.next({
          seq: this.sequence,
          ...chunk
        });
        this.currentChunkStartedAtMs = chunkStartedAtMs + CHUNK_STEP_MS;
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
