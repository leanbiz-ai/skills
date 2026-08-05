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
  const lines = cards.map((card) => {
    // 🔴 Build RUNS, not a string, and reverse them for RTL. Measured, not
    // assumed: a card with no colour override renders in correct Hebrew order,
    // and the same card WITH one comes out scrambled. The override splits the
    // line into segments that libass then lays out left-to-right, so segment
    // order is visual, while the words inside each segment still bidi correctly.
    // Reversing the segment order therefore fixes the card without touching the
    // words. Wrapping U+202B around the whole line does NOT fix it, which is why
    // this looks like the obvious solution and is not.
    const runs = [];
    for (const w of card) {
      const t = clean(w.w);
      const hot = HAS_DIGIT.test(t) || keywords.has(t.replace(/[.,!?]/g, ""));
      const last = runs[runs.length - 1];
      if (hot) runs.push({ hot: true, text: t });
      else if (last && !last.hot) last.text += " " + t;
      else runs.push({ hot: false, text: t });
    }
    const anyRTL = runs.some((r) => RTL.test(r.text));
    const ordered = anyRTL ? [...runs].reverse() : runs;
    const text = ordered
      .map((r) => (r.hot ? `{\\c${ORANGE_BGR}}${r.text}{\\c${WHITE_BGR}}` : r.text))
      .join(" ");
    const start = toAssTime(card[0].startSec);
    const end = toAssTime(card[card.length - 1].endSec);
    // 🔴 RTL. libass runs bidi per line, and a line that opens with a colour
    // override (a Latin brace-block) gets a LEFT-to-right paragraph direction.
    // The words then render in reverse: "עם לייקים לא הולכים למכולת" came out
    // "לא הולכים למכולת לייקים עם" in the first test, which reads as gibberish
    // to the only people this skill is for. RLE...PDF pins the paragraph to RTL
    // regardless of which character happens to be first.
    const wrapped = RTL.test(text) ? `‫${text}‬` : text;
    return `Dialogue: 0,${start},${end},Cap,,0,0,0,,${wrapped}`;
  });

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
