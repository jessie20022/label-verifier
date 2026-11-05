import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { verifyLabel } from '../rules/verify';
import { parseBatchCsv } from './parseCsv';
import { parseLabelText } from './parseLabelText';

describe('bundled sample files', () => {
  it('sample-batch.csv produces the documented outcomes', () => {
    const csv = readFileSync('public/samples/sample-batch-text.csv', 'utf8');
    const parsed = parseBatchCsv(csv);
    expect(parsed.errors).toEqual([]);
    const overall = parsed.rows.map((r) => verifyLabel(r.app, r.label).overall);
    expect(overall).toEqual([
      'pass', // 1 exact match
      'review', // 2 Stone's Throw vs STONE'S THROW
      'fail', // 3 title-case warning header
      'fail', // 4 ABV 43 vs 46
      'fail', // 5 import with no origin on label (0.75 L volume itself is fine)
      'fail', // 6 altered warning wording
      'pass', // 7 "Product of Scotland" accepted for Scotland
      'fail', // 8 warning missing
    ]);
  });

  it('sample-label.txt passes against the example application', () => {
    const label = parseLabelText(readFileSync('public/samples/sample-label.txt', 'utf8'));
    const result = verifyLabel(
      {
        brand: 'OLD TOM DISTILLERY',
        classType: 'Kentucky Straight Bourbon Whiskey',
        abv: '45',
        netContents: '750 mL',
        origin: '',
      },
      label,
    );
    expect(result.overall).toBe('pass');
  });
});
