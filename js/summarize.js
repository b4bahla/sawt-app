// On-device, extractive meeting summary for Arabic and English.
//
// Why extractive: every small language model that fits in Safari on an iPhone
// was tested for this app and produced either garbage (q4f16 on WebGPU) or
// fluent text unrelated to the meeting (8-bit on CPU). Minutes that invent
// decisions are worse than none. So this quotes what was actually said:
// sentences are scored and classified, never rewritten, which makes it
// instant, private, and incapable of inventing anything.

import { normalizeForIndex, isArabic, formatDuration, parseDue } from "./text.js";

const STOP_EN = new Set(("a an the and or but if then so of to in on at by for from with about as is are was were be been " +
  "being it its this that these those i you he she we they me him her us them my your our their do does did done have has " +
  "had not no yes ok okay just like very really also too can could would should will shall may might must there here what " +
  "which who whom when where why how all any some more most other such only own same than into over after before again " +
  "let lets us going get got go um uh yeah right well think know one two").split(" "));
const STOP_AR = new Set(("في من على الى إلى عن مع هذا هذه ذلك تلك التي الذي الذين هو هي هم انا أنا نحن انت أنت كان كانت يكون " +
  "لا لم لن ما ماذا متى كيف اين أين هل او أو ثم لكن بس يعني كذا عشان علشان حتى قد كل بعض اي أي ايضا أيضا جدا وين شو ايش " +
  "إيش هذي هاذا تمام طيب اوكي زين والله ان أن إن كما عند لو اذا إذا وش").split(" "));

const DECISION = [
  /\b(agreed|decided|decision|approved|confirmed|final(ly|ized)?|we('| wi)ll go with|settled on|signed off)\b/i,
  /(اتفقنا|قررنا|تقرر|تم الاتفاق|القرار|وافق|وافقنا|اعتمد|اعتمدنا|نعتمد|خلاص نمشي)/,
];
const ACTION = [
  /\b(will|'ll|going to|needs? to|has to|have to|must|should|please|action item|follow[- ]up|take care of|responsible for|assigned?)\b/i,
  /(سوف|سيقوم|سيتولى|سيتابع|سيرسل|ستقوم|راح|رح|لازم|يجب|الرجاء|يرجى|نحتاج|تكفى|أبيك|ابيك|خلك|بيرسل|بيسوي|بتسوي)/,
];
const DEADLINE = /\b(by|before|on|until|due|next|this|tomorrow|today|tonight|end of (the )?(day|week|month))\b|\b(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b|(بكرة|بكره|غدا|غداً|اليوم|الأسبوع|الاسبوع|الشهر|قبل|الأحد|الاحد|الاثنين|الإثنين|الثلاثاء|الأربعاء|الاربعاء|الخميس|الجمعة|السبت)/i;
const QUESTION = /[?؟]\s*$/;

function sentencesOf(segments) {
  const out = [];
  for (const seg of segments) {
    const parts = (seg.text || "").split(/(?<=[.!?؟])\s+/);
    for (const raw of parts) {
      const text = raw.trim();
      if (text.split(/\s+/).length < 3) continue;
      out.push({ text, start: seg.start, words: contentWords(text) });
    }
  }
  return out;
}

function contentWords(text) {
  return normalizeForIndex(text)
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !STOP_EN.has(w) && !STOP_AR.has(w));
}

function similar(a, b) {
  const A = new Set(a.words), B = new Set(b.words);
  if (!A.size || !B.size) return false;
  let inter = 0;
  for (const w of A) if (B.has(w)) inter++;
  return inter / (A.size + B.size - inter) > 0.55;
}

/** Owner: "Ahmed will…", "Ahmed, please…", "please, Ahmed…", or an Arabic name before a future verb. */
function ownerOf(text) {
  let m = text.match(/^(?:okay|ok|so|and|then)?[\s,]*([A-Z][a-z]+(?:\s[A-Z][a-z]+)?)(?=\s*,?\s+(?:will|'ll|is going to|needs to|has to|should|can|please|to))/);
  if (m) return m[1];
  m = text.match(/\bplease,?\s+([A-Z][a-z]+)\b/) || text.match(/^([A-Z][a-z]+),\s/);
  if (m && !/^(Please|Okay|So|And|Then|The|We|I|You|Let)$/.test(m[1])) return m[1];
  m = text.match(/^([ء-ي]{2,})\s+(?:سوف|راح|رح|س[ء-ي]+|ب[ء-ي]+)/);
  if (m && !STOP_AR.has(m[1])) return m[1];
  return null;
}

/** The deadline words as spoken, trimmed to the phrase. */
function deadlineOf(text) {
  const en = text.match(/\b(?:by|before|on|until|due)\s+(?:the\s+)?(?:end of (?:the )?(?:day|week|month)|next \w+|this \w+|tomorrow|today|tonight|[A-Z]?[a-z]+day|\d{1,2}(?:st|nd|rd|th)?(?: of \w+)?)\b/i)
    || text.match(/\b(?:tomorrow|today|tonight|next week|this week)\b/i);
  if (en) return en[0];
  const ar = text.match(/(?:قبل|يوم|نهاية)?\s*(?:بكرة|بكره|غدا|غداً|اليوم|الأسبوع الجاي|الاسبوع الجاي|الأسبوع القادم|الأحد|الاحد|الاثنين|الإثنين|الثلاثاء|الأربعاء|الاربعاء|الخميس|الجمعة|السبت)/);
  return ar ? ar[0].trim() : null;
}

function cleanTask(text) {
  return text
    .replace(/^(okay|ok|so|and|then|alright)[,\s]+/i, "")
    .replace(/^([A-Z][a-z]+),\s+please\s+/, "")
    .replace(/^please,?\s+/i, "")
    .replace(/[.!]+$/, "")
    .trim()
    .replace(/^./, (c) => c.toUpperCase());
}

export function summarize(segments, outputLanguage = "en") {
  const sentences = sentencesOf(segments);
  const ar = outputLanguage === "ar";
  const H = ar
    ? { attendees: "## الأشخاص المذكورون", decisions: "## القرارات", discussion: "## النقاش", actions: "## المهام", questions: "## أسئلة مفتوحة", none: "- لم يُذكر" }
    : { attendees: "## People mentioned", decisions: "## Decisions", discussion: "## Discussion", actions: "## Action items", questions: "## Open questions", none: "- Not recorded" };

  if (!sentences.length) {
    return { summary: "", keyPoints: [], minutes: [H.decisions, H.none].join("\n"), tasks: [] };
  }

  // Word importance across the whole meeting.
  const freq = new Map();
  for (const s of sentences) for (const w of new Set(s.words)) freq.set(w, (freq.get(w) || 0) + 1);

  for (const s of sentences) {
    const base = s.words.reduce((sum, w) => sum + Math.log(1 + (freq.get(w) || 0)), 0) / Math.sqrt(Math.max(4, s.words.length));
    s.isDecision = DECISION.some((re) => re.test(s.text));
    s.isAction = ACTION.some((re) => re.test(s.text)) && (DEADLINE.test(s.text) || !!ownerOf(s.text));
    s.isQuestion = QUESTION.test(s.text) && s.words.length >= 3;
    s.score = base + (s.isDecision ? 2 : 0) + (s.isAction ? 1.5 : 0) + (/\d/.test(s.text) ? 0.4 : 0);
  }

  const pick = (list, n) => {
    const chosen = [];
    for (const s of [...list].sort((a, b) => b.score - a.score)) {
      if (chosen.length >= n) break;
      if (!chosen.some((c) => similar(c, s))) chosen.push(s);
    }
    return chosen.sort((a, b) => a.start - b.start);
  };

  const keyPoints = pick(sentences.filter((s) => s.words.length >= 3), Math.min(8, Math.max(3, Math.round(sentences.length / 2.5))));
  const decisions = pick(sentences.filter((s) => s.isDecision), 8);
  const actions = pick(sentences.filter((s) => s.isAction && !s.isQuestion), 12);
  const questions = pick(sentences.filter((s) => s.isQuestion), 6);
  const discussion = pick(sentences.filter((s) => !s.isDecision && !s.isAction && !s.isQuestion), Math.min(8, Math.max(2, Math.round(sentences.length / 4))));

  const tasks = actions.map((s) => {
    const due = deadlineOf(s.text);
    return {
      title: cleanTask(s.text),
      owner: ownerOf(s.text),
      due,
      dueDate: due ? parseDue(due)?.toISOString() ?? null : null,
      timestamp: s.start,
      done: false,
    };
  });

  const people = [...new Set(tasks.map((t) => t.owner).filter(Boolean))];
  const stamp = (s) => `[${formatDuration(s.start)}] `;
  const list = (items) => (items.length ? items.map((s) => "- " + stamp(s) + s.text).join("\n") : H.none);

  const minutes = [
    H.attendees, people.length ? people.map((p) => "- " + p).join("\n") : H.none, "",
    H.decisions, list(decisions), "",
    H.discussion, list(discussion), "",
    H.actions, tasks.length ? tasks.map((t) => `- ${t.title}${t.owner ? " — " + t.owner : ""}${t.due ? " (" + t.due + ")" : ""}`).join("\n") : H.none, "",
    H.questions, list(questions),
  ].join("\n");

  const minutesLong = Math.max(1, Math.round((segments[segments.length - 1].end || 0) / 60));
  const summary = ar
    ? `مدة النقاش: ${minutesLong} د تقريباً · القرارات: ${decisions.length} · المهام: ${tasks.length}${people.length ? " · المسؤولون: " + people.join("، ") : ""}.`
    : `About ${minutesLong} minute${minutesLong === 1 ? "" : "s"} of discussion. ${decisions.length ? `${decisions.length} decision${decisions.length === 1 ? " was" : "s were"} recorded. ` : ""}${tasks.length ? `${tasks.length} action item${tasks.length === 1 ? "" : "s"}${people.length ? ", owned by " + people.join(", ") : ""}.` : "No specific action items were recorded."}`;

  return { summary, keyPoints: keyPoints.map((s) => s.text), minutes, tasks };
}

export { isArabic };
