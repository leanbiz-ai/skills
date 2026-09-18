#!/usr/bin/env node
// site-demo · שלב 2: brief.json מלא הופך לסרטון.
//
//   node scripts/build.mjs ./demo-vaniglia
//
// מה קורה כאן: חישוב צבעים שעוברים ניגודיות, הבאת הגופן האמיתי של הלקוח
// מגוגל-פונטס והטמעתו, חישוב מרחק הגלילה מגובה העמוד שנמדד, הזרקה לתבנית,
// ורינדור. 🔴 שני שערים חוסמים כאן, ושניהם נולדו מטעויות אמיתיות.

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, cpSync, existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { findFfmpeg, ensureDir } from "./lib.mjs";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const dir = path.resolve(process.argv[2] || ".");
const brief = JSON.parse(readFileSync(path.join(dir, "brief.json"), "utf8"));
const { source: S, copy: C, design: D } = brief;

/* ---------- צבע ---------- */
const rgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const hex = (a) => "#" + a.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0")).join("");
const lin = (c) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
const lum = (h) => { const [r, g, b] = rgb(h); return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b); };
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
const mix = (a, b, t) => hex(rgb(a).map((v, i) => v + (rgb(b)[i] - v) * t));

// 🔴 הצבע של הלקוח הוא נקודת המוצא, לא גזר דין. קורל על קרם הוא 1.9:1,
// והמספרים בסצנה 3 נראים שטופים. מזיזים אותו למינימום שעובר, ולא יותר.
function readable(fg, bg, min = 3) {
  if (ratio(fg, bg) >= min) return fg;
  const target = lum(bg) > 0.4 ? "#000000" : "#ffffff";
  for (let t = 0.05; t <= 1; t += 0.05) {
    const c = mix(fg, target, t);
    if (ratio(c, bg) >= min) return c;
  }
  return target;
}
const rgba = (h, a) => { const [r, g, b] = rgb(h); return `rgba(${r},${g},${b},${a})`; };

const INK = D.ink || "#111111";
const LIGHT = D.light || "#FFFFFF";
const ACCENT = D.accent || "#FF6A15";
const DARK = lum(INK) < 0.08 ? mix(INK, "#ffffff", 0.05) : mix(INK, "#000000", 0.55);

/* ---------- שערים ---------- */
const missing = [];
const need = { kicker: C.kicker, headline1: C.headline1, kicker2: C.kicker2, headline2: C.headline2,
  sub2: C.sub2, tagline: C.tagline, kicker3: C.kicker3, headline3: C.headline3,
  ctaHeadline: C.ctaHeadline, ctaButton: C.ctaButton };
for (const [k, v] of Object.entries(need)) if (!String(v || "").trim()) missing.push(k);
C.rows.forEach((r, i) => { if (!r.title?.trim()) missing.push(`rows[${i}].title`); });
if (missing.length) {
  console.error("🔴 ה-brief לא מלא. שדות ריקים:\n   " + missing.join(", "));
  console.error("   מלא אותם מתוך brief.json → source, ואז הרץ שוב.");
  process.exit(1);
}

// 🔴 שער ההמצאה. כל הערך של הכלי הוא שהטקסט הוא של הלקוח. ברגע שמישהו
// כותב משפט יפה משלו, הסרטון הופך לניחוש, והלקוח מזהה את זה מיד.
const blob = [S.title, S.ogTitle, S.description, ...(S.headings || []).map((h) => h.text),
  ...(S.buttons || [])].join(" ").toLowerCase();
const invented = [];
for (const [k, v] of Object.entries({ ...need, ...Object.fromEntries(C.rows.map((r, i) => [`row${i + 1}`, r.title + " " + r.body])) })) {
  const words = String(v).replace(/<[^>]+>/g, " ").split(/[\s,.!?"״׳]+/).filter((w) => w.length >= 3);
  if (words.length < 2) continue;
  const hits = words.filter((w) => blob.includes(w.toLowerCase())).length;
  if (hits / words.length < 0.5) invented.push(`${k} (${hits}/${words.length} מהמילים מהאתר)`);
}
if (invented.length) {
  console.warn("⚠ טקסט שרובו לא נמצא באתר. ודא שזו החלטה ולא המצאה:");
  for (const i of invented) console.warn("   " + i);
}

/* ---------- גופן הלקוח, מוטמע ---------- */
const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36";
async function googleFont(family) {
  const url = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(family)}:wght@400;700;800&display=swap`;
  try {
    const css = await (await fetch(url, { headers: { "user-agent": UA } })).text();
    const urls = [...new Set([...css.matchAll(/url\((https:[^)]+\.woff2)\)/g)].map((m) => m[1]))];
    if (!urls.length) return null;
    let out = css;
    for (const u of urls.slice(0, 12)) {
      const b = Buffer.from(await (await fetch(u)).arrayBuffer());
      out = out.split(u).join(`data:font/woff2;base64,${b.toString("base64")}`);
    }
    return out;
  } catch { return null; }
}
const family = D.font || "Assistant";
let fontCss = await googleFont(family);
if (!fontCss) {
  console.warn(`⚠ ${family} לא נמצא בגוגל-פונטס. נופל לגופן מערכת.`);
  fontCss = "";
}
const stack = fontCss ? `'${family}', sans-serif` : `system-ui, 'Arial Hebrew', Arial, sans-serif`;

/* ---------- גלילה, מחושבת ולא מועתקת ---------- */
// 🔴 מספר קבוע שהתאים לאתר אחד נוחת על הפוטר של האתר הבא.
const SCREEN_H = 1146, SCREEN_W = 540;
const scale = SCREEN_W / (S.capture.mobileWidth || 860);
const shown = (S.capture.mobileHeight || 6400) * scale;
const SCROLL_Y = -Math.round(Math.min(Math.max(shown - SCREEN_H, 0), SCREEN_H * 0.75));

/* ---------- גודל כותרת לפי אורך ---------- */
const longest = (t) => Math.max(...String(t).split(/<br\s*\/?>/).map((l) => l.replace(/<[^>]+>/g, "").length));
const fit = (t, base, min) => Math.round(Math.max(min, Math.min(base, (base * 17) / Math.max(1, longest(t)))));

/* ---------- הזרקה ---------- */
const heroRel = D.heroPhoto || S.photos?.[0]?.file || S.capture.desktop;
const logoBlock = S.logoFile
  ? `<div class="logo"><img src="${S.logoFile}" alt="" /></div>`
  : `<div class="wordmark">${C.brand}</div>`;

const V = {
  FONT_CSS: fontCss, FONT_STACK: stack,
  INK, LIGHT, ACCENT, DARK,
  DARK_HI: mix(DARK, "#ffffff", 0.22), DARK_LO: mix(DARK, "#000000", 0.35),
  ACCENT_RGBA: rgba(ACCENT, 0.38),
  ACCENT_DARKBG: readable(ACCENT, DARK, 4.5),
  ACCENT_LIGHTBG: readable(ACCENT, LIGHT, 3),
  ON_ACCENT: readable(INK, ACCENT, 4.5),
  ON_ACCENT_SOFT: mix(readable(INK, ACCENT, 4.5), ACCENT, 0.35),
  MUTED: mix(INK, LIGHT, 0.45), MUTED_DARK: mix(INK, LIGHT, 0.25),
  LIGHT_A60: rgba(LIGHT, 0.6), LIGHT_A55: rgba(LIGHT, 0.55), LIGHT_A0: rgba(LIGHT, 0),
  HOST: S.host, BRAND: C.brand,
  KICKER: C.kicker, HEADLINE1: C.headline1, H1_SIZE: fit(C.headline1, 80, 54),
  KICKER2: C.kicker2, HEADLINE2: C.headline2, H2_SIZE: fit(C.headline2, 92, 58),
  SUB2: C.sub2, TAGLINE: C.tagline,
  KICKER3: C.kicker3, HEADLINE3: C.headline3,
  ROW1_TITLE: C.rows[0].title, ROW1_BODY: C.rows[0].body || "",
  ROW2_TITLE: C.rows[1].title, ROW2_BODY: C.rows[1].body || "",
  ROW3_TITLE: C.rows[2].title, ROW3_BODY: C.rows[2].body || "",
  CTA_HEADLINE: C.ctaHeadline, H4_SIZE: fit(C.ctaHeadline, 92, 58),
  CTA_BUTTON: C.ctaButton,
  LOGO_BLOCK: logoBlock, HERO_PHOTO: heroRel, SCROLL_Y,
};

let html = readFileSync(path.join(HERE, "template.html"), "utf8");
for (const [k, v] of Object.entries(V)) html = html.split(`{{${k}}}`).join(String(v));
const left = html.match(/\{\{[A-Z_0-9]+\}\}/g);
if (left) throw new Error("נשארו אסימונים בתבנית: " + [...new Set(left)].join(", "));

/* ---------- פרויקט ---------- */
const HF = "0.8.46";
const proj = ensureDir(path.join(dir, "video"));
cpSync(path.join(dir, "assets"), path.join(proj, "assets"), { recursive: true });
writeFileSync(path.join(proj, "index.html"), html);
writeFileSync(path.join(proj, "meta.json"), JSON.stringify({ id: S.host.split(".")[0], name: S.host }, null, 2));
writeFileSync(path.join(proj, "package.json"), JSON.stringify({
  name: "site-demo", private: true, type: "module",
  scripts: { check: `npx --yes hyperframes@${HF} check`, render: `npx --yes hyperframes@${HF} render -w 2` },
}, null, 2));

console.log(`→ ${S.host} · גלילה ${SCROLL_Y}px · מבטא ${ACCENT} (על בהיר ${V.ACCENT_LIGHTBG})`);
findFfmpeg(); // נופל כאן עם הודעה ברורה, ולא בתוך הרנדרר

// 🔴 -w 2 ולא ברירת המחדל. auto פותח עובד לכל ליבה, כל אחד כרום של 256MB,
// והם נחנקים. נמדד 17.9: אותה קומפוזיציה, 5:15 מול 24 שניות.
const r = spawnSync("npx", ["--yes", `hyperframes@${HF}`, "render", "-w", "2"], {
  cwd: proj, stdio: "inherit", env: process.env,
});
const renders = existsSync(path.join(proj, "renders"))
  ? readdirSync(path.join(proj, "renders")).filter((f) => f.endsWith(".mp4"))
  : [];
if (r.status !== 0 || !renders.length) {
  console.error("🔴 הרינדור לא הפיק קובץ. הרץ `npm run check` בתוך " + path.relative(process.cwd(), proj));
  process.exit(1);
}
console.log(`\n✅ ${path.join(path.relative(process.cwd(), proj), "renders", renders.sort().pop())}`);
