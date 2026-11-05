import type { OcrLine } from './types';

/** Tilts smaller than this are left alone; the engine copes with them. */
export const MIN_TILT_DEG = 1;
/** Tilts larger than this are probably not a straight label at all. */
export const MAX_TILT_DEG = 25;
const MIN_BASELINE_PX = 100;

/**
 * Estimate how many degrees clockwise the text lines are tilted, from the baselines the OCR
 * engine reports (the median of the long ones). The result is between -90 and 90:
 * about 0 for upright text, negative if the text climbs to the right, and near +/-90 if
 * the lines run up or down the picture (a sideways photo). Returns 0 when there is
 * not enough to go on.
 */
export function estimateTilt(lines: OcrLine[]): number {
  const angles: number[] = [];
  for (const l of lines) {
    const b = l.baseline;
    if (!b) continue;
    let dx = b.x1 - b.x0;
    let dy = b.y1 - b.y0;
    if (Math.hypot(dx, dy) < MIN_BASELINE_PX) continue;
    // A line has no direction: flip so that it always points to the right (or straight down).
    if (dx < 0 || (dx === 0 && dy < 0)) {
      dx = -dx;
      dy = -dy;
    }
    angles.push((Math.atan2(dy, dx) * 180) / Math.PI);
  }
  if (angles.length < 3) return 0;
  angles.sort((a, b) => a - b);
  const mid = angles.length >> 1;
  return angles.length % 2 ? angles[mid] : (angles[mid - 1] + angles[mid]) / 2;
}

/** True if a tilt is big enough to be worth straightening, and small enough to be believable. */
export const worthStraightening = (tilt: number): boolean =>
  Math.abs(tilt) >= MIN_TILT_DEG && Math.abs(tilt) <= MAX_TILT_DEG;
