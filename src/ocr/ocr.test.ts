import { describe, expect, it } from 'vitest';
import { WARNING, checkBrand, checkWarning } from '../rules/checks';
import { verifyLabel } from '../rules/verify';
import { compareStems } from './boldCheck';
import { estimateTilt, worthStraightening } from './deskew';
import { extractFields } from './extractFields';
import { flattenBackground, greyscaleAndStretch, targetScale } from './preprocess';
import type { OcrLine, OcrWord } from './types';

/** Build an OCR line the way the engine reports it: text, position, size. */
function line(text: string, y: number, h = 40, x0 = 100, conf = 95): OcrLine {
  const words: OcrWord[] = text.split(' ').map((t, i) => ({
    text: t,
    confidence: conf,
    bbox: { x0: x0 + i * 100, y0: y, x1: x0 + i * 100 + 90, y1: y + h },
  }));
  return {
    text,
    confidence: conf,
    bbox: { x0, y0: y, x1: x0 + text.length * 20, y1: y + h },
    words,
    baseline: { x0, y0: y + h, x1: x0 + 400, y1: y + h },
  };
}

const labelLines = (over: Partial<Record<string, string>> = {}): OcrLine[] => [
  line(over.brand ?? 'OLD TOM DISTILLERY', 100, 130),
  line(over.cls ?? 'Kentucky Straight Bourbon Whiskey', 280, 60),
  line(over.abv ?? '45% Alc./Vol. (90 Proof)', 400, 50),
  line(over.net ?? '750 mL', 470, 50),
  line('Distilled and bottled by Old Tom Distillery, Bardstown, Kentucky', 560, 30),
  line(over.w1 ?? 'GOVERNMENT WARNING: (1) According to the Surgeon General, women should', 1200, 30),
  line('not drink alcoholic beverages during pregnancy because of the risk of birth defects.', 1250, 30),
  line('(2) Consumption of alcoholic beverages impairs your ability to drive a car or operate', 1300, 30),
  line('machinery, and may cause health problems.', 1350, 30),
];

describe('extractFields', () => {
  it('sorts OCR lines into the right fields', () => {
    const { fields } = extractFields(labelLines());
    expect(fields.brand).toBe('OLD TOM DISTILLERY');
    expect(fields.classType).toBe('Kentucky Straight Bourbon Whiskey');
    expect(fields.abv).toBe('45% Alc./Vol. (90 Proof)');
    expect(fields.netContents).toBe('750 mL');
    expect(fields.warning).toBe(WARNING);
  });

  it('does not mistake the bottler line for the brand', () => {
    expect(extractFields(labelLines()).fields.brand).toBe('OLD TOM DISTILLERY');
  });

  it('keeps the label capitalization when the application brand is used as a hint', () => {
    const { fields } = extractFields(labelLines({ brand: "STONE'S THROW" }), { brand: "Stone's Throw" });
    expect(fields.brand).toBe("STONE'S THROW");
  });

  it('does not let a hint hide a real mismatch', () => {
    const { fields } = extractFields(labelLines({ brand: 'YOUNG HARRY' }), { brand: 'OLD TOM DISTILLERY' });
    expect(fields.brand).toBe('YOUNG HARRY');
  });

  it('finds the origin statement', () => {
    const lines = [...labelLines(), line('Product of Scotland', 520, 40)];
    expect(extractFields(lines).fields.origin).toBe('Product of Scotland');
  });

  it('keeps a title-case warning header as printed so it can be rejected', () => {
    const { fields } = extractFields(labelLines({ w1: 'Government Warning: (1) According to the Surgeon General, women should' }));
    expect(fields.warning.startsWith('Government Warning:')).toBe(true);
  });

  it('returns an empty warning when none is printed', () => {
    const noWarning = labelLines().slice(0, 5);
    expect(extractFields(noWarning).fields.warning).toBe('');
  });

  it('reports the warning header words for the bold check', () => {
    const { warningWords } = extractFields(labelLines());
    expect(warningWords.header.map((w) => w.text)).toEqual(['GOVERNMENT', 'WARNING:']);
    expect(warningWords.body.length).toBeGreaterThan(5);
  });
});

describe('verifying an image reading end to end (no OCR engine needed)', () => {
  const app = {
    brand: 'OLD TOM DISTILLERY',
    classType: 'Kentucky Straight Bourbon Whiskey',
    abv: '45',
    netContents: '750 mL',
    origin: '',
  };

  it('passes a clean reading', () => {
    const { fields } = extractFields(labelLines(), { brand: app.brand, classType: app.classType });
    expect(verifyLabel(app, fields, { ocr: true, bold: { verdict: 'bold', ratio: 1.8 } }).overall).toBe('pass');
  });

  it('asks for review when the warning header does not look bold', () => {
    const { fields } = extractFields(labelLines());
    const r = verifyLabel(app, fields, { ocr: true, bold: { verdict: 'not-bold', ratio: 1.1 } });
    expect(r.overall).toBe('review');
    expect(r.checks[r.checks.length - 1].field).toBe('Warning header bold');
  });

  it('fails a different alcohol percentage', () => {
    const { fields } = extractFields(labelLines({ abv: '46% Alc./Vol. (92 Proof)' }));
    expect(verifyLabel(app, fields, { ocr: true }).overall).toBe('fail');
  });
});

describe('OCR-tolerant matching', () => {
  it('flags a one-letter misread of the brand for review instead of failing it', () => {
    expect(checkBrand('OLD TOM DISTILLERY', 'OLD T0M DISTILLERY', { ocr: true }).status).toBe('review');
    expect(checkBrand('OLD TOM DISTILLERY', 'OLD T0M DISTILLERY').status).toBe('fail');
  });

  it('flags a single misread warning word for review, but only for images', () => {
    const misread = WARNING.replace('Surgeon', 'Surgoon');
    expect(checkWarning(misread, { ocr: true }).status).toBe('review');
    expect(checkWarning(misread).status).toBe('fail');
  });

  it('still fails an inserted or substituted real word in an image', () => {
    expect(checkWarning(WARNING.replace('impairs', 'may impair'), { ocr: true }).status).toBe('fail');
    expect(checkWarning(WARNING.replace('Surgeon General', 'Doctor'), { ocr: true }).status).toBe('fail');
  });

  it('accepts a misread colon in the header for images', () => {
    expect(checkWarning(WARNING.replace('WARNING:', 'WARNING;'), { ocr: true }).status).toBe('pass');
  });
});

describe('estimateTilt', () => {
  const withBaseline = (x0: number, y0: number, x1: number, y1: number): OcrLine => ({
    ...line('x', 0),
    baseline: { x0, y0, x1, y1 },
  });

  it('is about zero for level text', () => {
    expect(estimateTilt(labelLines())).toBeCloseTo(0, 5);
  });

  it('reports clockwise tilt as positive and climbing text as negative', () => {
    const down = Array.from({ length: 4 }, () => withBaseline(0, 0, 400, 35));
    const up = Array.from({ length: 4 }, () => withBaseline(0, 35, 400, 0));
    expect(estimateTilt(down)).toBeGreaterThan(4);
    expect(estimateTilt(up)).toBeLessThan(-4);
  });

  it('sees vertical lines as sideways whichever way they run', () => {
    const top = Array.from({ length: 4 }, () => withBaseline(10, 0, 10, 400));
    const bottom = Array.from({ length: 4 }, () => withBaseline(10, 400, 10, 0));
    expect(Math.abs(estimateTilt(top))).toBeCloseTo(90, 1);
    expect(Math.abs(estimateTilt(bottom))).toBeCloseTo(90, 1);
  });

  it('gives up (0) with too few long lines', () => {
    expect(estimateTilt([withBaseline(0, 0, 400, 35)])).toBe(0);
  });

  it('only straightens tilts that are measurable and believable', () => {
    expect(worthStraightening(0.4)).toBe(false);
    expect(worthStraightening(4)).toBe(true);
    expect(worthStraightening(-12)).toBe(true);
    expect(worthStraightening(60)).toBe(false);
  });
});

describe('compareStems (bold estimate)', () => {
  /** A grey image with vertical black bars of the given width inside each word box. */
  function bars(barWidth: number, boxes: Array<[number, number]>): { data: Uint8ClampedArray; width: number } {
    const width = 400;
    const height = 60;
    const data = new Uint8ClampedArray(width * height * 4).fill(255);
    for (const [x0] of boxes) {
      for (let x = x0; x < x0 + 80; x += 12) {
        for (let b = 0; b < barWidth; b++) {
          for (let y = 10; y < 50; y++) {
            const i = (y * width + x + b) * 4;
            data[i] = data[i + 1] = data[i + 2] = 0;
          }
        }
      }
    }
    return { data, width };
  }
  const word = (x0: number): OcrWord => ({ text: 'WARNING', confidence: 95, bbox: { x0, y0: 10, x1: x0 + 90, y1: 50 } });

  it('calls thicker header strokes bold', () => {
    const thick = bars(6, [[0, 0]]);
    const thin = bars(3, [[200, 0]]);
    const merged = thick.data.map((v, i) => Math.min(v, thin.data[i]));
    const r = compareStems(new Uint8ClampedArray(merged), 400, [word(0)], [word(200), word(200), word(200)]);
    expect(r.verdict).toBe('bold');
    expect(r.ratio).toBeGreaterThan(1.5);
  });

  it('calls equal strokes not bold', () => {
    const a = bars(4, [[0, 0], [200, 0]]);
    const r = compareStems(a.data, 400, [word(0)], [word(200), word(200), word(200)]);
    expect(r.verdict).toBe('not-bold');
  });

  it('will not guess when the print is too fine to measure', () => {
    const a = bars(1, [[0, 0], [200, 0]]);
    expect(compareStems(a.data, 400, [word(0)], [word(200), word(200), word(200)]).verdict).toBe('unknown');
  });
});

describe('image preparation', () => {
  it('shrinks large photos and enlarges tiny ones', () => {
    expect(targetScale(4000, 3000)).toBeCloseTo(0.45, 2);
    expect(targetScale(600, 400)).toBeCloseTo(2, 5);
    expect(targetScale(1400, 1800)).toBe(1);
  });

  it('stretches a washed-out image to the full dark-to-light range', () => {
    const px = new Uint8ClampedArray(4 * 100);
    for (let i = 0; i < 100; i++) {
      const v = i < 10 ? 120 : 180; // only two close grey levels
      px.set([v, v, v, 255], i * 4);
    }
    greyscaleAndStretch(px);
    expect(Math.min(...Array.from({ length: 100 }, (_, i) => px[i * 4]))).toBeLessThan(10);
    expect(Math.max(...Array.from({ length: 100 }, (_, i) => px[i * 4]))).toBeGreaterThan(245);
  });

  it('greatly reduces a lighting gradient (here a harsh one: 90 to 250 across 256 px)', () => {
    const w = 256;
    const h = 128;
    const px = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const v = 90 + Math.round((x / w) * 160); // 90 on the left, 250 on the right
        px.set([v, v, v, 255], (y * w + x) * 4);
      }
    }
    flattenBackground(px, w, h);
    const left = px[(64 * w + 20) * 4];
    const right = px[(64 * w + 230) * 4];
    // Before flattening the two spots differ by about 130 grey levels.
    expect(Math.abs(left - right)).toBeLessThan(50);
  });
});
