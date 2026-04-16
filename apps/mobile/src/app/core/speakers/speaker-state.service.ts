import { Injectable, signal } from "@angular/core";
import type { SpeakerRole } from "@project-veritas/contracts";
import { Haptics, ImpactStyle } from "@capacitor/haptics";

/**
 * V2 Debate Mode — owns the "who is currently speaking" state.
 *
 * The user taps a segmented toggle in the Live view to switch between
 * "You" and "Opponent". Each audio chunk emitted by the audio capture
 * service reads this signal at emission time so mid-session toggles
 * take effect on the very next chunk.
 *
 * Default: "opponent" — the whole point of the app is to catch the OTHER
 * person's misinformation, so that's the mode we open in.
 */
@Injectable({ providedIn: "root" })
export class SpeakerStateService {
  /** Current speaker for new audio chunks. */
  readonly currentSpeaker = signal<SpeakerRole>("opponent");

  /**
   * Switch speaker. Triggers a light haptic pulse on native so the user feels
   * the change without having to look at the screen.
   */
  async setSpeaker(role: SpeakerRole) {
    if (this.currentSpeaker() === role) {
      return;
    }
    this.currentSpeaker.set(role);
    try {
      await Haptics.impact({ style: ImpactStyle.Light });
    } catch {
      // Haptics plugin missing on web / older devices — no-op.
    }
  }

  /** Toggle between self and opponent. */
  async toggle() {
    const next: SpeakerRole = this.currentSpeaker() === "self" ? "opponent" : "self";
    await this.setSpeaker(next);
  }

  /** Reset to default (opponent) when a session ends. */
  reset() {
    this.currentSpeaker.set("opponent");
  }
}
