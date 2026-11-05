import type { BoldResult } from '../rules/types';
import type { Box, OcrWord } from './types';

/** Header strokes must be at least this many times thicker than body strokes to count as bold. */
export const BOLD_RATIO = 1.2;
/** Below this stroke width, in pixels, the image is too small to tell regular from bold. */
const MIN_MEASURABLE_STEM = 1.8;

const median = (values: number[]): number => {
  if (!values.length) return NaN;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

/**
 * Typical thickness, in pixels, of the vertical strokes of the letters inside `box`.
 * Scans each pixel row, measures every dark run, and takes the median; runs that are
 * longer than the text is tall are horizontal bars (the top of a T or E) and are ignored.
 */
export function stemWidths(grey: Uint8ClampedArray, imageWidth: number, box: Box): number[] {
  const x0 = Math.max(0, Math.floor(box.x0));
  const x1 = Math.min(imageWidth, Math.ceil(box.x1));
  const y0 = Math.max(0, Math.floor(box.y0));
  const y1 = Math.ceil(box.y1);
  const boxH = y1 - y0;
  if (x1 - x0 < 3 || boxH < 4) return [];

  let lo = 255;
  let hi = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const v = grey[(y * imageWidth + x) * 4];
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
  }
  if (hi - lo < 40) return [];
  const threshold = (lo + hi) / 2;

  const runs: number[] = [];
  for (let y = y0; y < y1; y++) {
    let run = 0;
    for (let x = x0; x <= x1; x++) {
      const dark = x < x1 && grey[(y * imageWidth + x) * 4] < threshold;
      if (dark) {
        run++;
      } else if (run) {
        if (run <= boxH * 0.6) runs.push(run);
        run = 0;
      }
    }
  }
  return runs;
}

/** Stroke thickness relative to letter height, so bigger print is not mistaken for bolder print. */
function relativeStem(grey: Uint8ClampedArray, imageWidth: number, words: OcrWord[]): { stem: number; px: number } | null {
  const runs: number[] = [];
  const heights: number[] = [];
  for (const w of words) {
    runs.push(...stemWidths(grey, imageWidth, w.bbox));
    heights.push(w.bbox.y1 - w.bbox.y0);
  }
  if (!runs.length) return null;
  const px = median(runs);
  return { stem: px / median(heights), px };
}

/**
 * Estimate whether the warning header is bold by comparing the thickness of its letter
 * strokes with the strokes of the sentence after it. This is an approximation, not a
 * font reader: it is reliable for clear images and unreliable for tiny or blurry ones.
 */
export function estimateBold(
  canvas: HTMLCanvasElement,
  header: OcrWord[],
  body: OcrWord[],
): BoldResult {
  const usable = (ws: OcrWord[]) =>
    ws.filter((w) => w.confidence >= 60 && w.text.replace(/[^A-Za-z]/g, '').length >= 3);
  const h = usable(header);
  const b = usable(body);
  if (!h.length || b.length < 3) return { verdict: 'unknown', ratio: null };

  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return { verdict: 'unknown', ratio: null };
  const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
  return compareStems(data, canvas.width, h, b);
}

/** Pure part of estimateBold, separated so it can be tested without a browser. */
export function compareStems(
  grey: Uint8ClampedArray,
  imageWidth: number,
  header: OcrWord[],
  body: OcrWord[],
): BoldResult {
  const hs = relativeStem(grey, imageWidth, header);
  const bs = relativeStem(grey, imageWidth, body);
  if (!hs || !bs || hs.px < MIN_MEASURABLE_STEM || bs.px < MIN_MEASURABLE_STEM) {
    return { verdict: 'unknown', ratio: null };
  }
  const ratio = hs.stem / bs.stem;
  return { verdict: ratio >= BOLD_RATIO ? 'bold' : 'not-bold', ratio: Math.round(ratio * 100) / 100 };
}
