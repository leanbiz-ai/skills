// כלים משותפים ל-site-demo: איתור בינאריים, הרצה, והורדת קבצים.
// 🔴 שום דבר כאן לא מניח את הסביבה של החדר. הסקיל הזה אמור לרוץ גם על
// המק של בעל עסק, ושם כרום נמצא במקום אחר ו-ffmpeg מגיע מ-brew.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const CHROME_CANDIDATES = [
  process.env.HYPERFRAMES_BROWSER_PATH,
  process.env.CHROME_PATH,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/usr/bin/google-chrome",
];

// סריקה של PATH בעצמנו ולא דרך `command -v`: מעטפת הסשן כאן מחזירה 127
// גם כשהבינארי קיים, וזה שולח את מי שמריץ לחפש באג בהתקנה של ffmpeg.
function which(cmd) {
  for (const dir of (process.env.PATH || "").split(path.delimiter)) {
    if (!dir) continue;
    const p = path.join(dir, cmd);
    if (existsSync(p)) return p;
  }
  return null;
}

export function findChrome() {
  for (const c of CHROME_CANDIDATES) if (c && existsSync(c)) return c;
  for (const c of ["chromium", "google-chrome", "chrome"]) {
    const p = which(c);
    if (p) return p;
  }
  throw new Error(
    "לא נמצא כרום. התקן Google Chrome, או הצבע עליו:\n" +
      "  export HYPERFRAMES_BROWSER_PATH='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'"
  );
}

// 🔴 ffprobe הוא לא תוספת ל-ffmpeg, הוא בינארי שני. הסתמכות על imageio-ffmpeg
// עלתה לנו יום שלם ב-3.8: הוא מביא רק את הראשון, וההרצה נופלת רק בסוף.
export function findFfmpeg() {
  const extra = "/usr/local/lib/python3.11/dist-packages/static_ffmpeg/bin/linux";
  const pairs = [
    [which("ffmpeg"), which("ffprobe")],
    [path.join(extra, "ffmpeg"), path.join(extra, "ffprobe")],
  ];
  for (const [a, b] of pairs) if (a && b && existsSync(a) && existsSync(b)) return { ffmpeg: a, ffprobe: b };
  throw new Error("צריך ffmpeg וגם ffprobe. במק: brew install ffmpeg");
}

export function run(bin, args, opts = {}) {
  return execFileSync(bin, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, ...opts });
}

export function runQuiet(bin, args, opts = {}) {
  try {
    return run(bin, args, { stdio: ["ignore", "pipe", "ignore"], ...opts });
  } catch (e) {
    return e.stdout ? String(e.stdout) : "";
  }
}

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";

export async function fetchText(url) {
  const r = await fetch(url, { headers: { "user-agent": UA }, redirect: "follow" });
  if (!r.ok) throw new Error(`HTTP ${r.status} על ${url}`);
  return await r.text();
}

export async function download(url, dest) {
  const r = await fetch(url, { headers: { "user-agent": UA }, redirect: "follow" });
  if (!r.ok) return null;
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length < 2048) return null; // פיקסלים של מעקב וגיפים ריקים
  mkdirSync(path.dirname(dest), { recursive: true });
  writeFileSync(dest, buf);
  return { bytes: buf.length };
}

export function ensureDir(p) {
  mkdirSync(p, { recursive: true });
  return p;
}
