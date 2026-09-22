#!/usr/bin/env node
// clip-machine · make-clips.mjs — חותך סרטון ארוך לקטעים אנכיים עם כתוביות.
//
//   node scripts/make-clips.mjs <תיקייה>
//
// קורא clips.json (מה לחתוך, בחירה אנושית) ו-words.json (תמליל עם זמנים),
// ומוציא לכל קטע קובץ 1080x1920 מוכן לאינסטגרם.
//
// הסקריפט לא בוחר רגעים. הבחירה היא השלב האנושי, והיא נשמרה ב-clips.json.
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import path from "node:path";

const die = (m) => { console.error("\n\u274c " + m + "\n"); process.exit(1); };

// סריקה של PATH בעצמנו ולא דרך `command -v`: מעטפות מסוימות מחזירות 127
// גם כשהקובץ קיים, והכישלון נראה אז כמו ״ffmpeg לא מותקן״.
function which(cmd) {
  for (const dir of (process.env.PATH || "").split(path.delimiter)) {
    if (!dir) continue;
    const p = path.join(dir, cmd);
    if (existsSync(p)) return p;
  }
  return null;
}
const ffmpeg = process.env.FFMPEG_PATH || which("ffmpeg");
if (!ffmpeg) die("לא נמצא ffmpeg. במק: brew install ffmpeg");

// 🔴 גופן עברי נבחר מרשימה ולא מקובע. libass מרנדר עברית נכון (bidi דרך
// fribidi), אבל רק אם הגופן שנבחר מכיל אותיות עבריות. גופן בלי עברית
// לא נופל, הוא מצייר ריבועים, וזה נראה כמו באג של הכלי.
function pickHebrewFont() {
  if (process.env.CLIP_FONT) return process.env.CLIP_FONT;
  const r = spawnSync("fc-list", [":lang=he", "family"], { encoding: "utf8" });
  const fams = (r.stdout || "").split("\n").map((s) => s.split(",")[0].trim()).filter(Boolean);
  for (const want of ["Assistant", "Heebo", "Rubik", "Arial Hebrew", "Noto Sans Hebrew"]) {
    if (fams.some((f) => f === want)) return want;
  }
  return fams[0] || "Arial Hebrew";
}

const dir = path.resolve(process.argv[2] || ".");
const clipsPath = path.join(dir, "clips.json");
const wordsPath = path.join(dir, "words.json");
if (!existsSync(clipsPath)) die(`לא נמצא ${clipsPath}`);
if (!existsSync(wordsPath)) die(`לא נמצא ${wordsPath}`);

const spec = JSON.parse(readFileSync(clipsPath, "utf8"));
const words = JSON.parse(readFileSync(wordsPath, "utf8")).words || [];
if (!words.length) die("words.json בלי מילים");

const source = path.isAbsolute(spec.source) ? spec.source : path.join(dir, spec.source);
if (!existsSync(source)) die(`קובץ המקור לא נמצא: ${source}`);

// 🔴 שער האישור. הקטעים יוצאים לרשת בשם של מי שמריץ, ווובינר מכיל שמות
// של משתתפים ומספרים אמיתיים. בלי אישור מפורש אין חיתוך.
if (spec.approved !== true) die(
  `clips.json לא אושר.\n` +
  `עברו על הקטעים, ודאו שאין בהם שם של משתתף או מספר שלא רוצים לפרסם,\n` +
  `ואז כתבו "approved": true והריצו שוב.`
);

const FONT = pickHebrewFont();
const W = 1080, H = 1920;
const VID_H = Math.round((H * 0) + 608);   // 1080x608 = 16:9 ברוחב מלא
const VID_Y = 470;                          // מתחת לכותרת, מעל הכתוביות
const CAP_Y = Math.round(H * 0.74);

const ass = (s) => String(s).replace(/\n/g, "\\N").replace(/[{}]/g, "");

// 🔴 תיקוני תמלול. מנוע התמלול שומע ״נכדים״ ככ״מנחדים״ ו״תלות״ כ״בוטלות״,
// וכתובית עם שגיאה כזאת גורמת לצופה לחשוב שהדובר אמר את זה. התיקונים
// הם מילה-למילה על התמליל בלבד, ולא נוגעים בקול.
const FIXES = new Map(Object.entries(spec.fixes || {}));
const fix = (word) => FIXES.get(word) ?? word;
const t = (sec) => {
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60);
  const s = (sec % 60).toFixed(2).padStart(5, "0");
  return `${h}:${String(m).padStart(2, "0")}:${s}`;
};

// 🔴 שלוש מילים לכרטיס, כמו בכל ריל שלנו. יותר מזה נשבר לשתי שורות,
// ושתי שורות בגובה הזה נכנסות לאזור שאינסטגרם מצייר עליו ממשק.
function cards(from, to) {
  const inRange = words.filter((w) => w.endSec > from && w.startSec < to);
  const out = [];
  for (let i = 0; i < inRange.length; i += 3) {
    const g = inRange.slice(i, i + 3);
    out.push({
      start: Math.max(0, g[0].startSec - from),
      end: Math.min(to - from, g[g.length - 1].endSec - from),
      text: g.map((w) => fix(w.w.trim())).filter(Boolean).join(" "),
    });
  }
  return out;
}

const outDir = path.join(dir, "clips");
mkdirSync(outDir, { recursive: true });
const made = [];

for (const [i, c] of (spec.clips || []).entries()) {
  const n = String(i + 1).padStart(2, "0");
  const dur = c.endSec - c.startSec;
  if (!(dur > 0)) die(`קטע ${n}: endSec חייב להיות אחרי startSec`);
  if (dur > 90) console.warn(`\u26a0  קטע ${n} הוא ${Math.round(dur)} שניות. אינסטגרם חותך מעל 90.`);

  const assPath = path.join(outDir, `clip-${n}.ass`);
  const lines = cards(c.startSec, c.endSec).map(
    (k) => `Dialogue: 0,${t(k.start)},${t(k.end)},Cap,,0,0,0,,${ass(k.text)}`
  );
  writeFileSync(assPath, `[Script Info]
ScriptType: v4.00+
PlayResX: ${W}
PlayResY: ${H}
WrapStyle: 2
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Cap,${FONT},74,&H00FFFFFF,&H00FFFFFF,&H00101010,&HB4101010,-1,0,0,0,100,100,0,0,3,14,0,2,80,80,${H - CAP_Y},1
Style: Title,${FONT},62,&H00FFFFFF,&H00FFFFFF,&H00202020,&H00000000,-1,0,0,0,100,100,0,0,1,4,0,8,90,90,60,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
${c.title ? `Dialogue: 0,${t(0)},${t(dur)},Title,,0,0,0,,${ass(c.title)}` : ""}
${lines.join("\n")}
`);

  const outPath = path.join(outDir, `clip-${n}.mp4`);
  // רקע מטושטש בגודל מלא, ומעליו הפריים ברוחב מלא. ככה וובינר 16:9 נכנס
  // לפריים אנכי בלי לחתוך את מי שמדבר ובלי פסים שחורים.
  // 🔴 שני פריסות, והבחירה אינה קוסמטית. הקלטת וובינר עם שיתוף מסך היא
  // שקף גדול ועליו ריבוע קטן של הדובר, ופריסת ברירת המחדל הופכת אותה
  // לרצועה אחת שבה הדובר בגודל בול. `speakerCrop` + `slideCrop` מפרקים
  // את המקור לשניים ומרכיבים אותם זה מעל זה, ואז שניהם נקראים בטלפון.
  const stacked = spec.speakerCrop && spec.slideCrop;
  const vf = stacked
    ? [
        `[0:v]split=3[bg][sp][sl]`,
        `[bg]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},gblur=sigma=48,eq=brightness=-0.3[bgb]`,
        `[sp]crop=${spec.speakerCrop},scale=${W}:-2,unsharp=5:5:0.8[spf]`,
        `[sl]crop=${spec.slideCrop},scale=900:-2[slf]`,
        `[bgb][spf]overlay=0:160[v1]`,
        `[v1][slf]overlay=90:840[v0]`,
        `[v0]ass='${assPath.replace(/'/g, "'\\''")}'[v]`,
      ].join(";")
    : [
        `[0:v]split=2[bg][fg]`,
        `[bg]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},gblur=sigma=42,eq=brightness=-0.16[bgb]`,
        `[fg]scale=${W}:-2[fgs]`,
        `[bgb][fgs]overlay=0:${VID_Y}[v0]`,
        `[v0]ass='${assPath.replace(/'/g, "'\\''")}'[v]`,
      ].join(";");

  const args = [
    "-v", "error", "-stats",
    "-ss", String(c.startSec), "-t", String(dur), "-i", source,
    "-filter_complex", vf, "-map", "[v]", "-map", "0:a",
    "-r", "30", "-c:v", "libx264", "-preset", "medium", "-crf", "20",
    "-pix_fmt", "yuv420p",
    "-af", "loudnorm=I=-14:TP=-1.5:LRA=11",
    "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart",
    outPath, "-y",
  ];
  console.log(`\u25b6 קטע ${n}: ${Math.round(c.startSec)}s, ${Math.round(dur)} שניות`);
  const r = spawnSync(ffmpeg, args, { encoding: "utf8", stdio: ["ignore", "ignore", "inherit"] });
  if (r.status !== 0) die(`ffmpeg נפל על קטע ${n}`);
  made.push({ n, outPath, title: c.title, dur: Math.round(dur) });
}

console.log(`\n\u2705 ${made.length} קטעים ב-${outDir}\n`);
for (const m of made) console.log(`   clip-${m.n}.mp4  ${m.dur}s  ${m.title || ""}`);
console.log(`\nתסתכלו על כל אחד לפני שמעלים. זה השלב היחיד שאי אפשר לעשות במקומכם.\n`);
