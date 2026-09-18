#!/usr/bin/env node
// הצעת מחיר ממותגת מתוך brief.json + business.json.
// הסקריפט לא מחליט כלום: הוא מחשב, מרנדר ומדפיס. כל בחירה אנושית
// נעשתה קודם, מול המשתמש, ונשמרה ב-brief.
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATE = path.join(HERE, "..", "templates", "quote.html");

const die = (msg) => { console.error("\n\u274c " + msg + "\n"); process.exit(1); };

// ---------- איתור כרום ----------
// סריקה של PATH בעצמנו ולא דרך `command -v`: מעטפות מסוימות מחזירות 127
// גם כשהקובץ קיים, והכישלון נראה אז כמו "כרום לא מותקן".
function which(cmd) {
  for (const dir of (process.env.PATH || "").split(path.delimiter)) {
    if (!dir) continue;
    const p = path.join(dir, cmd);
    if (existsSync(p)) return p;
  }
  return null;
}
function findChrome() {
  if (process.env.CHROME_PATH && existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH;
  const fixed = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  ];
  for (const p of fixed) if (existsSync(p)) return p;
  for (const c of ["google-chrome", "chromium", "chromium-browser", "chrome"]) {
    const p = which(c);
    if (p) return p;
  }
  // פאפטיר שכבר הוריד כרום לפרויקט אחר הוא כרום לכל דבר
  const cache = path.join(process.env.HOME || "", ".cache", "puppeteer");
  if (existsSync(cache)) {
    for (const dir of readdirSync(cache)) {
      const mac = path.join(cache, dir, "chrome-mac-arm64", "Google Chrome for Testing.app", "Contents", "MacOS", "Google Chrome for Testing");
      if (existsSync(mac)) return mac;
      const lin = path.join(cache, dir, "chrome-linux64", "chrome");
      if (existsSync(lin)) return lin;
    }
  }
  return null;
}

// ---------- צבע ----------
const hex = (h) => { h = String(h || "").replace("#", ""); if (h.length === 3) h = h.split("").map(c => c + c).join(""); return [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16) || 0); };
const lum = (h) => { const [r, g, b] = hex(h).map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
// 🔴 טקסט לבן על צהוב מותגי הוא הצעת מחיר שאי אפשר לקרוא. הכותרת של
// הטבלה נצבעת לפי הניגודיות בפועל ולא לפי הנחה.
const onBrand = (brand) => (ratio("#ffffff", brand) >= 3.5 ? "#ffffff" : "#111111");
const soften = (brand) => { const [r, g, b] = hex(brand); const m = (v) => Math.round(v + (255 - v) * 0.92); return `#${[m(r), m(g), m(b)].map(v => v.toString(16).padStart(2, "0")).join("")}`; };

// ---------- מספרים ----------
const money = (n, cur) => `${cur}${Number(n).toLocaleString("en-US", { minimumFractionDigits: Number.isInteger(Number(n)) ? 0 : 2, maximumFractionDigits: 2 })}`;
const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// ---------- קלט ----------
const dir = path.resolve(process.argv[2] || ".");
const briefPath = path.join(dir, "brief.json");
const bizPath = path.join(dir, "business.json");

if (!existsSync(briefPath)) die(`לא נמצא ${briefPath}`);
if (!existsSync(bizPath)) die(
  `לא נמצא ${bizPath}\n` +
  `זה הקובץ שממלאים פעם אחת בחיים: שם העסק, לוגו, צבע, פרטי קשר ותנאים.\n` +
  `יש דוגמה ב-business.example.json שליד הסקיל.`
);

const brief = JSON.parse(readFileSync(briefPath, "utf8"));
const biz = JSON.parse(readFileSync(bizPath, "utf8"));

// 🔴 שער האישור. הוא בקוד ולא בהנחיה, כי הנחיה נשכחת בדיוק בפעם
// שממהרים בה, וזו בדיוק הפעם שבה הצעה שגויה יוצאת ללקוח.
if (brief.confirmed !== true) die(
  `ה-brief לא אושר.\n` +
  `הצג למשתמש את הפרטים שחילצת, קבל ממנו אישור מפורש, ורק אז\n` +
  `כתוב "confirmed": true בתוך brief.json והרץ שוב.`
);

const missing = [];
if (!brief.clientName) missing.push("clientName");
if (!brief.title) missing.push("title");
if (!Array.isArray(brief.items) || brief.items.length === 0) missing.push("items");
if (!biz.businessName) missing.push("business.businessName");
if (missing.length) die("שדות חסרים: " + missing.join(", "));

// ---------- חישוב ----------
const cur = biz.currencySymbol || "\u20aa";
const vatPct = biz.vatPercent === undefined ? 18 : Number(biz.vatPercent);
const vatIncluded = biz.vatIncludedInPrices === true;

let subtotal = 0;
const rows = brief.items.map((it) => {
  const qty = it.qty === undefined ? 1 : Number(it.qty);
  const price = Number(it.unitPrice || 0);
  const line = qty * price;
  subtotal += line;
  // מחיר 0 הוא כמעט תמיד פריט שנכלל בחבילה, ו-"₪0" על הדף קורא כמו
  // טעות. מי שבאמת רוצה אפס כותב אותו בטקסט.
  const cell = price === 0 ? "כלול" : money(price, cur);
  return `<tr>
      <td>${esc(it.name)}${it.detail ? `<span class="detail">${esc(it.detail)}</span>` : ""}</td>
      <td class="num">${qty}</td>
      <td class="${price === 0 ? "" : "num"}">${cell}</td>
      <td class="left ${price === 0 ? "" : "num"}">${cell === "כלול" ? "כלול" : money(line, cur)}</td>
    </tr>`;
}).join("\n      ");

const discount = Number(brief.discount || 0);
const afterDiscount = subtotal - discount;
const vat = vatPct > 0 && !vatIncluded ? afterDiscount * (vatPct / 100) : 0;
const grand = afterDiscount + vat;

const totalRows = [];
totalRows.push(`<tr><td>סכום ביניים</td><td class="left num">${money(subtotal, cur)}</td></tr>`);
if (discount > 0) totalRows.push(`<tr><td>הנחה</td><td class="left num">-${money(discount, cur)}</td></tr>`);
if (vat > 0) totalRows.push(`<tr><td>מע״מ <span class="num">${vatPct}%</span></td><td class="left num">${money(vat, cur)}</td></tr>`);
totalRows.push(`<tr class="grand"><td>סה״כ לתשלום${vatIncluded && vatPct > 0 ? " (כולל מע״מ)" : ""}</td><td class="left num">${money(grand, cur)}</td></tr>`);

// ---------- תוקף ----------
// 🔴 תאריך אמיתי ולא "14 יום מהיום". לקוח שפותח את הקובץ בעוד שבועיים
// לא יודע מתי "היום" היה, ומשפט התוקף מפסיק להיות תוקף.
const dmy = (d) => `${d.getDate()}.${d.getMonth() + 1}.${d.getFullYear()}`;
let validUntil = brief.validUntil || "";
if (!validUntil && brief.validDays) {
  const d = new Date();
  d.setDate(d.getDate() + Number(brief.validDays));
  validUntil = dmy(d);
}

// ---------- תנאים ----------
const terms = [...(biz.terms || [])];
if (validUntil) terms.unshift(`ההצעה בתוקף עד ${validUntil}`);
for (const n of brief.notes || []) terms.push(n);
const termsHtml = terms.length
  ? `<div class="terms"><h3>תנאים ודגשים</h3><ul>${terms.map(t => `<li>${esc(t)}</li>`).join("")}</ul></div>`
  : "";

// ---------- לוגו ----------
let logoHtml = "";
if (biz.logoPath) {
  const lp = path.isAbsolute(biz.logoPath) ? biz.logoPath : path.join(dir, biz.logoPath);
  if (existsSync(lp)) {
    const ext = path.extname(lp).slice(1).toLowerCase();
    const mime = ext === "svg" ? "image/svg+xml" : ext === "jpg" ? "image/jpeg" : `image/${ext}`;
    // הטמעה כ-base64 ולא כנתיב: כרום מדפיס מ-file:// ותמונה חיצונית
    // נופלת בשקט ומשאירה ריבוע ריק במקום הלוגו.
    logoHtml = `<img class="logo" src="data:${mime};base64,${readFileSync(lp).toString("base64")}" />`;
  } else {
    console.warn(`\u26a0  logoPath מצביע על קובץ שלא קיים: ${lp}. ממשיך בלי לוגו.`);
  }
}

const brand = biz.colors?.brand || "#1f3a5f";
const today = brief.date || new Date().toLocaleDateString("he-IL");
const contact = biz.contact || {};
const contactLine = [contact.phone, contact.email, contact.site].filter(Boolean).join("  \u00b7  ");

const isSample = brief.sample === true;

const html = readFileSync(TEMPLATE, "utf8")
  .replaceAll("{{BRAND}}", brand)
  .replaceAll("{{ON_BRAND}}", onBrand(brand))
  .replaceAll("{{SOFT}}", soften(brand))
  .replaceAll("{{TEXT}}", biz.colors?.text || "#141414")
  .replaceAll("{{SAMPLE_BANNER}}", isSample ? `<div class="sample">מסמך לדוגמה</div>` : "")
  .replaceAll("{{LOGO}}", logoHtml)
  // הרבה לוגואים כוללים את שם העסק בתוכם, ואז הכותרת מופיעה פעמיים
  // זו לצד זו. הדגל קיים כי זה המקרה הנפוץ ולא החריג.
  .replaceAll("{{BIZ_BLOCK}}", (logoHtml && biz.logoIncludesName === true)
    ? (biz.tagline ? `<p class="tagline" style="margin-top:4mm">${esc(biz.tagline)}</p>` : "")
    : `<h1>${esc(biz.businessName)}</h1>${biz.tagline ? `<p class="tagline">${esc(biz.tagline)}</p>` : ""}`)
  .replaceAll("{{QUOTE_NUMBER}}", esc(brief.quoteNumber || "-"))
  .replaceAll("{{DATE}}", esc(today))
  .replaceAll("{{TITLE}}", esc(brief.title))
  .replaceAll("{{CLIENT}}", esc(brief.clientName))
  .replaceAll("{{CLIENT_COMPANY}}", brief.clientCompany ? `, ${esc(brief.clientCompany)}` : "")
  .replaceAll("{{INTRO}}", esc(brief.intro || ""))
  .replaceAll("{{ROWS}}", rows)
  .replaceAll("{{TOTALS}}", totalRows.join("\n    "))
  .replaceAll("{{TERMS}}", termsHtml)
  .replaceAll("{{CONTACT_NAME}}", esc(contact.name || biz.businessName))
  .replaceAll("{{FOOTER_LEFT}}", esc([biz.businessName, biz.footer].filter(Boolean).join("  \u00b7  ")))
  .replaceAll("{{FOOTER_RIGHT}}", esc(contactLine));

// ---------- פלט ----------
const outDir = path.join(dir, "out");
mkdirSync(outDir, { recursive: true });
const slug = String(brief.clientName).replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "");
const base = `הצעת-מחיר-${slug}`;
const htmlPath = path.join(outDir, base + ".html");
const pdfPath = path.join(outDir, base + ".pdf");
writeFileSync(htmlPath, html);

const chrome = findChrome();
if (!chrome) die(
  "לא נמצא כרום, ובלעדיו אין PDF.\n" +
  `ה-HTML נשמר ב-${htmlPath} ואפשר לפתוח אותו ולהדפיס לקובץ ידנית.\n` +
  "להתקנה: https://www.google.com/chrome  או  CHROME_PATH=/path/to/chrome"
);

const r = spawnSync(chrome, [
  "--headless", "--disable-gpu", "--no-sandbox",
  "--no-pdf-header-footer",
  `--print-to-pdf=${pdfPath}`,
  "file://" + htmlPath,
], { encoding: "utf8", timeout: 60000 });

if (!existsSync(pdfPath)) die("כרום לא הפיק PDF.\n" + (r.stderr || "").split("\n").slice(-6).join("\n"));

// ---------- הודעת הוואטסאפ ----------
const first = brief.clientName.split(" ")[0];
const waLines = [
  `היי ${first},`,
  "",
  brief.whatsappOpener || `נעים לדבר. מצרף את הצעת המחיר ל${brief.title}.`,
  "",
  `סה״כ: ${money(grand, cur)}${vat > 0 ? " כולל מע״מ" : ""}`,
  validUntil ? `בתוקף עד ${validUntil}` : "",
  "",
  "כל שאלה, אני כאן.",
  contact.name || biz.businessName,
].filter((l, i, a) => !(l === "" && a[i - 1] === ""));
const waPath = path.join(outDir, "whatsapp.txt");
writeFileSync(waPath, waLines.join("\n"));

console.log(`
\u2705 ההצעה מוכנה.

PDF        ${pdfPath}
וואטסאפ    ${waPath}
סה״כ       ${money(grand, cur)}${vat > 0 ? ` (כולל מע״מ ${vatPct}%)` : ""}

פתח את ה-PDF ותסתכל עליו לפני ששולח.
`);
