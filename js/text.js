// Arabic and bidirectional text handling, ported from Sources/Core/Text/ArabicText.swift.
//
// Two normalizations, never confused: display normalization is conservative
// (what was said stays what was said); index normalization is lossy and only
// ever used as a search key.

const ARABIC_RANGES = [[0x0600, 0x06ff], [0x0750, 0x077f], [0x08a0, 0x08ff], [0xfb50, 0xfdff], [0xfe70, 0xfeff]];
const LETTER = /\p{L}/u;

function inArabicBlock(cp) {
  return ARABIC_RANGES.some(([a, b]) => cp >= a && cp <= b);
}

function isLatinLetter(cp) {
  return (cp >= 0x41 && cp <= 0x5a) || (cp >= 0x61 && cp <= 0x7a) || (cp >= 0xc0 && cp <= 0x24f);
}

/** Letter counts by script. Arabic-Indic digits count as digits, not letters. */
export function scriptProfile(text) {
  let arabic = 0, latin = 0, digits = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    if ((cp >= 0x660 && cp <= 0x669) || (cp >= 0x6f0 && cp <= 0x6f9) || (cp >= 0x30 && cp <= 0x39)) digits++;
    else if (inArabicBlock(cp) && LETTER.test(ch)) arabic++;
    else if (isLatinLetter(cp)) latin++;
  }
  return { arabic, latin, digits, letters: arabic + latin };
}

export function isArabic(text) {
  const p = scriptProfile(text || "");
  return p.letters > 0 && p.arabic >= p.latin;
}

/** "ar" or "en" from the script actually present, or null for no letters. */
export function languageTagOf(text) {
  const p = scriptProfile(text || "");
  if (p.letters === 0) return null;
  return p.arabic >= p.latin ? "ar" : "en";
}

/** Conservative repair for display. Only fixes punctuation Whisper emitted in the wrong script. */
export function normalizeForDisplay(text, tag) {
  let out = (text || "").replace(/[ \t ]+/g, " ").replace(/ـ/g, "");
  if (tag === "ar") {
    out = out.replace(/\?/g, "؟").replace(/;/g, "؛");
    // Not a thousands separator: "1,000" must survive.
    out = out.replace(/(?<![0-9]),|,(?![0-9])/g, "،");
  }
  return out.trim();
}

/** Lossy search key: folds hamza, teh marbuta, alef maksura; strips harakat and tatweel. */
export function normalizeForIndex(text) {
  return (text || "")
    .toLowerCase()
    .replace(/ـ/g, "")
    .replace(/[ً-ٰٟۖ-ۭ]/g, "")
    .replace(/[أإآٱ]/g, "ا")
    .replace(/ة/g, "ه")
    .replace(/ى/g, "ي")
    .replace(/ؤ/g, "و")
    .replace(/ئ/g, "ي")
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x6f0))
    .replace(/\s+/g, " ")
    .trim();
}

/** Whisper's control tokens occasionally leak into the text. */
export function stripSpecialTokens(text) {
  return (text || "").replace(/<\|[^|]*\|>/g, "");
}

/**
 * Splits text into direction runs: [{ text, rtl: true|false|null }].
 * Neutral characters (spaces, digits, punctuation) join the run they sit in.
 */
export function directionRuns(text) {
  const runs = [];
  let current = "", currentRtl = null;
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    let rtl = null;
    if (inArabicBlock(cp) && LETTER.test(ch)) rtl = true;
    else if (isLatinLetter(cp)) rtl = false;
    if (rtl !== null && currentRtl !== null && rtl !== currentRtl) {
      runs.push({ text: current, rtl: currentRtl });
      current = "";
    }
    if (rtl !== null) currentRtl = rtl;
    current += ch;
  }
  if (current) runs.push({ text: current, rtl: currentRtl });
  return runs;
}

function letterDirection(ch) {
  const cp = ch.codePointAt(0);
  if (inArabicBlock(cp) && LETTER.test(ch)) return true;
  if (isLatinLetter(cp)) return false;
  return null;
}

/**
 * Splits text into pieces, marking the spans that should be isolated from the
 * paragraph direction: [{ text, isolate, rtl }].
 *
 * Two rules, both learned from rendering real mixed sentences:
 *  - Within a clause, a minority-script span that dominates its own range is
 *    isolated as a whole, including the base-script words it encloses. So in
 *    an English paragraph, "خالد سيتولى الاختبار (QA) يوم الاثنين" stays one
 *    right-to-left unit and its "(QA)" keeps both brackets.
 *  - Isolated spans never start or end on punctuation. Brackets and stops at
 *    the edge stay in the paragraph's own direction, where the bidi
 *    algorithm pairs them correctly; attaching "(" to one run and ")" to the
 *    next is what scattered them before.
 */
export function isolationPieces(text, baseRtl) {
  const chars = [...(text || "")];
  const minority = !baseRtl;
  const isolate = new Array(chars.length).fill(false);
  const boundary = /[.!?;:؟؛\n]/;

  let clauseStart = 0;
  for (let i = 0; i <= chars.length; i++) {
    if (i < chars.length && !boundary.test(chars[i])) continue;
    // Clause is chars[clauseStart, i).
    let first = -1, last = -1, minorityLetters = 0, baseLetters = 0;
    for (let k = clauseStart; k < i; k++) {
      const d = letterDirection(chars[k]);
      if (d === minority) { if (first < 0) first = k; last = k; }
    }
    if (first >= 0) {
      for (let k = first; k <= last; k++) {
        const d = letterDirection(chars[k]);
        if (d === minority) minorityLetters++;
        else if (d === !minority) baseLetters++;
      }
      if (minorityLetters >= baseLetters) {
        for (let k = first; k <= last; k++) isolate[k] = true;
      } else {
        // Base script dominates: isolate each minority word run on its own.
        let runStart = -1;
        for (let k = first; k <= last + 1; k++) {
          const d = k <= last ? letterDirection(chars[k]) : !minority;
          if (d === minority) { if (runStart < 0) runStart = k; }
          else if (d === !minority && runStart >= 0) {
            let end = k - 1;
            while (end > runStart && letterDirection(chars[end]) !== minority) end--;
            for (let m = runStart; m <= end; m++) isolate[m] = true;
            runStart = -1;
          }
        }
      }
    }
    clauseStart = i + 1;
  }

  const pieces = [];
  for (let i = 0; i < chars.length; i++) {
    const last = pieces[pieces.length - 1];
    if (last && last.isolate === isolate[i]) last.text += chars[i];
    else pieces.push({ text: chars[i], isolate: isolate[i], rtl: isolate[i] ? minority : baseRtl });
  }
  return pieces;
}

/**
 * Renders text into `el` with its base direction pinned from its own content,
 * and opposite-direction spans wrapped in <bdi>.
 */
export function renderBidi(el, text) {
  const rtl = isArabic(text);
  el.dir = rtl ? "rtl" : "ltr";
  el.textContent = "";
  for (const piece of isolationPieces(text, rtl)) {
    if (piece.isolate) {
      const bdi = document.createElement("bdi");
      bdi.dir = piece.rtl ? "rtl" : "ltr";
      bdi.textContent = piece.text;
      el.appendChild(bdi);
    } else {
      el.appendChild(document.createTextNode(piece.text));
    }
  }
  return el;
}

/** Same isolation using Unicode isolate marks, for canvas and plain-text export. */
export function isolatedString(text, baseRtl) {
  let out = baseRtl ? "‏" : "‎";
  for (const piece of isolationPieces(text, baseRtl)) {
    out += piece.isolate ? (piece.rtl ? "⁧" : "⁦") + piece.text + "⁩" : piece.text;
  }
  return out;
}

export function formatDuration(seconds) {
  const total = Math.round(seconds || 0);
  const h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), s = total % 60;
  const pad = (n) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/**
 * Deadline wording to a date, conservatively. A phrase we do not understand
 * yields no date rather than a wrong one. Ported from RelativeDateParser.
 */
export function parseDue(phrase, now = new Date()) {
  const text = (phrase || "").toLowerCase().trim();
  if (!text) return null;
  const day = (offset) => { const d = new Date(now); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() + offset); return d; };
  if (text.includes("today") || text.includes("اليوم")) return day(0);
  if (text.includes("tomorrow") || text.includes("بكرة") || text.includes("غدا") || text.includes("غداً")) return day(1);
  const n = text.match(/\d+/);
  if (n) {
    const count = parseInt(n[0], 10);
    if (text.includes("week")) return day(7 * count);
    if (text.includes("day")) return day(count);
  }
  if (text.includes("next week")) return day(7);
  const weekdays = [
    ["sunday", "الأحد", "الاحد"], ["monday", "الاثنين", "الإثنين"], ["tuesday", "الثلاثاء"],
    ["wednesday", "الأربعاء", "الاربعاء"], ["thursday", "الخميس"], ["friday", "الجمعة"], ["saturday", "السبت"],
  ];
  for (let i = 0; i < 7; i++) {
    if (weekdays[i].some((w) => text.includes(w))) {
      const diff = ((i - now.getDay()) + 7) % 7 || 7;
      return day(diff);
    }
  }
  return null;
}
