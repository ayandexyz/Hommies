#!/usr/bin/env node
// Renders the marketplace preview (1600×900): Hommie in each mood, plus his
// expressions. The drawing code is not copied: the engine's functions are
// read out of packages/bell-plugin/characters/Hommie.qml, so the image always
// matches the real character. Needs Chromium.
//
//   node scripts/render-preview.mjs [out.png]     (default: ./preview.png)
//   node scripts/render-preview.mjs --outfits [out.png]   every outfit instead
//
// The published plugin keeps it as hommies-plugin/preview.png.

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const args = process.argv.slice(2);
const outfitSheet = args.includes("--outfits");
const out = resolve(args.find((arg) => !arg.startsWith("--")) ?? (outfitSheet ? "outfits.png" : "preview.png"));
const qml = readFileSync(join(root, "packages/bell-plugin/characters/Hommie.qml"), "utf8");

/** Every `function name(...) { ... }` inside the engine QtObject, as plain JS. */
function engineFunctions(source) {
  const start = source.indexOf("id: engine");
  const end = source.indexOf("// Extra room around the character");
  const body = source.slice(start, end);
  const functions = [];
  const pattern = /\n\s*function (\w+)\s*\(/g;
  let match;
  while ((match = pattern.exec(body)) !== null) {
    let index = body.indexOf("{", match.index);
    let depth = 0;
    const from = match.index;
    for (; index < body.length; index++) {
      if (body[index] === "{") depth++;
      else if (body[index] === "}" && --depth === 0) break;
    }
    functions.push({ name: match[1], code: body.slice(from, index + 1).trim() });
  }
  return functions;
}

/** A `readonly property var name: <value>` from the engine, evaluated as JS. */
function engineValue(source, name) {
  const at = source.indexOf(`readonly property var ${name}:`);
  if (at < 0) throw new Error(`no ${name} in Hommie.qml`);
  let index = source.indexOf(":", at) + 1;
  while (source[index] === " ") index++;
  const open = source[index];
  const close = { "[": "]", "{": "}", "(": ")" }[open];
  let depth = 0;
  const from = index;
  for (; index < source.length; index++) {
    if (source[index] === open) depth++;
    else if (source[index] === close && --depth === 0) break;
  }
  return source.slice(from, index + 1);
}

const functions = engineFunctions(qml);
const wanted = ["easeOut", "easeInOut", "easeBack", "lerp", "moodColor", "rgba", "roundRect", "starPath", "draw", "drawEyes",
  "drawEyeShape", "drawBadge", "drawParticles", "drawDizzyStars", "eyeFor", "emoteWeight", "outfitColor", "drawOutfit", "drawGlasses"];
const missing = wanted.filter((name) => !functions.some((fn) => fn.name === name));
if (missing.length > 0) throw new Error(`Hommie.qml is missing ${missing.join(", ")}`);
const engineCode = functions.filter((fn) => wanted.includes(fn.name)).map((fn) => fn.code).join("\n\n");

// Tokyo Night, as the shell themes it.
const theme = {
  bg: "#16161e", card: "#1a1b26", border: "#292e42", title: "#c0caf5", subtitle: "#7982a9", label: "#a9b1d6",
  accent: "#7aa2f7", working: "#0db9d7", warning: "#eb927b", success: "#b9f27c", error: "#ff7a93", text: "#c0caf5",
};

// Each card freezes the engine at one moment. `mood` sets the colour, eyes,
// and badge; the rest overrides the animated state.
const moodCards = [
  { label: "No pending items", mood: "idle" },
  { label: "Agents working…", mood: "working", s: { snakeOn: 1, snakeAt: 9 } },
  { label: "Rate limited", mood: "ratelimit", particles: [{ type: "sweat", x: 0.05, y: -0.95, vx: 0, vy: 0, age: 0.4, life: 1.6, rot: 0, size: 0.18 }] },
  { label: "Needs your approval", mood: "approval", s: { oy: -0.03 } },
  { label: "Has a question for you", mood: "question", s: { tilt: 0.12 } },
  { label: "Done — 2 to review", mood: "finished" },
  { label: "A turn failed", mood: "error" },
  { label: "Zzz… no agents running", mood: "sleeping", particles: [
    { type: "z", x: 0.85, y: -1.0, vx: 0.12, vy: -0.25, age: 0.5, life: 1.6, rot: 0, size: 0.16 },
    { type: "z", x: 0.85, y: -1.0, vx: 0.14, vy: -0.24, age: 1.3, life: 1.8, rot: 0, size: 0.21 },
  ] },
  { label: "Celebrates finished turns", mood: "idle", emote: "celebrate", s: { oy: -0.1 }, color: "success", particles: [
    { type: "spark", x: -0.55, y: -0.8, vx: 0, vy: 0, age: 0.5, life: 1.5, rot: 0.3, size: 0.2 },
    { type: "spark", x: 0.6, y: -0.9, vx: 0, vy: 0, age: 0.5, life: 1.5, rot: 1.1, size: 0.17 },
    { type: "spark", x: 0.05, y: -1.15, vx: 0, vy: 0, age: 0.5, life: 1.5, rot: 0.7, size: 0.15 },
    { type: "spark", x: -0.85, y: -0.25, vx: 0, vy: 0, age: 0.5, life: 1.5, rot: 2.0, size: 0.13 },
    { type: "spark", x: 0.9, y: -0.3, vx: 0, vy: 0, age: 0.5, life: 1.5, rot: 0.2, size: 0.14 },
  ] },
  { label: "Poke him five times", mood: "idle", emote: "dizzy", s: { tilt: -0.1 }, clock: 1.1 },
  { label: "Winks when idle", mood: "idle", emote: "wink" },
  { label: "Yawns when idle", mood: "idle", emote: "yawn", s: { sx: 0.97, sy: 1.06 } },
];

const outfitCards = [
  { label: "Party hat", mood: "idle", outfit: "party" },
  { label: "Beanie", mood: "working", outfit: "beanie", s: { snakeOn: 1, snakeAt: 9 } },
  { label: "Crown", mood: "finished", outfit: "crown" },
  { label: "Santa hat (December)", mood: "idle", outfit: "santa" },
  { label: "Pumpkin (late October)", mood: "idle", outfit: "pumpkin" },
  { label: "Bow", mood: "question", outfit: "bow", s: { tilt: 0.12 } },
  { label: "Glasses", mood: "idle", outfit: "glasses", s: { eyeX: 0.4 } },
  { label: "Sunglasses", mood: "idle", outfit: "sunglasses" },
  { label: "Scarf", mood: "sleeping", outfit: "scarf" },
  { label: "Party hat + approval", mood: "approval", outfit: "party", s: { oy: -0.03 } },
  { label: "Santa hat, dizzy", mood: "idle", outfit: "santa", emote: "dizzy", s: { tilt: -0.1 }, clock: 1.1 },
  { label: "Beanie, rate limited", mood: "ratelimit", outfit: "beanie" },
];
const cards = outfitSheet ? outfitCards : moodCards;
const heading = outfitSheet ? "Hommie's wardrobe" : "Hommie";
const subheading = outfitSheet
  ? "right-click him to pick an outfit, or leave it on Auto for the seasons"
  : "watches Claude Code, Codex, OpenCode, Omacode, Gemini CLI, Antigravity and Grok from your Omarchy desktop";

const html = `<!doctype html>
<html><head><meta charset="utf-8"><style>
  * { margin: 0; box-sizing: border-box; }
  body { width: 1600px; height: 900px; background: ${theme.bg}; font-family: "JetBrainsMono Nerd Font", "JetBrains Mono", monospace; overflow: hidden; }
  h1 { color: ${theme.title}; font-size: 60px; text-align: center; padding-top: 34px; letter-spacing: 1px; }
  p.sub { color: ${theme.subtitle}; font-size: 23px; text-align: center; margin-top: 10px; letter-spacing: 0.5px; }
  .grid { display: grid; grid-template-columns: repeat(4, 340px); gap: 20px 40px; justify-content: center; margin-top: 34px; }
  .card { position: relative; height: 210px; background: ${theme.card}; border: 2px solid ${theme.border}; border-radius: 14px; }
  .card.expression { border-style: dashed; }
  canvas { position: absolute; left: 50%; transform: translate(-50%, -50%); top: ${outfitSheet ? 100 : 88}px; }
  .label { position: absolute; left: 0; right: 0; bottom: 20px; text-align: center; color: ${theme.label}; font-size: 19px; letter-spacing: 0.5px; }
</style></head><body>
<h1>${heading}</h1>
<p class="sub">${subheading}</p>
<div class="grid" id="grid"></div>
<script>
const theme = ${JSON.stringify(theme)};
const cards = ${JSON.stringify(cards)};
const hex = (value) => ({ r: parseInt(value.slice(1, 3), 16) / 255, g: parseInt(value.slice(3, 5), 16) / 255, b: parseInt(value.slice(5, 7), 16) / 255 });
const Color = { accent: hex(theme.accent), foreground: hex(theme.text), popups: { background: hex(theme.card) } };
const statusColors = { working: hex(theme.working), warning: hex(theme.warning), error: hex(theme.error), success: hex(theme.success), attention: hex(theme.accent) };
const states = ${engineValue(qml, "states")};
const mark = ${engineValue(qml, "mark")};
const zGlyph = ${engineValue(qml, "zGlyph")};
const emoteLengths = ${engineValue(qml, "emoteLengths")};
const outfitGlyphs = ${engineValue(qml, "outfitGlyphs")};
const grid = 15;
const innerPath = (() => {
  const path = []; let i;
  for (i = 7; i >= 2; i--) path.push({ col: i, row: 2 });
  for (i = 3; i <= 12; i++) path.push({ col: 2, row: i });
  for (i = 3; i <= 12; i++) path.push({ col: i, row: 12 });
  for (i = 11; i >= 2; i--) path.push({ col: 12, row: i });
  path.push({ col: 11, row: 2 });
  return path;
})();
const outerCells = (() => {
  const inner = {}; innerPath.forEach((p) => { inner[p.col + "," + p.row] = true; });
  const list = [];
  for (let row = 0; row < grid; row++) for (let col = 0; col < grid; col++) if (mark[row].charAt(col) === "#" && !inner[col + "," + row]) list.push({ col, row });
  return list;
})();

// The engine's own functions run with this object as their scope, as in QML.
const engineSource = ${JSON.stringify(engineCode)};
const makeEngine = new Function("E", "Color", "statusColors", "with (E) { " + engineSource + "; return { draw: draw, moodColor: moodColor }; }");

for (const card of cards) {
  const size = 118;
  const root = { overhang: Math.round(size * 0.45) };
  const E = {
    root, mark, grid, innerPath, outerCells, zGlyph, states, emoteLengths, outfitGlyphs, outfitName: card.outfit ?? "",
    state: card.mood, cfg: states[card.mood], clock: card.clock ?? 0.5,
    badge: states[card.mood].badge, badgeColor: null, particles: card.particles ?? [],
    emote: card.emote ? { name: card.emote, start: 0, length: emoteLengths[card.emote] } : null,
    s: Object.assign({ eyeX: 0, eyeY: 0, tilt: 0, open: 1, sx: 1, sy: 1, oy: 0, ox: 0, badgeS: 1, snakeAt: 0, snakeOn: 0, outfitS: 1 }, card.s ?? {}),
  };
  const engine = makeEngine(E, Color, statusColors);
  const tone = card.color ? statusColors[card.color] : engine.moodColor(card.mood);
  E.s.col = [tone.r, tone.g, tone.b];
  E.badgeColor = tone;
  if (card.emote) E.clock = card.clock ?? emoteLengths[card.emote] * 0.5;

  const element = document.createElement("div");
  element.className = "card" + (card.emote && !card.outfit ? " expression" : "");
  const canvas = document.createElement("canvas");
  const scale = 2;
  const W = size + root.overhang * 2;
  canvas.width = W * scale; canvas.height = W * scale;
  canvas.style.width = W + "px"; canvas.style.height = W + "px";
  const ctx = canvas.getContext("2d");
  const reset = ctx.reset ? ctx.reset.bind(ctx) : () => ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.reset = () => { reset(); ctx.setTransform(scale, 0, 0, scale, 0, 0); };
  engine.draw(ctx, size, size);
  const label = document.createElement("div");
  label.className = "label";
  label.textContent = card.label;
  element.append(canvas, label);
  document.getElementById("grid").append(element);
}
</script></body></html>`;

const dir = mkdtempSync(join(tmpdir(), "hommies-preview-"));
try {
  const page = join(dir, "preview.html");
  writeFileSync(page, html);
  execFileSync("chromium", [
    "--headless=new", "--disable-gpu", "--hide-scrollbars", "--force-device-scale-factor=1",
    "--window-size=1600,900", `--screenshot=${out}`, `file://${page}`,
  ], { stdio: "ignore" });
  console.log(`wrote ${out}`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
