#!/usr/bin/env node
// reel-machine · captions.mjs — word-level transcript -> brand captions burned
// into the video, using ffmpeg and libass ONLY.
//
// WHY NOT THE WAY WE DO IT INTERNALLY. BizAI's own reel-kit renders caption
// frames in Chromium and composites them. That is right for us and wrong for a
// giveaway: it means Chromium, puppeteer, and a few hundred megabytes before a
// business owner sees a single caption. libass ships inside ffmpeg, which they
// already need for anything video. One dependency instead of three.
//
// Usage:
//   node captions.mjs --video in.mp4 --words words.json --out out.mp4
//        [--y 0.5]          caption band height, 0 = top, 1 = bottom
//        [--max 6]          max words per card
//        [--chars 26]       max characters per card, keeps it to one line
//        [--font "Arial"]   font family libass should resolve
//        [--size 62]        font size at 1080x1920, scaled for other sizes
//        [--keyword "מדריך"]  extra words to paint in brand orange (repeatable)
//
// words.json: { "words": [ { "w": "שלום", "startSec": 0.1, "endSec": 0.4 }, ... ] }
// Numbers are highlighted automatically; that is the one rule we never turn off,
// because a number is the thing a viewer actually stops for.

import { readFile, writeFile, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";

const ORANGE_BGR = "&H00156AFF"; // #FF6A15 -> ASS is &HAABBGGRR, not RGB
const WHITE_BGR = "&H00FFFFFF";
const BOX_BGR = "&HC03D2114"; // navy #14213D at ~75% opacity

function arg(name, def = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : def;
}
function argAll(name) {
  const out = [];
  process.argv.forEach((a, i) => { if (a === `--${name}`) out.push(process.argv[i + 1]); });
  return out;
}

/** ffmpeg lookup, in the order a real machine actually has one. We do NOT bundle
 *  a binary: on someone else's laptop that is the difference between a 2MB skill
 *  and a 90MB one, and every OS ships a working install path. */
function ffmpegExe() {
  if (process.env.FFMPEG_PATH) return process.env.FFMPEG_PATH;
  const probe = spawnSync("ffmpeg", ["-version"], { encoding: "utf8" });
  if (!probe.error) return "ffmpeg";
  // imageio-ffmpeg is a common side-effect install; use it rather than failing.
  const py = spawnSync("python3",
    ["-c", "import imageio_ffmpeg;print(imageio_ffmpeg.get_ffmpeg_exe())"], { encoding: "utf8" });
  const p = (py.stdout || "").trim();
  if (p && existsSync(p)) return p;
  throw new Error(
    "לא נמצא ffmpeg.\n" +
    "מק:     brew install ffmpeg\n" +
    "חלונות: winget install ffmpeg\n" +
    "או הגדירו FFMPEG_PATH לנתיב המלא."
  );
}

const toAssTime = (s) => {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = (s % 60).toFixed(2).padStart(5, "0");
  return `${h}:${String(m).padStart(2, "0")}:${sec}`;
};

/** Split the word stream into cards. A card breaks on max-words OR on a real
 *  pause, because a card that runs across a breath reads as one sentence when it
 *  is two. */
/** 🔴 `chars` is not cosmetic, it is what keeps the card on ONE line. When a
 *  highlighted card wraps to two, the segment-reversal that fixes RTL word order
 *  reverses the LINE order too, and the card reads bottom-up. Rather than fight
 *  libass wrapping, we never hand it a line long enough to wrap. 26 is measured
 *  against 1080px wide at size 62 with the default margins. */
function toCards(words, max, gap = 0.6, chars = 26) {
  const cards = [];
  let cur = [];
  const width = (arr) => arr.reduce((n, w) => n + String(w.w).length + 1, -1);
  for (const w of words) {
    const prev = cur[cur.length - 1];
    const tooWide = cur.length && width([...cur, w]) > chars;
    if (cur.length >= max || tooWide || (prev && w.startSec - prev.endSec > gap)) {
      cards.push(cur); cur = [];
    }
    cur.push(w);
  }
  if (cur.length) cards.push(cur);
  return cards;
}

const HAS_DIGIT = /\d/;
// Hebrew or Arabic anywhere in the card means the card is an RTL paragraph.
const RTL = /[\u0590-\u05FF\u0600-\u06FF]/;
// ASS override blocks are wrapped in braces, so a literal brace in the caption
// would silently swallow the rest of the line. Strip rather than escape: no
// Hebrew caption needs one, and a swallowed line is invisible until it ships.
const clean = (s) => String(s).replace(/[{}]/g, "").replace(/\\/g, "");

// 🔴 THE WHOLE RTL STORY. Rewritten 2026-08-05 after measuring, on reel 04,
// what the previous two attempts had only guessed at. Each claim below is a
// rendered frame that was looked at, not a theory about libass.
//
// WHAT IS ACTUALLY TRUE:
//  a. libass DOES bidi the whole line, across colour overrides. A card with a
//     highlighted word in the MIDDLE comes out in correct Hebrew order with no
//     help from us at all.
//  b. The paragraph direction is decided by the first STRONG character of the
//     text, and an override block `{\c...}` is stripped before that decision.
//     So a card that opens with a highlighted foreign word — "ShareX פה למטה" —
//     is judged left-to-right and the entire card renders mirrored.
//  c. U+200F (RLM) at the head does not rescue case (b). It is zero-width and
//     is gone before the direction is picked. Measured, not assumed.
//
// WHAT THE TWO EARLIER FIXES GOT WRONG:
//  1. Wrapping the line in RLE…PDF. This fought (a) instead of using it, and it
//     made libass measure segment widths against a string it had already
//     reordered — so an orange word was drawn ON TOP of its neighbour. That is
//     the overlap Aviv would have seen on screen.
//  2. Reversing the run order by hand. Same problem: it double-reverses the
//     cards that (a) already handles, and it never touched the real cause of
//     the mirrored cards, which is (b).
//
// WHAT WE DO NOW: leave the bidi alone, and make case (b) unreachable — a card
// is never allowed to BEGIN with a highlighted run. The word stays on screen
// and stays readable; it just does not get the orange. Losing one highlight
// beats shipping a mirrored card, and it is the only case where they conflict.
const LTR_CH = /[A-Za-z0-9]/;
/** 'rtl' | 'ltr' | null. null = neutral (space, punctuation, brackets): it has
 *  no direction of its own and simply joins the run it is standing next to. */
const dirOf = (ch) => (RTL.test(ch) ? "rtl" : LTR_CH.test(ch) ? "ltr" : null);

/** A card becomes runs of (direction × highlighted). Splitting by CHARACTER is
 *  the point: "ב-Zappy" is one word and two runs. */
function toRuns(card, keywords) {
  let full = "";
  const hotSpans = [];
  card.forEach((w, i) => {
    const t = clean(w.w);
    if (i) full += " ";
    if (HAS_DIGIT.test(t) || keywords.has(t.replace(/[.,!?]/g, ""))) {
      hotSpans.push([full.length, full.length + t.length]);
    }
    full += t;
  });
  const isHot = (i) => hotSpans.some(([a, b]) => i >= a && i < b);

  const runs = [];
  for (let i = 0; i < full.length; i++) {
    const ch = full[i];
    const d = dirOf(ch);
    const hot = isHot(i);
    const cur = runs[runs.length - 1];
    // A neutral character extends the current run rather than starting one, so a
    // space between two Hebrew words never becomes a segment boundary.
    if (cur && cur.hot === hot && (d === null || cur.dir === null || cur.dir === d)) {
      cur.text += ch;
      if (cur.dir === null) cur.dir = d;
    } else {
      runs.push({ text: ch, dir: d, hot });
    }
  }
  return { runs, full };
}

function buildLine(card, keywords) {
  const { runs, full } = toRuns(card, keywords);
  const firstStrong = [...full].find((ch) => dirOf(ch) !== null);
  // Case (b): a Hebrew card whose first strong character is Latin — "ShareX פה
  // למטה" — is laid out as a left-to-right paragraph and comes out mirrored.
  // This is the ONLY case libass gets wrong, and it is the one case where we
  // reorder by hand: under an LTR layout, reversing the runs ourselves produces
  // the correct right-to-left picture.
  const mirrored = RTL.test(full) && firstStrong && dirOf(firstStrong) === "ltr";
  if (mirrored) {
    // No colour overrides on a reordered line. Overrides plus a reordered line
    // is exactly the combination that made libass mis-measure and stack an
    // orange word on top of its neighbour. The word keeps its place, and loses
    // only the orange, on the handful of cards that open with a foreign word.
    const parts = runs.map((r) => r.text.trim()).filter(Boolean).reverse();
    const start = toAssTime(card[0].startSec);
    const end = toAssTime(card[card.length - 1].endSec);
    return `Dialogue: 0,${start},${end},Cap,,0,0,0,,${parts.join(" ")}`;
  }
  // Everything else: hands off. libass bidi already gets these right, and both
  // previous attempts broke them by "helping".
  // Joined with "" — the spaces are already inside the runs. Joining with " "
  // here is what would double the gaps around a highlighted word.
  const text = runs
    .map((r) => (r.hot ? `{\\c${ORANGE_BGR}}${r.text}{\\c${WHITE_BGR}}` : r.text))
    .join("");
  const start = toAssTime(card[0].startSec);
  const end = toAssTime(card[card.length - 1].endSec);
  return `Dialogue: 0,${start},${end},Cap,,0,0,0,,${text}`;
}

function main() {
  const video = arg("video");
  const wordsPath = arg("words");
  const out = arg("out", "captioned.mp4");
  if (!video || !wordsPath) throw new Error("--video ו---words הם חובה");
  if (!existsSync(video)) throw new Error(`לא נמצא קובץ וידאו: ${video}`);
  if (!existsSync(wordsPath)) throw new Error(`לא נמצא קובץ תמלול: ${wordsPath}`);

  const y = parseFloat(arg("y", "0.5"));
  const max = parseInt(arg("max", "6"), 10);
  const font = arg("font", "Arial");
  const size = parseInt(arg("size", "62"), 10);
  const keywords = new Set(argAll("keyword").filter(Boolean));

  const doc = JSON.parse(require0(wordsPath));
  const words = (doc.words || doc).filter((w) => w && w.w != null);
  if (!words.length) throw new Error("קובץ התמלול ריק");

  const cards = toCards(words, max, 0.6, parseInt(arg("chars", "26"), 10));
  const lines = cards.map((card) => buildLine(card, keywords));

  // an5 = middle-centre anchor, so `y` positions the caption's CENTRE and the
  // band grows symmetrically instead of drifting as the line count changes.
  const marginV = Math.round((1 - y) * 1920);
  const ass = `[Script Info]
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding
Style: Cap,${font},${size},${WHITE_BGR},${WHITE_BGR},${BOX_BGR},${BOX_BGR},-1,0,0,0,100,100,0,0,3,14,0,2,60,60,${marginV},1

[Events]
Format: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text
${lines.join("\n")}
`;

  const assPath = path.join(path.dirname(path.resolve(out)), ".reel-machine.ass");
  writeFileSync0(assPath, ass);

  const ff = ffmpegExe();
  // The ass filter needs the path escaped for the filter parser, not the shell.
  const filterPath = assPath.replace(/\\/g, "/").replace(/:/g, "\\:").replace(/'/g, "\\'");
  const r = spawnSync(ff, [
    "-y", "-i", video,
    "-vf", `ass='${filterPath}'`,
    "-c:a", "copy", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "18",
    out,
  ], { stdio: "inherit" });
  try { unlinkSync0(assPath); } catch {}
  if (r.status !== 0) throw new Error("ffmpeg נכשל. ההודעה המלאה למעלה.");
  console.log(`✅ ${cards.length} כרטיסי-כתוביות נצרבו לתוך ${out}`);
}

// tiny sync helpers so the file stays dependency-free and readable
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
function require0(p) { return readFileSync(p, "utf8"); }
function writeFileSync0(p, s) { return writeFileSync(p, s, "utf8"); }
function unlinkSync0(p) { return unlinkSync(p); }

try { main(); } catch (e) { console.error("❌ " + e.message); process.exit(1); }
