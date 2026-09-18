#!/usr/bin/env node
// site-demo · שלב 1: שואב אתר אחד והופך אותו לתיקיית עבודה.
//
//   node scripts/scrape.mjs https://www.vaniglia.co.il --out ./demo-vaniglia
//
// מה יוצא: assets/ עם צילומי מסך, לוגו ותמונות, ו-brief.json עם כל מה
// שנמצא. 🔴 הסקריפט הזה לא בוחר קופי. הוא אוסף מועמדים, והבחירה היא
// שיפוט, ולכן היא של הסוכן שקורא את הקובץ.

import { spawnSync } from "node:child_process";
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { findChrome, findFfmpeg, download, ensureDir, fetchText } from "./lib.mjs";

const args = process.argv.slice(2);
const url = args.find((a) => a.startsWith("http"));
const outArg = args[args.indexOf("--out") + 1];
if (!url) {
  console.error("usage: scrape.mjs <url> [--out <dir>]");
  process.exit(1);
}
const host = new URL(url).hostname.replace(/^www\./, "");
const OUT = path.resolve(outArg && !outArg.startsWith("http") ? outArg : `./demo-${host.split(".")[0]}`);
const ASSETS = ensureDir(path.join(OUT, "assets"));

const CHROME = findChrome();
const { ffmpeg } = findFfmpeg();

const CHROME_FLAGS = [
  "--headless",
  "--disable-gpu",
  "--no-sandbox",
  "--disable-dev-shm-usage",
  "--hide-scrollbars",
  "--virtual-time-budget=15000",
];

// 🔴 ווידג'ט נגישות, באנר קוקיז וצ'אט צף נכנסים לצילום ונראים כמו פגם
// בסרטון. הדרך היחידה להסתיר אותם בלי לשלוט בעמוד היא סגנון משתמש.
const HIDE_CSS = `
[class*="accessibility" i],[id*="accessibility" i],[class*="negishut" i],
[class*="cookie" i],[id*="cookie" i],[class*="gdpr" i],
[class*="whatsapp" i],[class*="chat-widget" i],[id*="chat-widget" i],
[class*="nagish" i],[id*="INDmenu"],[class*="userway" i],[id*="usercentrics" i]
{ display:none !important; visibility:hidden !important; }
`;
const hideFile = path.join(OUT, ".hide.css");
writeFileSync(hideFile, HIDE_CSS);

function chrome(extra) {
  const r = spawnSync(CHROME, [...CHROME_FLAGS, ...extra, url], {
    encoding: "buffer",
    maxBuffer: 256 * 1024 * 1024,
  });
  return r;
}

function shot(file, w, h, scale = 2) {
  const r = chrome([
    `--window-size=${w},${h}`,
    `--force-device-scale-factor=${scale}`,
    `--user-stylesheet=${hideFile}`,
    `--screenshot=${file}`,
  ]);
  if (!existsSync(file)) throw new Error(`הצילום נכשל: ${r.stderr?.toString().slice(-400)}`);
  return file;
}

function probe(file) {
  const r = spawnSync(ffmpeg.replace(/ffmpeg$/, "ffprobe"), [
    "-v", "error", "-show_entries", "stream=width,height", "-of", "csv=p=0", file,
  ], { encoding: "utf8" });
  const [w, h] = r.stdout.trim().split(",").map(Number);
  return { w, h };
}

// 🔴 גובה התוכן האמיתי, ולא הגובה שביקשנו. בלי זה הגלילה בטלפון נוחתת על
// הפוטר או על אוויר לבן, וזה בדיוק מה שנשבר לנו על וניליה ב-17.9.
// נמדד על עמודות דקות של פיקסלים, ולא בעין ולא במספר קבוע.
function contentHeight(file) {
  const { w: W, h: H } = probe(file);
  const cols = 40;
  const r = spawnSync(ffmpeg, [
    "-v", "error", "-i", file, "-vf", `scale=${cols}:-1`,
    "-f", "rawvideo", "-pix_fmt", "rgb24", "-",
  ], { maxBuffer: 256 * 1024 * 1024 });
  const raw = r.stdout;
  const rows = Math.floor(raw.length / (cols * 3));
  if (!rows) return H;
  const rowAvg = (y) => {
    let s = [0, 0, 0];
    for (let x = 0; x < cols; x++) {
      const i = (y * cols + x) * 3;
      s[0] += raw[i]; s[1] += raw[i + 1]; s[2] += raw[i + 2];
    }
    return s.map((v) => v / cols);
  };
  const bg = rowAvg(rows - 1);
  const diff = (a, b) => Math.max(...a.map((v, i) => Math.abs(v - b[i])));
  let last = rows - 1;
  while (last > 0 && diff(rowAvg(last), bg) < 8) last--;
  const ratio = H / rows;
  return Math.min(H, Math.round((last + 2) * ratio));
}

// פלטה מכנית, לא בעין. palettegen מחזיר את הצבעים שבאמת שולטים בעמוד.
function palette(file, n = 12) {
  const pal = path.join(OUT, ".pal.png");
  spawnSync(ffmpeg, [
    "-v", "error", "-i", file, "-vf", `scale=240:-1,palettegen=max_colors=${n}:stats_mode=full`,
    "-y", pal,
  ]);
  const r = spawnSync(ffmpeg, ["-v", "error", "-i", pal, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], {
    maxBuffer: 16 * 1024 * 1024,
  });
  const out = [];
  for (let i = 0; i + 2 < r.stdout.length; i += 3) {
    const [R, G, B] = [r.stdout[i], r.stdout[i + 1], r.stdout[i + 2]];
    if (R === 0 && G === 255 && B === 0) continue; // משבצת השקיפות של palettegen
    const hex = "#" + [R, G, B].map((v) => v.toString(16).padStart(2, "0")).join("").toUpperCase();
    if (!out.includes(hex)) out.push(hex);
  }
  const lum = (h) => {
    const [r1, g1, b1] = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
    return 0.2126 * r1 + 0.7152 * g1 + 0.0722 * b1;
  };
  const sat = (h) => {
    const v = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
    return (Math.max(...v) - Math.min(...v)) / 255;
  };
  const sorted = [...out].sort((a, b) => lum(a) - lum(b));
  // 🔴 ״הכי רווי״ לבדו בחר לוניליה את הוורוד הרך ולא את הקורל, כי הרקע
  // הרך תופס יותר פיקסלים. צבע-מבטא הוא רווי וגם באמצע הסולם, לא בקצה.
  const accentScore = (h) => sat(h) * (1 - Math.abs(lum(h) - 0.5) * 0.6);
  const mid = out.filter((h) => lum(h) > 0.12 && lum(h) < 0.86);
  // 🔴 והבהיר: קרם מנצח לבן. לבן טהור הוא ברירת המחדל של הדפדפן ולא
  // החלטה של המותג, והוא מוחק בדיוק את החום שהאתר כן בחר.
  // הסף גבוה בכוונה: גוון חום-ורדרד בהיר הוא צבע-משנה ולא רקע, ואם הוא
  // נבחר כרקע כל הטקסט הכהה יושב עליו חלש. 0.85 ומעלה זה באמת ״נייר״.
  const lights = out.filter((h) => lum(h) > 0.85);
  const cream = lights.filter((h) => sat(h) > 0.02 && sat(h) <= 0.15).sort((a, b) => sat(b) - sat(a))[0];
  return {
    all: out,
    ink: sorted[0],
    light: cream || sorted[sorted.length - 1],
    accent: (mid.length ? mid : out).sort((a, b) => accentScore(b) - accentScore(a))[0],
  };
}

const strip = (s) => s.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
// ישויות HTML שנשארות לא מפוענחות נכנסות לסרטון כמו שהן. `&ndash;` על
// כותרת של מסעדה נראה כמו באג של מי שהפיק, ולא של האתר.
const NAMED = { amp: "&", quot: '"', apos: "'", lt: "<", gt: ">", nbsp: " ",
  ndash: "-", mdash: "-", hellip: "...", laquo: '"', raquo: '"',
  rsquo: "'", lsquo: "'", rdquo: '"', ldquo: '"', middot: "·", times: "x" };
const unent = (s) =>
  s.replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
   .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
   .replace(/&([a-z]+);/gi, (m, n) => (n.toLowerCase() in NAMED ? NAMED[n.toLowerCase()] : m));

function textBits(dom, raw) {
  const pick = (re) => { const m = raw.match(re) || dom.match(re); return m ? unent(m[1]).trim() : null; };
  const heads = [];
  for (const t of ["h1", "h2", "h3", "h4"]) {
    for (const m of dom.matchAll(new RegExp(`<${t}[^>]*>([\\s\\S]*?)</${t}>`, "gi"))) {
      const v = unent(strip(m[1]));
      // כותרות של ווידג'ט הנגישות מנוקדות, וזה הסימן הכי אמין לזהות אותן
      if (v.length > 3 && v.length < 160 && !/[֑-ׇ]/.test(v)) heads.push({ tag: t, text: v });
    }
  }
  const buttons = [];
  for (const m of dom.matchAll(/<(?:a|button)[^>]*>([\s\S]{2,60}?)<\/(?:a|button)>/gi)) {
    const v = unent(strip(m[1]));
    if (v && v.length < 40 && !/[֑-ׇ]/.test(v) && !buttons.includes(v)) buttons.push(v);
  }
  const fonts = [...new Set(
    [...raw.matchAll(/fonts\.googleapis\.com\/css2?\?family=([^&"']+)/g)].map((m) =>
      decodeURIComponent(m[1]).split(":")[0].replace(/\+/g, " ")
    )
  )];
  return {
    title: pick(/<title[^>]*>([\s\S]*?)<\/title>/i),
    ogTitle: pick(/<meta[^>]*property="og:title"[^>]*content="([^"]+)"/i),
    description: pick(/<meta[^>]*name="description"[^>]*content="([^"]+)"/i),
    headings: heads.slice(0, 40),
    buttons: buttons.slice(0, 30),
    googleFonts: fonts,
  };
}

function imageUrls(dom, base) {
  const abs = (u) => { try { return new URL(u, base).href; } catch { return null; } };
  const bad = /facebook\.com\/tr|google-analytics|googletagmanager|doubleclick|\/pixel|1x1|spacer|vee-crm/i;
  const imgs = [];
  for (const m of dom.matchAll(/<img[^>]+>/gi)) {
    const src = (m[0].match(/src="([^"]+)"/) || [])[1];
    if (!src || src.startsWith("data:")) continue;
    const u = abs(src);
    if (u && !bad.test(u) && !imgs.includes(u)) imgs.push(u);
  }
  // 🔴 באתרי וורדפרס ווויקס רוב תמונות המוצר הן background-image ב-CSS.
  // מי ששואב רק תגיות img מקבל אתר בלי תמונות ולא מבין למה.
  const bgs = [];
  for (const m of dom.matchAll(/url\(\s*["']?([^"')]+\.(?:jpe?g|png|webp))["']?\s*\)/gi)) {
    const u = abs(m[1]);
    if (u && !bad.test(u) && !bgs.includes(u)) bgs.push(u);
  }
  const logo = imgs.find((u) => /logo/i.test(u)) || null;
  return { logo, imgs, bgs };
}

console.log(`→ ${url}`);
const raw = await fetchText(url);

const domRes = chrome(["--window-size=1440,900", "--dump-dom"]);
const dom = domRes.stdout.toString("utf8");
console.log(`  DOM מרונדר: ${dom.length.toLocaleString()} תווים`);

console.log("  מצלם מובייל…");
const mobileTall = path.join(ASSETS, "site-mobile-tall.png");
shot(mobileTall, 430, 7000, 2);
const contentPx = contentHeight(mobileTall);
const mobile = path.join(ASSETS, "site-mobile.png");
spawnSync(ffmpeg, ["-v", "error", "-i", mobileTall, "-vf", `crop=iw:${contentPx}:0:0`, "-y", mobile]);
const mob = probe(mobile);
console.log(`  גובה תוכן אמיתי: ${mob.h}px מתוך 14000 שנלכדו`);

console.log("  מצלם דסקטופ…");
const desktop = path.join(ASSETS, "site-desktop.png");
shot(desktop, 1440, 900, 2);

const pal = palette(mobile);
console.log(`  פלטה: ${pal.all.join(" ")}`);

const text = textBits(dom, raw);
const { logo, imgs, bgs } = imageUrls(dom, url);

const photos = [];
for (const u of [...bgs, ...imgs].slice(0, 14)) {
  const name = path.basename(new URL(u).pathname).replace(/[^\w.-]/g, "_");
  const dest = path.join(ASSETS, "photos", name);
  const got = await download(u, dest);
  if (!got) continue;
  const d = probe(dest);
  if (!d.w || d.w < 700) continue; // תמונות קטנות הן אייקונים, לא חומר גלם
  photos.push({ url: u, file: path.relative(OUT, dest), w: d.w, h: d.h });
  if (photos.length >= 6) break;
}
console.log(`  תמונות: ${photos.length} הורדו מתוך ${bgs.length + imgs.length} שנמצאו`);

let logoFile = null;
if (logo) {
  const dest = path.join(ASSETS, "logo" + path.extname(new URL(logo).pathname).split("?")[0]);
  if (await download(logo, dest)) {
    const png = path.join(ASSETS, "logo.png");
    spawnSync(ffmpeg, ["-v", "error", "-i", dest, "-y", png]);
    if (existsSync(png)) logoFile = path.relative(OUT, png);
  }
}
console.log(`  לוגו: ${logoFile || "לא נמצא, נשתמש בשם המותג כטקסט"}`);

const brief = {
  source: {
    url,
    host,
    scrapedAt: new Date().toISOString(),
    ...text,
    palette: pal,
    logoFile,
    photos,
    capture: { mobile: path.relative(OUT, mobile), mobileHeight: mob.h, mobileWidth: mob.w,
               desktop: path.relative(OUT, desktop) },
  },
  // 🔴 החלק הזה ריק בכוונה. בחירת הקופי היא שיפוט ולא רג'קס, והסוכן
  // ממלא אותה מתוך source. כל מילה חייבת להיות מהאתר, לא המצאה.
  copy: {
    brand: text.ogTitle || text.title || host,
    kicker: "",
    headline1: "",
    kicker2: "",
    headline2: "",
    sub2: "",
    tagline: "",
    kicker3: "",
    headline3: "",
    rows: [{ title: "", body: "" }, { title: "", body: "" }, { title: "", body: "" }],
    ctaHeadline: "",
    ctaButton: "",
  },
  design: {
    ink: pal.ink,
    accent: pal.accent,
    light: pal.light,
    font: text.googleFonts[0] || "Assistant",
    heroPhoto: photos[0]?.file || null,
  },
};
writeFileSync(path.join(OUT, "brief.json"), JSON.stringify(brief, null, 2) + "\n");

console.log(`\n✅ ${path.relative(process.cwd(), OUT)}/brief.json`);
console.log("   מלא את חלק ה-copy מתוך source, ואז:");
console.log(`   node scripts/build.mjs ${path.relative(process.cwd(), OUT)}`);
