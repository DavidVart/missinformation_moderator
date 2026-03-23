import { Injectable } from "@angular/core";

@Injectable({ providedIn: "root" })
export class SpeechService {
  estimateDurationMs(text: string) {
    const wordCount = text.trim().split(/\s+/).filter(Boolean).length;
    return Math.min(14_000, Math.max(1_800, wordCount * 380));
  }

  async speak(text: string) {
    if (!("speechSynthesis" in window)) {
      return 0;
    }

    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = 1;
    utterance.pitch = 1;

    return await new Promise<number>((resolve) => {
      const fallbackDurationMs = this.estimateDurationMs(text);
      const startedAtMs = performance.now();

      utterance.onend = () => {
        resolve(Math.max(fallbackDurationMs, Math.round(performance.now() - startedAtMs)));
      };

      utterance.onerror = () => {
        resolve(fallbackDurationMs);
      };

      window.speechSynthesis.speak(utterance);
    });
  }
}
