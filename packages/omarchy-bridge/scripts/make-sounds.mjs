#!/usr/bin/env node
/**
 * Synthesizes the bridge's notification sounds into `sounds/`. They are
 * original to this repository (MIT, like the code): short sine chimes with a
 * soft attack and an exponential decay. Re-run after changing a recipe:
 *
 *   node scripts/make-sounds.mjs
 */
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const sampleRate = 44_100;
const out = fileURLToPath(new URL("../sounds/", import.meta.url));

/** Each note: frequency (Hz), start and length (seconds), peak gain. */
const recipes = {
  // Rising two-note chime: something needs you.
  attention: [{ freq: 659.25, start: 0, length: 0.32, gain: 0.5 }, { freq: 880, start: 0.11, length: 0.42, gain: 0.5 }],
  // Falling, lower pair: the turn stopped on an error.
  error: [{ freq: 440, start: 0, length: 0.3, gain: 0.55 }, { freq: 329.63, start: 0.14, length: 0.46, gain: 0.55 }],
  // One soft high note: the turn finished.
  finished: [{ freq: 1046.5, start: 0, length: 0.38, gain: 0.35 }],
};

function render(notes) {
  const seconds = Math.max(...notes.map((note) => note.start + note.length)) + 0.02;
  const samples = new Float64Array(Math.ceil(seconds * sampleRate));
  for (const note of notes) {
    const first = Math.floor(note.start * sampleRate);
    const count = Math.floor(note.length * sampleRate);
    for (let index = 0; index < count; index++) {
      const time = index / sampleRate;
      const attack = Math.min(1, time / 0.008);
      const decay = Math.exp(-time / (note.length / 4));
      // A quiet octave above rounds out the pure sine.
      const wave = Math.sin(2 * Math.PI * note.freq * time) + 0.18 * Math.sin(4 * Math.PI * note.freq * time);
      samples[first + index] += note.gain * attack * decay * wave / 1.18;
    }
  }
  return samples;
}

function wav(samples) {
  const data = Buffer.alloc(samples.length * 2);
  samples.forEach((sample, index) => data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, sample)) * 32_767), index * 2));
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

await mkdir(out, { recursive: true });
for (const [name, notes] of Object.entries(recipes)) {
  await writeFile(`${out}${name}.wav`, wav(render(notes)));
  process.stdout.write(`sounds/${name}.wav\n`);
}
