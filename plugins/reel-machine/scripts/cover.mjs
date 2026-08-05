#!/usr/bin/env node
// reel-machine · cover.mjs — a still frame from the reel + the hook, centred,
// rendered with ffmpeg and libass only. Same one-dependency rule as captions.
//
// Usage:
//   node cover.mjs --video in.mp4 --at 3.5 --hook "עם {לייקים} לא הולכים למכולת"
//        [--sub "מה כן מביא לקוחות"] [--out cover.png]
//        [--font "Arial"] [--size 96] [--shift 0.14] [--perline 17]
//
// {curly braces} inside the hook paint that word in brand orange.
//
// WHY THE HOOK IS CENTRED, and why the picture moves instead of the text:
// in the grid and the feed the eye lands in the MIDDLE of the thumbnail, so a
// headline at the top reads as decoration. But a person filming themselves for a
// split-screen reel sits low, which puts their face exactly where the hook goes.
// Moving the text back up loses the reason to centre it; moving the PICTURE down
// keeps both. `--shift` is how far down, as a fraction of frame height.

import { existsSync, writeFileSync, unlinkSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";

const ORANGE = "&H00156AFF"; // #FF6A15 in ASS's &HAABBGGRR order
const CREAM = "&H00F0F7FB";  // #FBF7F0
const INK = "&H003D2114";    // #14213D
const RTL = /[\u0590-\u05FF\u0600-\u06FF]/;

const arg = (n, d = null) => {
  const i = process.argv.indexOf(`--${n}`);
  return i > -1 ? process.argv[i + 1] : d;
};

function ffmpegExe() {
  if (process.env.FFMPEG_PATH) return process.env.FFMPEG_PATH;
  if (!spawnSync("ffmpeg", ["-version"]).error) return "ffmpeg";
  const py = spawnSync("python3",
    ["-c", "import imageio_ffmpeg;print(imageio_ffmpeg.get_ffmpeg_exe())"], { encoding: "utf8" });
  const p = (py.stdout || "").trim();
  if (p && existsSync(p)) return p;
  throw new Error("לא נמצא ffmpeg. מק: brew install ffmpeg · חלונות: winget install ffmpeg");
}

/** 🔴 CORRECTED 2026-08-05, together with captions.mjs and for the same reason.
 *  This used to reverse the runs of EVERY Hebrew line. That is wrong: libass
 *  bidis the line for us, across colour overrides, and gets it right — so the
 *  blanket reversal was undoing correct output, and on top of a reordered line
 *  libass mis-measures the segments and prints an orange word ON TOP of its
 *  neighbour. Both were seen on rendered frames.
 *  The one case libass really does get wrong is a Hebrew line whose first
 *  STRONG character is Latin ("ShareX פה למטה"): the paragraph is judged
 *  left-to-right and the line comes out mirrored. That case, and only that
 *  case, we reorder by hand — and drop the overrides while we do, because
 *  overrides plus a reordered line is what causes the overlap. */
/** 🔴 We break the lines OURSELVES and join with \N. Letting libass wrap a
 *  reversed-run line reverses the LINE order too, so a two-line hook reads
 *  bottom-up: "עם לייקים לא הולכים למכולת" came out "לא הולכים / עם לייקים
 *  למכולת" on the first cover. Reversal has to happen inside a line, never
 *  across lines, and the only way to guarantee that is to decide the lines. */
function assLine(text, perLine = 0) {
  // tokens carry their own highlight flag, so a break can fall anywhere
  const parts = String(text).split(/\{([^}]*)\}/);
  const toks = [];
  parts.forEach((p, i) => {
    if (!p) return;
    const hot = i % 2 === 1;
    p.replace(/[{}\\]/g, "").trim().split(/\s+/).filter(Boolean)
      .forEach((w) => toks.push({ hot, text: w }));
  });
  if (!toks.length) return "";

  const rows = [];
  let row = [];
  for (const t of toks) {
    const len = row.reduce((n, x) => n + x.text.length + 1, -1);
    if (perLine && row.length && len + 1 + t.text.length > perLine) { rows.push(row); row = []; }
    row.push(t);
  }
  if (row.length) rows.push(row);

  const LTR_CH = /[A-Za-z0-9]/;
  return rows
    .map((r) => {
      // merge neighbours of the same colour so we emit as few runs as possible
      const runs = [];
      for (const t of r) {
        const last = runs[runs.length - 1];
        if (last && last.hot === t.hot) last.text += " " + t.text;
        else runs.push({ ...t });
      }
      const plain = runs.map((x) => x.text).join(" ");
      const firstStrong = [...plain].find((ch) => RTL.test(ch) || LTR_CH.test(ch));
      // Mirrored only when the line HAS Hebrew but OPENS in Latin.
      if (RTL.test(plain) && firstStrong && LTR_CH.test(firstStrong)) {
        return [...runs].reverse().map((x) => x.text).join(" ");
      }
      return runs.map((x) => (x.hot ? `{\\c${ORANGE}}${x.text}{\\c${CREAM}}` : x.text)).join(" ");
    })
    .join("\\N");
}

function main() {
  const video = arg("video");
  const hook = arg("hook");
  if (!video || !hook) throw new Error("--video ו---hook הם חובה");
  if (!existsSync(video)) throw new Error(`לא נמצא קובץ וידאו: ${video}`);

  const at = arg("at", "2");
  const sub = arg("sub", "");
  const out = arg("out", "cover.png");
  const font = arg("font", "Arial");
  const size = parseInt(arg("size", "96"), 10);
  const shift = parseFloat(arg("shift", "0.14"));

  const W = 1080, H = 1920;
  const lines = [`Dialogue: 0,0:00:00.00,0:00:10.00,Hook,,0,0,0,,${assLine(hook, parseInt(arg("perline", "17"), 10))}`];
  if (sub) lines.push(`Dialogue: 0,0:00:00.00,0:00:10.00,Sub,,0,0,0,,${assLine(sub, 30)}`);

  const ass = `[Script Info]
ScriptType: v4.00+
PlayResX: ${W}
PlayResY: ${H}
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding
Style: Hook,${font},${size},${CREAM},${CREAM},${INK},${INK},-1,0,0,0,100,100,0,0,1,6,4,5,70,70,0,1
Style: Sub,${font},${Math.round(size * 0.46)},${INK},${INK},${ORANGE},${ORANGE},-1,0,0,0,100,100,0,0,3,16,0,5,70,70,${Math.round(H * 0.30)},1

[Events]
Format: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text
${lines.join("\n")}
`;

  const dir = path.dirname(path.resolve(out));
  const assPath = path.join(dir, ".reel-machine-cover.ass");
  writeFileSync(assPath, ass, "utf8");

  const ff = ffmpegExe();
  const fp = assPath.replace(/\\/g, "/").replace(/:/g, "\\:").replace(/'/g, "\\'");
  // scale beyond the frame, anchor to the top, then crop: that is what drops the
  // face below the hook. A darkening pass keeps cream text readable on any shot.
  const zoom = 1 + shift;
  const vf = [
    `scale=${Math.round(W * zoom)}:${Math.round(H * zoom)}:force_original_aspect_ratio=increase`,
    `crop=${W}:${H}:(iw-${W})/2:0`,
    `eq=brightness=-0.10:saturation=0.95`,
    `ass='${fp}'`,
  ].join(",");

  const r = spawnSync(ff, ["-y", "-ss", String(at), "-i", video, "-frames:v", "1", "-vf", vf, out],
    { stdio: "inherit" });
  try { unlinkSync(assPath); } catch {}
  if (r.status !== 0) throw new Error("ffmpeg נכשל. ההודעה המלאה למעלה.");
  console.log(`✅ תמונת שער נשמרה: ${out}`);
}

try { main(); } catch (e) { console.error("❌ " + e.message); process.exit(1); }
