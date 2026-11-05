import { OEM, PSM, createWorker } from "tesseract.js";
import { greyscaleAndStretch, targetScale, type Rotation } from "./preprocess";
import type { Box, OcrLine, OcrPage } from "./types";

/**
 * "Focused" reading: take the area of the picture that holds the label text and read it again
 * at the picture's own resolution, straight from the original photo (not from the shrunken copy
 * used for the first pass), once per colour variant. Tiny print such as "45% ALC. BY VOL." and
 * "750 mL" is only readable at that size, and on coloured labels the red channel often shows the
 * letters far more clearly than plain brightness does.
 */

export type Channel = "lum" | "red" | "max";

export interface Region {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Longest side, in pixels, that the whole picture would have in a focused reading. */
const FOCUS_LONGEST_SIDE = 3200;
/** Small pictures are enlarged by this much for the focused reading. */
const SMALL_PICTURE_BOOST = 2;
/** Beyond the photo's own pixels, enlarging a little more helps the engine with tiny print. */
const EXTRA_ENLARGE = 1.7;
/** Largest crop, in pixels per side, handed to the engine. */
const MAX_CROP_SIDE = 3600;

const BASE = `${import.meta.env.BASE_URL}tesseract`;

type Worker = Awaited<ReturnType<typeof createWorker>>;
const workers = new Map<number, Promise<Worker>>();

/** A reader dedicated to one page-segmentation mode (11 = sparse text, 6 = one block). */
function workerFor(psm: number): Promise<Worker> {
  let existing = workers.get(psm);
  if (!existing) {
    existing = (async () => {
      const worker = await createWorker("eng", OEM.LSTM_ONLY, {
        workerPath: `${BASE}/worker.min.js`,
        corePath: BASE,
        langPath: BASE,
        gzip: true,
        workerBlobURL: false,
      });
      await worker.setParameters({
        tessedit_pageseg_mode: String(psm) as PSM,
        preserve_interword_spaces: "1",
        user_defined_dpi: "300",
      });
      return worker;
    })();
    existing.catch(() => workers.delete(psm));
    workers.set(psm, existing);
  }
  return existing;
}

export async function shutdownFocus(): Promise<void> {
  const all = [...workers.values()];
  workers.clear();
  await Promise.all(
    all.map((p) => p.then((w) => w.terminate()).catch(() => undefined))
  );
}

/** The area that holds the label text, from the lines the first pass could read reliably. */
export function findLabelRegion(
  lines: OcrLine[],
  canvasWidth: number,
  canvasHeight: number
): Region {
  const solid = lines.filter(
    (l) =>
      l.confidence >= 45 &&
      (l.text.match(/[A-Za-z0-9]/g) ?? []).length >= 3 &&
      l.bbox.x1 - l.bbox.x0 > 10
  );

  if (solid.length < 2)
    return { x: 0, y: 0, width: canvasWidth, height: canvasHeight };

  const box: Box = {
    x0: Math.min(...solid.map((l) => l.bbox.x0)),
    y0: Math.min(...solid.map((l) => l.bbox.y0)),
    x1: Math.max(...solid.map((l) => l.bbox.x1)),
    y1: Math.max(...solid.map((l) => l.bbox.y1)),
  };

  // Pad generously: the first pass usually misses the small print around the big lettering.
  // Alcohol content and volume sit in small print around the big lettering, often below it.
  const padX = (box.x1 - box.x0) * 0.3 + 30;
  const padTop = (box.y1 - box.y0) * 0.3 + 30;
  const padBottom = (box.y1 - box.y0) * 0.9 + 60;
  const x = Math.max(0, box.x0 - padX);
  const y = Math.max(0, box.y0 - padTop);
  const width = Math.min(canvasWidth, box.x1 + padX) - x;
  const height = Math.min(canvasHeight, box.y1 + padBottom) - y;

  // A sliver is not a label; fall back to the whole picture.
  if (width < canvasWidth * 0.2 || height < canvasHeight * 0.2) {
    return { x: 0, y: 0, width: canvasWidth, height: canvasHeight };
  }
  return { x, y, width, height };
}

export interface FocusGeometry {
  bitmap: ImageBitmap;
  rotation: Rotation;
  /** The tilt that was given to renderForOcr for the first-pass canvas. */
  tilt: number;
  /** Size of the first-pass canvas the region is expressed in. */
  canvasWidth: number;
  canvasHeight: number;
}

/** How many times larger than the first-pass canvas a focused reading is drawn. */
export function focusScale(geometry: FocusGeometry, region: Region): number {
  const base = targetScale(geometry.bitmap.width, geometry.bitmap.height);
  const longest = Math.max(geometry.bitmap.width, geometry.bitmap.height);
  let target = Math.min(1, FOCUS_LONGEST_SIDE / longest);
  if (longest * target < 1800) target = Math.min(SMALL_PICTURE_BOOST * base, 3);
  let k = Math.max(1, (target / base) * EXTRA_ENLARGE);
  const biggest = Math.max(region.width, region.height) * k;
  if (biggest > MAX_CROP_SIDE)
    k = MAX_CROP_SIDE / Math.max(region.width, region.height);
  return Math.max(1, k);
}

/** Draw `region` of the first-pass canvas again, straight from the original photo, enlarged by k. */
export function renderRegion(
  geometry: FocusGeometry,
  region: Region,
  k: number,
  channel: Channel
): HTMLCanvasElement {
  const { bitmap, rotation, tilt, canvasWidth, canvasHeight } = geometry;
  const base = targetScale(bitmap.width, bitmap.height);
  const w = Math.round(bitmap.width * base);
  const h = Math.round(bitmap.height * base);
  const angle = ((rotation + tilt) * Math.PI) / 180;

  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(region.width * k));
  canvas.height = Math.max(1, Math.round(region.height * k));
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("This browser could not prepare the image.");

  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.scale(k, k);
  ctx.translate(-region.x, -region.y);
  ctx.translate(canvasWidth / 2, canvasHeight / 2);
  ctx.rotate(angle);
  ctx.drawImage(bitmap, -w / 2, -h / 2, w, h);
  ctx.setTransform(1, 0, 0, 1, 0, 0);

  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const d = img.data;
  if (channel !== "lum") {
    for (let i = 0; i < d.length; i += 4) {
      const v = channel === "red" ? d[i] : Math.max(d[i], d[i + 1], d[i + 2]);
      d[i] = d[i + 1] = d[i + 2] = v;
    }
  }
  greyscaleAndStretch(d);
  ctx.putImageData(img, 0, 0);
  return canvas;
}

interface RawBlock {
  paragraphs?: Array<{
    lines?: Array<{
      text: string;
      confidence: number;
      bbox: Box;
      words?: OcrLine["words"];
    }>;
  }>;
}

/** Read a prepared canvas with a given page-segmentation mode. */
export async function recognizeWith(
  canvas: HTMLCanvasElement,
  psm: number
): Promise<OcrPage> {
  const worker = await workerFor(psm);
  const result = await worker.recognize(
    canvas,
    {},
    { text: true, blocks: true }
  );
  const lines: OcrLine[] = [];
  for (const block of (result.data.blocks ?? []) as unknown as RawBlock[]) {
    for (const para of block.paragraphs ?? []) {
      for (const line of para.lines ?? []) {
        const text = line.text.replace(/\s+/g, " ").trim();
        if (!text) continue;
        lines.push({
          text,
          confidence: line.confidence,
          bbox: line.bbox,
          words: (line.words ?? []).map((w) => ({
            text: w.text,
            confidence: w.confidence,
            bbox: w.bbox,
          })),
        });
      }
    }
  }
  return {
    lines,
    text: result.data.text ?? "",
    width: canvas.width,
    height: canvas.height,
  };
}

/** Express a line read from an enlarged crop in the first-pass canvas's coordinates. */
export function toCanvasCoords(
  line: OcrLine,
  region: Region,
  k: number
): OcrLine {
  const map = (b: Box): Box => ({
    x0: region.x + b.x0 / k,
    y0: region.y + b.y0 / k,
    x1: region.x + b.x1 / k,
    y1: region.y + b.y1 / k,
  });
  return {
    ...line,
    bbox: map(line.bbox),
    words: line.words.map((w) => ({ ...w, bbox: map(w.bbox) })),
  };
}

export interface FocusVariant {
  channel: Channel;
  psm: number;
  /** Extra enlargement on top of the standard focused scale (default 1). */
  enlarge?: number;
  /** Exact enlargement relative to the first-pass canvas; overrides the standard scale. */
  scale?: number;
}

/** Read the label area once per variant. Lines come back in first-pass canvas coordinates. */
export async function focusedRead(
  geometry: FocusGeometry,
  region: Region,
  variants: FocusVariant[]
): Promise<OcrLine[][]> {
  const readings: OcrLine[][] = [];
  for (const variant of variants) {
    const k = variant.scale
      ? Math.min(
          variant.scale,
          MAX_CROP_SIDE / Math.max(region.width, region.height)
        )
      : focusScale(geometry, region);
    const crop = renderRegion(geometry, region, k, variant.channel);
    console.log("FOCUSED CROP:", {
      psm: variant.psm,
      channel: variant.channel,
      regionX: region.x,
      regionY: region.y,
      regionWidth: region.width,
      regionHeight: region.height,
      scale: k,
      cropWidth: crop.width,
      cropHeight: crop.height,
    });
    const page = await recognizeWith(crop, variant.psm);
    readings.push(page.lines.map((line) => toCanvasCoords(line, region, k)));
  }
  return readings;
}

/**
 * Bottles often print the alcohol content on one side of the brand name and the volume on the
 * other, in print too small to survive being read together with the big lettering. Find the
 * strips left and right of the biggest line so each can be read on its own.
 */
export function flankRegions(
  lines: OcrLine[],
  label: Region,
  canvasWidth: number
): Region[] {
  const letterCount = (t: string) => (t.match(/[A-Za-z]/g) ?? []).length;
  const inside = lines.filter(
    (l) =>
      l.confidence >= 30 &&
      letterCount(l.text) >= 4 &&
      l.bbox.y0 >= label.y &&
      l.bbox.y1 <= label.y + label.height
  );
  if (inside.length < 2) return [];

  const heights = inside
    .map((l) => l.bbox.y1 - l.bbox.y0)
    .sort((a, b) => a - b);
  const h = heights[Math.floor(heights.length / 2)] || 20;
  const left = Math.min(...inside.map((l) => l.bbox.x0));
  const right = Math.max(...inside.map((l) => l.bbox.x1));

  // The outer part of the label on each side, over the label's whole height.
  const strip = Math.max((right - left) * 0.28, h * 3);
  const outer = h * 1.5;
  const leftX = Math.max(0, left - outer);
  const rightX = Math.max(0, right - strip);
  return [
    { x: leftX, y: label.y, width: left + strip - leftX, height: label.height },
    {
      x: rightX,
      y: label.y,
      width: Math.min(canvasWidth, right + outer) - rightX,
      height: label.height,
    },
  ];
}

/** Read each region with each variant; lines come back in first-pass canvas coordinates. */
export async function regionsRead(
  geometry: FocusGeometry,
  regions: Region[],
  variants: FocusVariant[]
): Promise<OcrLine[][]> {
  const readings: OcrLine[][] = [];
  for (const region of regions) {
    for (const variant of variants) {
      const k = Math.min(
        focusScale(geometry, region) * (variant.enlarge ?? 1),
        MAX_CROP_SIDE / Math.max(region.width, region.height)
      );
      const crop = renderRegion(geometry, region, k, variant.channel);
      const page = await recognizeWith(crop, variant.psm);
      readings.push(page.lines.map((line) => toCanvasCoords(line, region, k)));
    }
  }
  return readings;
}

/**
 * Find the prominent brand lettering, including lettering that OCR reads poorly.
 * Prefer a low-confidence line in the lower part of the label, where the brand
 * line was detected in the original OCR output.
 */
export function brandRegion(
  lines: OcrLine[],
  label: Region,
  canvasWidth: number,
  canvasHeight: number
): Region | null {
  const candidates = lines.filter((line) => {
    const text = line.text.replace(/[^A-Za-z]/g, "");
    const width = line.bbox.x1 - line.bbox.x0;
    const height = line.bbox.y1 - line.bbox.y0;

    return (
      text.length >= 5 &&
      width >= 100 &&
      height >= 15 &&
      line.confidence >= 15 &&
      line.confidence < 70 &&
      line.bbox.x0 < label.x + label.width &&
      line.bbox.x1 > label.x &&
      line.bbox.y0 < label.y + label.height &&
      line.bbox.y1 > label.y
    );
  });

  if (!candidates.length) return null;

  // Prefer the lowest low-confidence text line in the label.
  const brandLine = candidates.reduce((best, line) =>
    line.bbox.y0 > best.bbox.y0 ? line : best
  );

  const h = brandLine.bbox.y1 - brandLine.bbox.y0;
  const padY = Math.max(h * 0.5, 20);

  // Keep the full width of the lettering; only add vertical padding.
  const x = Math.max(label.x, brandLine.bbox.x0);
  const y = Math.max(label.y, brandLine.bbox.y0 - padY);
  const right = Math.min(label.x + label.width, canvasWidth, brandLine.bbox.x1);
  const bottom = Math.min(
    label.y + label.height,
    canvasHeight,
    brandLine.bbox.y1 + padY
  );

  if (right <= x || bottom <= y) return null;

  return {
    x,
    y,
    width: right - x,
    height: bottom - y,
  };
}
