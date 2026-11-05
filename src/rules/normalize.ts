/** Collapse any run of whitespace (including newlines) into one space. */
export const collapse = (s: string): string => s.replace(/\s+/g, ' ').trim();

/** Lower-case and drop everything except letters and digits. */
export const stripToAlnum = (s: string): string =>
  s.toLowerCase().replace(/[^a-z0-9]/g, '');

export type TextMatch = 'exact' | 'loose' | 'different';

/**
 * exact     – identical (ignoring extra whitespace)
 * loose     – same letters/digits, differs only in capitalization or punctuation
 * different – a real difference
 */
export function compareText(app: string, label: string): TextMatch {
  const a = collapse(app);
  const b = collapse(label);
  if (a === b) return 'exact';
  if (stripToAlnum(a) === stripToAlnum(b)) return 'loose';
  return 'different';
}

/** Number of single-character edits needed to turn a into b. */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(
        prev[j] + 1,
        cur[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = cur;
  }
  return prev[b.length];
}

/** 0..1 closeness of two strings, ignoring case and punctuation. 1 means identical. */
export function similarity(a: string, b: string): number {
  const x = stripToAlnum(a);
  const y = stripToAlnum(b);
  if (!x && !y) return 1;
  return 1 - levenshtein(x, y) / Math.max(x.length, y.length);
}

const VOLUME_SRC =
  '(\\d+(?:\\.\\d+)?)\\s*(milliliters?|millilitres?|ml|centiliters?|centilitres?|cl|liters?|litres?|l|fluid\\s+ounces?|fl\\.?\\s*oz\\.?|oz)(?![a-z])';

function unitToMl(unit: string): number {
  if (unit.startsWith('milli') || unit === 'ml') return 1;
  if (unit.startsWith('centi') || unit === 'cl') return 10;
  if (unit.startsWith('lit') || unit === 'l') return 1000;
  return 29.5735; // fluid ounces
}

/** Find a volume such as "750 mL" inside a longer piece of text. */
export function findVolume(text: string): string | null {
  const m = text.match(new RegExp(VOLUME_SRC, 'i'));
  return m ? m[0].trim() : null;
}

/** Parse "750 mL", "0.75 L", "75cl", "25.4 fl oz" into millilitres. */
export function parseVolumeMl(text: string): number | null {
  const m = text.toLowerCase().replace(/,/g, '').match(new RegExp(VOLUME_SRC));
  if (!m) return null;
  return parseFloat(m[1]) * unitToMl(m[2]);
}
