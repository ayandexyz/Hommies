/** Plays the bridge's notification sounds through PipeWire (`pw-play`) or PulseAudio (`paplay`). */
import { execFile } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** `attention`: permissions, questions, waiting replies; `error`: failed turns; `finished`: turn ends. */
export type BridgeSound = "attention" | "error" | "finished";

export type BridgeSoundPlayer = (sound: BridgeSound) => void;

/** Sounds closer together than this are dropped, so a burst of items plays once. */
const minGapMs = 1_000;

/** `sounds/` next to `dist/` in the package. */
const defaultSoundsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "sounds");

export function createSoundPlayer(soundsDir: string = defaultSoundsDir): BridgeSoundPlayer {
  let lastPlayed = 0;
  return (sound) => {
    const now = Date.now();
    if (now - lastPlayed < minGapMs) return;
    lastPlayed = now;
    const file = join(soundsDir, `${sound}.wav`);
    execFile("pw-play", [file], { timeout: 5_000 }, (error) => {
      // No PipeWire client: try PulseAudio. With neither, stay silent.
      if (error && (error as NodeJS.ErrnoException).code === "ENOENT") {
        execFile("paplay", [file], { timeout: 5_000 }, () => undefined);
      }
    });
  };
}
