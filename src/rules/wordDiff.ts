import { levenshtein } from './normalize';

export interface WordEdit {
  kind: 'changed' | 'missing' | 'extra';
  expected?: string;
  actual?: string;
  /** 1-based word position in the expected text. */
  position: number;
  /** A changed word that is only a character or two off, the way an OCR misread looks. */
  ocrLike: boolean;
}

const isOcrLike = (a: string, b: string): boolean =>
  Math.max(a.length, b.length) >= 3 && levenshtein(a, b) <= 2;

/** Word-by-word alignment of the actual text against the expected text. */
export function diffWords(expected: string[], actual: string[]): WordEdit[] {
  const n = expected.length;
  const m = actual.length;
  const cost: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = 1; i <= n; i++) cost[i][0] = i;
  for (let j = 1; j <= m; j++) cost[0][j] = j;

  const subCost = (a: string, b: string) => (a === b ? 0 : isOcrLike(a, b) ? 1 : 1.5);

  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      cost[i][j] = Math.min(
        cost[i - 1][j] + 1,
        cost[i][j - 1] + 1,
        cost[i - 1][j - 1] + subCost(expected[i - 1], actual[j - 1]),
      );
    }
  }

  const edits: WordEdit[] = [];
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && cost[i][j] === cost[i - 1][j - 1] + subCost(expected[i - 1], actual[j - 1])) {
      if (expected[i - 1] !== actual[j - 1]) {
        edits.push({
          kind: 'changed',
          expected: expected[i - 1],
          actual: actual[j - 1],
          position: i,
          ocrLike: isOcrLike(expected[i - 1], actual[j - 1]),
        });
      }
      i--;
      j--;
    } else if (i > 0 && cost[i][j] === cost[i - 1][j] + 1) {
      edits.push({ kind: 'missing', expected: expected[i - 1], position: i, ocrLike: false });
      i--;
    } else {
      edits.push({ kind: 'extra', actual: actual[j - 1], position: i, ocrLike: false });
      j--;
    }
  }
  return edits.reverse();
}

export function describeEdit(e: WordEdit): string {
  if (e.kind === 'changed') return `"${e.actual}" instead of "${e.expected}" (word ${e.position})`;
  if (e.kind === 'missing') return `missing "${e.expected}" (word ${e.position})`;
  return `extra word "${e.actual}" after word ${e.position}`;
}
