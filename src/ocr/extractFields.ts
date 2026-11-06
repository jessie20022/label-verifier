import { parseVolumeMl, similarity, stripToAlnum } from "../rules/normalize";
import type { LabelFields } from "../rules/types";
import type { Hints, OcrLine, OcrWord } from "./types";

/** Set to true to print what the extractor saw and decided (useful when tuning). */
const DEBUG = false;
const debug = (...args: unknown[]) => {
  if (DEBUG) console.log(...args);
};

const WARNING_RE = /g[o0]vernment\s+warn/i;
const WARNING_END_RE = /health\s+problems\.?/i;

/** Producer information, not the brand. */
const BOTTLER_RE =
  /\b(bottled|distilled|produced|imported|packed|blended|manufactured|brewed|vinted|cellared)\b.*\bby\b/i;

const CLASS_WORDS = [
  "whiskey",
  "whisky",
  "bourbon",
  "scotch",
  "rye",
  "vodka",
  "gin",
  "rum",
  "tequila",
  "mezcal",
  "brandy",
  "cognac",
  "liqueur",
  "cordial",
  "schnapps",
  "absinthe",
  "wine",
  "champagne",
  "cabernet",
  "chardonnay",
  "merlot",
  "pinot",
  "sauvignon",
  "riesling",
  "zinfandel",
  "shiraz",
  "malbec",
  "rose",
  "beer",
  "ale",
  "lager",
  "stout",
  "porter",
  "ipa",
  "pilsner",
  "cider",
  "sake",
  "malt",
];

/** Words that describe a class/type without being a category themselves ("Kentucky Straight ..."). */
const CLASS_MODIFIERS = new Set([
  "kentucky",
  "tennessee",
  "straight",
  "single",
  "blended",
  "irish",
  "canadian",
  "american",
  "scotch",
  "pure",
  "reposado",
  "anejo",
  "extra",
  "blanco",
  "silver",
  "gold",
  "joven",
  "barrel",
  "aged",
  "reserve",
  "reserva",
  "dry",
  "sweet",
  "spiced",
  "dark",
  "white",
  "red",
  "rose",
  "sparkling",
  "ruby",
  "tawny",
  "frontier",
  "london",
  "premium",
  "small",
  "batch",
  "distilled",
  "spirits",
]);

const ORIGIN_PATTERNS: Array<[RegExp, number]> = [
  [/\b(?:product|produce)\s+of\s+[A-Za-z][A-Za-z .'-]*/i, 0],
  [/\bimported\s+from\s+[A-Za-z][A-Za-z .'-]*/i, 0],
  [/\bcountry\s+of\s+origin\s*[:\-]?\s*([A-Za-z][A-Za-z .'-]*)/i, 1],
];

const ABV_RE = /\b\d{1,2}(?:\.\d+)?\s*%\s*(?:alc(?:ohol)?\.?\s*\/?\s*vol\.?)?/i;

const PROOF_RE = /\b\d{1,3}(?:\.\d+)?\s*proof\b/i;

const VOLUME_RE = /\b\d+(?:\.\d+)?\s*(?:mL|ml|ML|L|l|cL|cl|oz|fl\.?\s*oz)\b/i;

const CLASS_RE =
  /\b(?:straight\s+)?(?:bourbon|rye|scotch|whiskey|whisky|vodka|gin|rum|tequila|mezcal|brandy|cognac|liqueur|cordial|schnapps|absinthe|wine|champagne|cabernet|chardonnay|merlot|pinot|sauvignon|riesling|zinfandel|shiraz|malbec|ros[eé]|beer|ale|lager|stout|porter|ipa|pilsner|cider|sake|malt)\b/i;

function normalizeClassText(text: string): string {
  return text
    .toLowerCase()
    .replace(/0/g, "o")
    .replace(/1/g, "i")
    .replace(/5/g, "s")
    .replace(/8/g, "b")
    .replace(/[^a-z\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** How close some label text must be to the application's value to be taken as "that text". */
const LOCATE_MIN = 0.82;
/** Among near-equal matches, the biggest print wins; "near" means within this much similarity. */
const LOCATE_NEAR = 0.02;
const SIZE_TOLERANCE = 0.25;

const height = (line: OcrLine) => line.bbox.y1 - line.bbox.y0;
const centerY = (line: OcrLine) => (line.bbox.y0 + line.bbox.y1) / 2;
const letters = (text: string) => (text.match(/[A-Za-z]/g) ?? []).length;
const mean = (values: number[]) =>
  values.length ? values.reduce((sum, v) => sum + v, 0) / values.length : 0;

/** Common sizes, in mL, of alcohol containers. */
const STANDARD_ML = [
  50, 100, 187, 200, 355, 375, 473, 500, 700, 720, 750, 1000, 1750, 3000,
];

/** One thing the reader saw that looks like a percentage, a proof or a volume. */
export interface Seen<T> {
  value: T;
  /** The text as printed, for display. */
  text: string;
  /** OCR confidence of the line it came from, scaled down when the value was inferred. */
  conf: number;
}

export interface Evidence {
  percents: Array<Seen<number>>;
  proofs: Array<Seen<number>>;
  volumes: Array<Seen<number>>;
}

export interface Extraction {
  fields: LabelFields;
  warningWords: { header: OcrWord[]; body: OcrWord[] };
  /** Every percentage, proof and volume seen, so several readings can be combined by voting. */
  evidence: Evidence;
  /** Average OCR confidence of the text each field was taken from (missing when not found). */
  confidence: Partial<Record<keyof LabelFields, number>>;
}

interface Located {
  text: string;
  lines: number[];
  score: number;
  height: number;
  conf: number;
}

/** Several OCR fragments that sit on the same visual row, joined left to right. */
interface Row extends OcrLine {
  members: number[];
}

function sameRow(a: OcrLine, b: OcrLine): boolean {
  const overlap =
    Math.min(a.bbox.y1, b.bbox.y1) - Math.max(a.bbox.y0, b.bbox.y0);
  return (
    overlap >= 0.3 * Math.min(height(a), height(b)) &&
    Math.abs(centerY(a) - centerY(b)) <= 0.6 * Math.max(height(a), height(b))
  );
}

/**
 * Sparse OCR returns one label row as several pieces ("KENTUCKY STRAIGHT B" ... "OURBON WHISKEY").
 * Join pieces that sit on the same row so that text can be found even when the reader split it.
 */
function buildRows(lines: OcrLine[], indexes: number[]): Row[] {
  const items = indexes
    .map((index) => ({ line: lines[index], index }))
    .sort((a, b) => centerY(a.line) - centerY(b.line));

  const groups: Array<{ anchor: OcrLine; items: typeof items }> = [];

  for (const item of items) {
    const group = groups.find((g) => sameRow(g.anchor, item.line));
    if (group) group.items.push(item);
    else groups.push({ anchor: item.line, items: [item] });
  }

  return groups.map((group) => {
    const parts = [...group.items].sort(
      (a, b) => a.line.bbox.x0 - b.line.bbox.x0
    );
    return {
      text: parts.map((p) => p.line.text).join(" "),
      confidence: mean(parts.map((p) => p.line.confidence)),
      bbox: {
        x0: Math.min(...parts.map((p) => p.line.bbox.x0)),
        y0: Math.min(...parts.map((p) => p.line.bbox.y0)),
        x1: Math.max(...parts.map((p) => p.line.bbox.x1)),
        y1: Math.max(...parts.map((p) => p.line.bbox.y1)),
      },
      words: parts.flatMap((p) => p.line.words),
      members: parts.map((p) => p.index),
    };
  });
}

/** Mostly real-looking words, not a scatter of stray characters ("AL pn 9 oro EEO"). */
function looksLikeWords(text: string): boolean {
  const words = text.split(/\s+/).filter(Boolean);
  if (!words.length) return false;
  const good = words.filter((w) => {
    const l = w.replace(/[^A-Za-z]/g, "");
    if (l.length < 3 || l.length < w.replace(/['".,&-]/g, "").length * 0.8)
      return false;
    const title = l === l[0].toUpperCase() + l.slice(1).toLowerCase();
    return (
      (l === l.toUpperCase() || l === l.toLowerCase() || title) &&
      /[aeiouyAEIOUY]/.test(l)
    );
  });
  return good.length >= Math.ceil(words.length * 0.6);
}

/** Tidy text that is about to be shown as "what the label says". */
function cleanText(text: string): string {
  return text
    .replace(/[™®©℠]/g, " ")
    .replace(/(?<=[A-Za-z])["“”'’`](?=[A-Za-z]{2,})/g, " ")
    .replace(/^[^\w'(]+|[^\w'.)]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Find the stretch of label text that best matches `target`, keeping the label's own
 * capitalization and punctuation. Works on whole rows, so text the reader cut in pieces is
 * still found. Returns null if nothing is close enough.
 */
function locate(
  lines: OcrLine[],
  allowed: Set<number>,
  target: string
): Located | null {
  if (stripToAlnum(target).length < 3) return null;

  const rows = buildRows(
    lines,
    [...allowed].sort((a, b) => a - b)
  );
  const maxWords = target.trim().split(/\s+/).length + 4;
  const found: Located[] = [];

  for (let i = 0; i < rows.length; i++) {
    for (let span = 1; span <= 3 && i + span <= rows.length; span++) {
      const group = rows.slice(i, i + span);
      const words = group
        .map((row) => row.text)
        .join(" ")
        .split(/\s+/)
        .filter(Boolean);

      for (let a = 0; a < words.length; a++) {
        for (let b = a + 1; b <= Math.min(words.length, a + maxWords); b++) {
          const candidate = words.slice(a, b).join(" ");
          const score = similarity(candidate, target);

          if (score >= LOCATE_MIN) {
            found.push({
              text: cleanText(candidate),
              lines: group.flatMap((row) => row.members),
              score,
              height: Math.max(...group.map((row) => height(row))),
              conf: mean(group.map((row) => row.confidence)),
            });
          }
        }
      }
    }
  }

  if (!found.length) return null;

  const top = Math.max(...found.map((f) => f.score));
  const near = found.filter((f) => f.score >= top - LOCATE_NEAR);

  // Prefer the biggest print among equally good matches (the real brand, not a small mention).
  near.sort((x, y) => y.height - x.height || y.score - x.score);
  return near[0];
}

interface WordHit {
  text: string;
  token: number;
  score: number;
  line: number;
  yc: number;
  x: number;
  h: number;
  conf: number;
}

/**
 * Word-by-word search for the application's text on the label. Printed text is often read in
 * broken pieces ("KENTUCKY STRAIGHT BOURBON" + "WHISKEY" + a half-read copy), so instead of
 * hoping for one clean line this looks for each word separately and keeps the words that sit
 * together on the label. It reports the label's own words, in label order: a word the label does
 * not have is simply missing from the result, so real differences still show up.
 */
function locateByWords(
  lines: OcrLine[],
  allowed: Set<number>,
  target: string,
  preferLarge = false
): Located | null {
  const tokens = target
    .split(/[^A-Za-z0-9']+/)
    .map((t) => t.replace(/^'+|'+$/g, ""))
    .filter((t) => t.length >= 2);
  const wanted = tokens.filter((t) => stripToAlnum(t).length >= 3);
  if (!wanted.length) return null;

  interface Piece {
    text: string;
    line: number;
    conf: number;
    box: OcrWord["bbox"];
  }
  const pieces: Piece[] = [];
  for (const index of allowed) {
    const line = lines[index];
    const words = line.words.length
      ? line.words
      : [{ text: line.text, confidence: line.confidence, bbox: line.bbox }];
    for (const word of words) {
      const parts = word.text
        .split(/[^A-Za-z0-9']+/)
        .map((t) => t.replace(/^'+|'+$/g, ""))
        .filter(Boolean);
      for (const part of parts) {
        pieces.push({
          text: part,
          line: index,
          conf: word.confidence,
          box: word.bbox,
        });
      }
    }
  }

  // A thick or decorated word is sometimes read in two pieces ("BOU" + "RBON"). Offer the pieces
  // that sit side by side on one row, joined, as extra candidates.
  const joined: Piece[] = [];
  for (const a of pieces) {
    const ha = a.box.y1 - a.box.y0;
    for (const b of pieces) {
      if (a === b) continue;
      const hb = b.box.y1 - b.box.y0;
      const gap = b.box.x0 - a.box.x1;
      const dy = Math.abs(
        (a.box.y0 + a.box.y1) / 2 - (b.box.y0 + b.box.y1) / 2
      );
      if (
        gap >= -ha * 0.3 &&
        gap <= Math.max(ha, hb) * 0.8 &&
        dy <= Math.min(ha, hb) * 0.6 &&
        a.text.length + b.text.length >= 5
      ) {
        joined.push({
          text: a.text + b.text,
          line: a.line,
          conf: Math.min(a.conf, b.conf) * 0.9,
          box: {
            x0: Math.min(a.box.x0, b.box.x0),
            y0: Math.min(a.box.y0, b.box.y0),
            x1: Math.max(a.box.x1, b.box.x1),
            y1: Math.max(a.box.y1, b.box.y1),
          },
        });
      }
    }
  }

  const hits: WordHit[] = [];
  for (const piece of [...pieces, ...joined]) {
    wanted.forEach((token, ti) => {
      let text = piece.text;
      let score = similarity(text, token);
      // Two words run together ("BULLEITBOURBON"): look for the word inside the piece.
      if (piece.text.length >= token.length + 3 && token.length >= 5) {
        for (let len = token.length - 1; len <= token.length + 1; len++) {
          for (let at = 0; at + len <= piece.text.length; at++) {
            const window = piece.text.slice(at, at + len);
            const s2 = similarity(window, token);
            if (s2 > score && s2 >= 0.85) {
              score = s2;
              text = window;
            }
          }
        }
      }
      const need = token.length <= 4 ? 0.99 : 0.8;
      if (score >= need) {
        hits.push({
          text,
          token: ti,
          score,
          line: piece.line,
          yc: (piece.box.y0 + piece.box.y1) / 2,
          x: piece.box.x0,
          h: Math.max(1, piece.box.y1 - piece.box.y0),
          conf: piece.conf,
        });
      }
    });
  }
  if (!hits.length) return null;

  let best: {
    picked: WordHit[];
    spread: number;
    score: number;
    size: number;
  } | null = null;

  for (const seed of hits) {
    // Up to two rows of print ("KENTUCKY STRAIGHT" over "BOURBON WHISKEY").
    const reach = seed.h * 2.4;
    const picked: WordHit[] = [];
    for (let ti = 0; ti < wanted.length; ti++) {
      const options = hits
        .filter((h) => h.token === ti && Math.abs(h.yc - seed.yc) <= reach)
        .sort(
          (a, b) =>
            Math.abs(a.yc - seed.yc) - Math.abs(b.yc - seed.yc) ||
            b.score - a.score
        );
      if (options[0]) picked.push(options[0]);
    }
    if (!picked.length) continue;
    const ys = picked.map((h) => h.yc);
    const spread = Math.max(...ys) - Math.min(...ys);
    const score = mean(picked.map((h) => h.score));
    const size = mean(picked.map((h) => h.h));
    const wins = (b: NonNullable<typeof best>) => {
      if (picked.length !== b.picked.length)
        return picked.length > b.picked.length;
      // Brand: the biggest print is the brand, not a small mention in the address.
      if (preferLarge && Math.abs(size - b.size) > b.size * 0.25)
        return size > b.size;
      if (Math.abs(score - b.score) > 0.04) return score > b.score;
      return spread < b.spread;
    };
    if (!best || wins(best)) best = { picked, spread, score, size };
  }

  if (!best) return null;
  const need = wanted.length === 1 ? 1 : Math.ceil(wanted.length * 0.6);
  if (best.picked.length < need) return null;

  // Reading order. Positions from several readings of a tilted label are not reliable enough to
  // order words across rows, so the application's own word order is used, except when every word
  // sits on one row, where left-to-right position is trustworthy.
  const smallest = Math.min(...best.picked.map((h) => h.h));
  const ys = best.picked.map((h) => h.yc);
  const oneLine = new Set(best.picked.map((h) => h.line)).size === 1;
  const oneRow = oneLine && Math.max(...ys) - Math.min(...ys) <= smallest * 0.6;
  const ordered = oneRow
    ? [...best.picked].sort((a, b) => a.x - b.x)
    : [...best.picked].sort((a, b) => a.token - b.token);

  return {
    text: cleanText(ordered.map((h) => h.text).join(" ")),
    lines: [...new Set(ordered.map((h) => h.line))],
    score: best.score,
    height: Math.max(...ordered.map((h) => h.h)),
    conf: mean(ordered.map((h) => h.conf)),
  };
}

/** Share of a line's words that are class words or class modifiers. */
function classLikeShare(text: string): number {
  const words = normalizeClassText(text).split(/\s+/).filter(Boolean);
  if (!words.length) return 0;
  const hits = words.filter(
    (w) => CLASS_WORDS.includes(w) || CLASS_MODIFIERS.has(w)
  ).length;
  return hits / words.length;
}

/** A line that is only a class description ("Kentucky Straight Bourbon Whiskey"). */
const isClassLikeLine = (text: string) => classLikeShare(text) >= 0.7;

/** A piece of a class word that lost letters in reading ("iskey" from "whiskey"). */
function isClassFragment(text: string): boolean {
  const words = normalizeClassText(text).split(/\s+/).filter(Boolean);
  if (!words.length) return false;
  return words.every(
    (w) =>
      CLASS_WORDS.includes(w) ||
      CLASS_MODIFIERS.has(w) ||
      (w.length >= 3 &&
        (CLASS_WORDS.some((c) => c.length > w.length && c.includes(w)) ||
          [...CLASS_MODIFIERS].some(
            (c) => c.length > w.length && c.includes(w)
          )))
  );
}

function findClassWord(word: string): string | null {
  if (CLASS_WORDS.includes(word)) return word;

  // Avoid fuzzy matching very short words like "gin" and "rum".
  if (word.length < 5) return null;

  let bestWord: string | null = null;
  let bestScore = 0;

  for (const candidate of CLASS_WORDS) {
    const score = similarity(word, candidate);

    if (score > bestScore) {
      bestScore = score;
      bestWord = candidate;
    }
  }

  return bestScore >= 0.78 ? bestWord : null;
}

function extractClassPhrase(text: string): string {
  const words = text.trim().split(/\s+/);

  const normalizedWords = words.map((word) => normalizeClassText(word));

  const matches = normalizedWords.map(findClassWord);

  const categoryIndexes = matches
    .map((match, index) => (match ? index : -1))
    .filter((index) => index >= 0);

  if (categoryIndexes.length === 0) return "";

  const first = categoryIndexes[0];
  const last = categoryIndexes[categoryIndexes.length - 1];

  // Retain descriptors before the first recognized alcohol category.
  const start = Math.max(0, first - 3);

  // Stop at the last recognized category, not at trailing OCR noise.
  const result = words.slice(start, last + 1);

  // Correct category words when OCR made a close spelling error.
  for (let index = start; index <= last; index++) {
    const corrected = matches[index];

    if (corrected && normalizedWords[index] !== corrected) {
      const original = words[index];

      result[index - start] =
        original === original.toUpperCase()
          ? corrected.toUpperCase()
          : corrected[0].toUpperCase() + corrected.slice(1);
    }
  }

  return result.join(" ").trim();
}

function canMergeBrandLines(
  previous: OcrLine,
  current: OcrLine,
  referenceHeight: number
): boolean {
  const currentHeight = height(current);
  const previousHeight = height(previous);

  const similarSize =
    Math.abs(currentHeight - referenceHeight) <=
      referenceHeight * SIZE_TOLERANCE &&
    Math.abs(previousHeight - referenceHeight) <=
      referenceHeight * SIZE_TOLERANCE;

  const verticalGap = current.bbox.y0 - previous.bbox.y1;

  const closeTogether =
    verticalGap >= -referenceHeight * 0.5 &&
    verticalGap <= Math.max(referenceHeight * 0.75, 8);

  return similarSize && closeTogether;
}

function normalizeNumericOcr(text: string): string {
  return text
    .replace(/([0-9])[oO]/g, (_, digit: string) => digit + "0")
    .replace(/[oO](?=[0-9])/g, "0");
}

// ---------------------------------------------------------------------------
// Numbers: alcohol percentage, proof, volume.
// Small print is where OCR slips most, so every sighting is kept as evidence and the
// best-supported value wins (also across several readings of the same label).
// ---------------------------------------------------------------------------

const PCT_G =
  /(\d{1,2}(?:\.\d+)?)\s*%\s*(?:alc(?:ohol)?\.?\s*\/?\s*(?:by\s*)?vol\.?)?/gi;
/** "45 ALC" or "45 BY VOL": the percent sign was lost but the words after it say what it is. */
const PCT_WORDS_G =
  /\b(\d{2}(?:\.\d+)?)\s*(?:alc(?:ohol)?\b|abv\b|by\s*vol\b)/gi;
const PROOF_G = /(\d{2,3}(?:\.\d+)?)\s*proof\b/gi;
const VOLUME_G =
  /\b(\d+(?:\.\d+)?)\s*(?:milliliters?|millilitres?|ml|cl|liters?|litres?|l|fl\.?\s*oz\.?|oz)(?![A-Za-z])/gi;
/** "750m": the L was lost. Only trusted for common bottle sizes. */
const VOLUME_LOOSE_G = /\b(1750|1000|750|700|500|375|355|200|187|100)\s*m\b/gi;
/** "7500" for "750 mL": the unit was read as a zero. Weakest evidence. */
const VOLUME_ZERO_G = /\b(750|375)[0OoQ]\b/g;

export function collectEvidence(lines: OcrLine[]): Evidence {
  const ev: Evidence = { percents: [], proofs: [], volumes: [] };

  for (const line of lines) {
    const text = normalizeNumericOcr(line.text);
    const conf = line.confidence;
    const seenHere = new Set<number>();

    for (const m of text.matchAll(PCT_G)) {
      const value = parseFloat(m[1]);
      if (value < 0.5 || value > 95) continue;
      ev.percents.push({ value, text: m[0].trim(), conf });
      seenHere.add(value);
    }

    for (const m of text.matchAll(PCT_WORDS_G)) {
      const value = parseFloat(m[1]);
      if (value < 3 || value > 95 || seenHere.has(value)) continue;
      ev.percents.push({
        value,
        text: `${m[1]}% ${m[0].replace(/^[\d.\s]+/, "")}`.trim(),
        conf: conf * 0.85,
      });
    }

    for (const m of text.matchAll(PROOF_G)) {
      const value = parseFloat(m[1]);
      if (value < 20 || value > 200) continue;
      ev.proofs.push({ value, text: m[0].trim(), conf });
    }

    const mls = new Set<number>();
    for (const m of text.matchAll(VOLUME_G)) {
      const ml = parseVolumeMl(m[0]);
      if (ml === null || ml < 30 || ml > 5000) continue;
      ev.volumes.push({ value: Math.round(ml), text: m[0].trim(), conf });
      mls.add(Math.round(ml));
    }
    for (const m of text.matchAll(VOLUME_LOOSE_G)) {
      const ml = parseInt(m[1], 10);
      if (mls.has(ml)) continue;
      ev.volumes.push({ value: ml, text: `${ml} mL`, conf: conf * 0.8 });
      mls.add(ml);
    }
    for (const m of text.matchAll(VOLUME_ZERO_G)) {
      const ml = parseInt(m[1], 10);
      if (mls.has(ml)) continue;
      ev.volumes.push({ value: ml, text: `${ml} mL`, conf: conf * 0.5 });
      mls.add(ml);
    }
  }

  return ev;
}

function group<T extends { value: number; conf: number }>(items: T[]) {
  const map = new Map<number, { value: number; score: number; best: T }>();
  for (const item of items) {
    const g = map.get(item.value);
    if (g) {
      g.score += item.conf;
      if (item.conf > g.best.conf) g.best = item;
    } else {
      map.set(item.value, { value: item.value, score: item.conf, best: item });
    }
  }
  return [...map.values()];
}

/**
 * Choose the alcohol content from everything that was seen. A percentage whose double also
 * shows up as a proof (45% and 90 proof) is almost certainly right. A proof is only kept when it
 * agrees with the percentage, or when it was read confidently: a clearly different proof is a
 * real problem on the label, while a shaky one is more likely a misread digit.
 */
export function pickAbv(ev: Evidence): { text: string; conf: number } {
  const pcts = group(ev.percents);
  const proofs = group(ev.proofs);

  let bestPct: (typeof pcts)[number] | null = null;
  let bestScore = -1;
  for (const p of pcts) {
    const agrees = proofs.some((q) => Math.abs(q.value - 2 * p.value) < 0.01);
    // "45% ALC. BY VOL." is far more trustworthy than a bare "4%" fragment.
    const labelled = /alc|vol/i.test(p.best.text) ? 100 : 0;
    const score = p.score + (agrees ? 150 : 0) + labelled;
    if (score > bestScore) {
      bestScore = score;
      bestPct = p;
    }
  }

  if (!bestPct) {
    if (!proofs.length) return { text: "", conf: 0 };
    const only = [...proofs].sort((a, b) => b.score - a.score)[0];
    return { text: `${only.value} Proof`, conf: only.best.conf };
  }

  const chosen = bestPct;
  let proofText = "";
  const agreeing = proofs.find(
    (q) => Math.abs(q.value - 2 * chosen.value) < 0.01
  );
  const other = [...proofs].sort((a, b) => b.best.conf - a.best.conf)[0];
  if (agreeing) proofText = `${agreeing.value} Proof`;
  else if (other && other.best.conf >= 85) proofText = `${other.value} Proof`;

  const base = chosen.best.text.replace(/\s+/g, " ").trim();
  return {
    text: proofText ? `${base} (${proofText})` : base,
    conf: chosen.best.conf,
  };
}

/** Choose the net contents from everything that was seen, preferring common bottle sizes. */
export function pickVolume(ev: Evidence): { text: string; conf: number } {
  const volumes = group(ev.volumes);
  if (!volumes.length) return { text: "", conf: 0 };

  let best = volumes[0];
  let bestScore = -1;
  for (const v of volumes) {
    const score = v.score + (STANDARD_ML.includes(v.value) ? 25 : 0);
    if (score > bestScore) {
      bestScore = score;
      best = v;
    }
  }
  return { text: best.best.text, conf: best.best.conf };
}

export function extractFields(
  allLines: OcrLine[],
  hints: Hints = {},
  classRetryText?: string,
  classRetryConfidence = 0
): Extraction {
  const lines = allLines.filter((line) => line.text.trim().length > 0);
  const used = new Set<number>();

  const fields: LabelFields = {
    brand: "",
    classType: "",
    abv: "",
    netContents: "",
    origin: "",
    warning: "",
  };

  const confidence: Extraction["confidence"] = {};

  const warningWords: Extraction["warningWords"] = {
    header: [],
    body: [],
  };

  // 1. Government warning.

  const isAnotherField = (text: string) =>
    ABV_RE.test(text) ||
    PROOF_RE.test(text) ||
    VOLUME_RE.test(text) ||
    ORIGIN_PATTERNS.some(([re]) => re.test(text)) ||
    BOTTLER_RE.test(text) ||
    CLASS_RE.test(text);

  const warningIndex = lines.findIndex((line) => WARNING_RE.test(line.text));

  if (warningIndex >= 0) {
    const warningLines: number[] = [];
    const parts: string[] = [];

    for (let i = warningIndex; i < lines.length; i++) {
      const line = lines[i];
      const start = i === warningIndex ? line.text.search(WARNING_RE) : 0;

      if (i > warningIndex && isAnotherField(line.text)) break;

      if (i > warningIndex) {
        const previous = lines[i - 1];
        const verticalGap = line.bbox.y0 - previous.bbox.y1;

        if (verticalGap > Math.max(height(previous) * 2.5, 20)) {
          break;
        }
      }

      parts.push(line.text.slice(Math.max(0, start)));
      warningLines.push(i);
      used.add(i);

      if (WARNING_END_RE.test(parts.join(" "))) break;
    }

    const joined = parts.join(" ");
    const end = joined.match(WARNING_END_RE);

    fields.warning =
      end && end.index !== undefined
        ? joined.slice(0, end.index + end[0].length)
        : joined;
    confidence.warning = mean(warningLines.map((i) => lines[i].confidence));

    const first = lines[warningIndex].words;
    const headerIndex = first.findIndex((word) =>
      /^g[o0]vernment/i.test(word.text)
    );

    if (headerIndex >= 0) {
      warningWords.header = first.slice(headerIndex, headerIndex + 2);
      warningWords.body = first.slice(headerIndex + 2);
    }

    for (const index of warningLines) {
      if (index !== warningIndex) {
        warningWords.body.push(...lines[index].words);
      }
    }
  }

  const free = () =>
    lines.map((_, index) => index).filter((index) => !used.has(index));

  // 2-3. Alcohol content and net contents, from everything that is not the warning.

  const evidence = collectEvidence(free().map((i) => lines[i]));

  const abv = pickAbv(evidence);
  fields.abv = abv.text;
  if (abv.text) confidence.abv = abv.conf;

  const volume = pickVolume(evidence);
  fields.netContents = volume.text;
  if (volume.text) confidence.netContents = volume.conf;

  // 4. Country of origin.

  for (const index of free()) {
    const hit = ORIGIN_PATTERNS.map(([re, group]) => {
      const match = lines[index].text.match(re);
      return match ? match[group].trim() : null;
    }).find(Boolean);

    if (hit) {
      fields.origin = hit;
      confidence.origin = lines[index].confidence;
      used.add(index);
      break;
    }
  }

  /** Lines that may hold the brand or class text. A hint is enough to look at weak lines too. */
  const textLines = () =>
    free().filter(
      (index) =>
        !BOTTLER_RE.test(lines[index].text) && letters(lines[index].text) >= 2
    );

  // 5. Class/type.

  const classLineIndexes = new Set<number>();

  if (hints.classType) {
    const hit =
      locateByWords(lines, new Set(textLines()), hints.classType) ??
      locate(lines, new Set(textLines()), hints.classType);

    if (hit) {
      const trimmed = extractClassPhrase(hit.text);
      const candidate =
        trimmed &&
        similarity(trimmed, hints.classType) >
          similarity(hit.text, hints.classType)
          ? trimmed
          : hit.text;

      fields.classType = repairClassPhrase(candidate, hints.classType);

      confidence.classType = hit.conf;
      hit.lines.forEach((i) => classLineIndexes.add(i));
    }
  }

  if (!fields.classType) {
    const classCandidates: Array<{
      text: string;
      lines: number[];
      score: number;
    }> = [];

    // Examine original OCR one line at a time.
    for (let i = 0; i < lines.length; i++) {
      if (used.has(i)) continue;

      const phrase = extractClassPhrase(lines[i].text);

      if (phrase) {
        classCandidates.push({
          text: phrase,
          lines: [i],
          score: lines[i].confidence,
        });
      }
    }

    // A focused retry of the class area is a separate candidate; take only its class phrase.
    if (classRetryText?.trim()) {
      const phrase = extractClassPhrase(classRetryText);

      if (phrase)
        classCandidates.push({
          text: phrase,
          lines: [],
          score: classRetryConfidence,
        });
    }

    classCandidates.sort((a, b) => b.score - a.score);
    const best = classCandidates[0];

    if (best) {
      fields.classType = best.text;
      confidence.classType = best.score;
      best.lines.forEach((i) => classLineIndexes.add(i));
    }

    debug("CLASS TYPE DEBUG:", {
      candidates: classCandidates,
      selected: fields.classType,
    });
  }

  for (const index of classLineIndexes) {
    if (isClassLikeLine(lines[index].text)) used.add(index);
  }

  // 6. Brand name.

  // 6. Brand name.

  const brandLines = new Set<number>();

  const eligibleBrandLines = () =>
    textLines().filter(
      (index) =>
        lines[index].confidence >= 40 &&
        letters(lines[index].text) >= 3 &&
        !isClassLikeLine(lines[index].text) &&
        !ABV_RE.test(lines[index].text) &&
        !PROOF_RE.test(lines[index].text) &&
        !VOLUME_RE.test(lines[index].text)
    );

  const candidates = eligibleBrandLines();

  if (hints.brand?.trim()) {
    // Prefer OCR text matching the supplied brand hint.
    const hintHit =
      locateByWords(lines, new Set(candidates), hints.brand, true) ??
      locate(lines, new Set(candidates), hints.brand);

    debug("BRAND HINT CHECK:", {
      hint: hints.brand,
      matchedText: hintHit?.text ?? null,
      score: hintHit?.score ?? null,
    });

    if (hintHit) {
      fields.brand = hintHit.text;
      confidence.brand = hintHit.conf;
      hintHit.lines.forEach((index) => brandLines.add(index));
    }
  }
  // No hint, or the application's brand is nowhere on the label: report what the label shows, so a
  // real mismatch is reported as a mismatch. With a hint, only clean, confidently read text is
  // used; stray characters are never offered as the brand.
  const fallbackPool = hints.brand?.trim()
    ? candidates.filter(
        (index) =>
          lines[index].confidence >= 60 &&
          looksLikeWords(lines[index].text) &&
          !isClassFragment(lines[index].text)
      )
    : candidates.filter((index) => !isClassFragment(lines[index].text));
  if (!fields.brand && fallbackPool.length) {
    // No hint supplied: use the existing visual-size fallback.
    let best = fallbackPool[0];

    for (const index of fallbackPool) {
      const current = lines[index];
      const selected = lines[best];

      if (
        height(current) > height(selected) ||
        (height(current) === height(selected) &&
          current.confidence > selected.confidence)
      ) {
        best = index;
      }
    }

    const referenceHeight = height(lines[best]);

    let lo = best;
    let hi = best;

    while (
      lo > 0 &&
      fallbackPool.includes(lo - 1) &&
      canMergeBrandLines(lines[lo - 1], lines[lo], referenceHeight)
    ) {
      lo--;
    }

    while (
      hi < lines.length - 1 &&
      fallbackPool.includes(hi + 1) &&
      canMergeBrandLines(lines[hi], lines[hi + 1], referenceHeight)
    ) {
      hi++;
    }

    fields.brand = cleanText(
      lines
        .slice(lo, hi + 1)
        .map((line) => line.text)
        .join(" ")
    );

    confidence.brand = mean(
      lines.slice(lo, hi + 1).map((line) => line.confidence)
    );

    for (let index = lo; index <= hi; index++) {
      if (fallbackPool.includes(index)) {
        brandLines.add(index);
      }
    }
  }

  debug("BRAND DEBUG:", {
    hint: hints.brand,
    candidates: candidates.map((index) => ({
      text: lines[index].text,
      confidence: lines[index].confidence,
      height: height(lines[index]),
      lineIndex: index,
    })),
    selected: fields.brand,
  });

  brandLines.forEach((index) => used.add(index));

  return { fields, warningWords, evidence, confidence };
}

function repairClassPhrase(text: string, hint?: string): string {
  const cleaned = cleanText(text);
  if (!cleaned || !hint) return cleaned;

  const actualWords = cleaned.split(/\s+/);
  const hintWords = hint.trim().split(/\s+/);

  // Only repair a missing first character. Do not replace or reorder words.
  if (actualWords.length !== hintWords.length) return cleaned;

  const repaired = [...actualWords];
  let changed = false;

  for (let i = 0; i < actualWords.length; i++) {
    const actual = stripToAlnum(actualWords[i]).toLowerCase();
    const expected = stripToAlnum(hintWords[i]).toLowerCase();

    if (!actual || !expected || actual === expected) continue;

    // Example: ENTUCKY -> KENTUCKY
    // Require the OCR word to match every character after the first.
    if (expected.length === actual.length + 1 && expected.endsWith(actual)) {
      const original = actualWords[i];
      const first = expected[0];

      repaired[i] =
        original === original.toUpperCase()
          ? first.toUpperCase() + original
          : first.toUpperCase() + original;

      changed = true;
    }
  }

  return changed ? repaired.join(" ") : cleaned;
}
