import { levenshtein, similarity } from "../rules/normalize";
import { WARNING } from "../rules/checks";
import { estimateBold } from "./boldCheck";
import { ensureEngine, recognize } from "./engine";
import { estimateTilt, worthStraightening } from "./deskew";
import { extractFields } from "./extractFields";
import {
  brandRegion,
  findLabelRegion,
  flankRegions,
  focusedRead,
  regionsRead,
  type FocusVariant,
  type FocusGeometry,
} from "./focus";
import { renderForOcr, adaptiveThreshold, type Rotation } from "./preprocess";
import type { Hints, LabelReading, OcrLine, OcrPage, Stage } from "./types";

/** Set to true to print what the reader saw and decided. */
const DEBUG = false;
const debug = (...args: unknown[]) => {
  if (DEBUG) console.log(...args);
};

// PASTE THE TIMING HELPER HERE
async function timed<T>(name: string, task: () => Promise<T>): Promise<T> {
  const start = performance.now();

  try {
    return await task();
  } finally {
    console.log(
      `[OCR TIME] ${name}: ${((performance.now() - start) / 1000).toFixed(2)}s`
    );
  }
}

const GOOD_ENOUGH = 70;
const ORIENTATIONS: Rotation[] = [0, 90, 270, 180];
const TRIAL_TILTS = [10, -10, 15, -15];
const SIDEWAYS_TILT = 45;

const LABEL_WORD_RE =
  /\b(alc|alcohol|vol|volume|proof|whiske?y|whisky|bourbon|scotch|rye|vodka|gin|rum|tequila|brandy|liqueur|wine|beer|ale|lager|stout|cider|warning|government|surgeon|general|pregnan\w*|distill\w*|bottled|produced|imported|product|brewed|kentucky|straight|ml|oz|net|contents)\b|\d\s*%/gi;

function labelWordHits(page: OcrPage): number {
  const solid = page.lines
    .filter((line) => line.confidence >= 35)
    .map((line) => line.text)
    .join(" ");
  return solid.match(LABEL_WORD_RE)?.length ?? 0;
}

export function readingQuality(page: OcrPage): number {
  const words = page.lines
    .flatMap((line) => line.words)
    .filter((word) => word.text.replace(/[^A-Za-z0-9]/g, "").length >= 2);

  if (!words.length) return 0;

  const meanConfidence =
    words.reduce((sum, word) => sum + word.confidence, 0) / words.length;

  const coverage = Math.min(1, words.length / 12);

  return meanConfidence * (0.65 + 0.35 * coverage);
}

function orientationScore(page: OcrPage): number {
  return labelWordHits(page) * 10 + readingQuality(page);
}

export interface ReadOptions {
  hints?: Hints;
  onStage?: (stage: Stage) => void;
}

interface Candidate {
  page: OcrPage;
  canvas: HTMLCanvasElement;
  rotation: Rotation;
  deskew: number;
  quality: number;
  hits: number;
}

function makeCandidate(
  page: OcrPage,
  canvas: HTMLCanvasElement,
  rotation: Rotation,
  deskew: number
): Candidate {
  return {
    page,
    canvas,
    rotation,
    deskew,
    quality: readingQuality(page),
    hits: labelWordHits(page),
  };
}

const better = (a: Candidate, b: Candidate | null) =>
  !b || orientationScore(a.page) > orientationScore(b.page);

const isUpright = (c: Candidate) =>
  c.hits >= 3 || (c.hits >= 1 && c.quality >= GOOD_ENOUGH);

async function readPlain(
  bitmap: ImageBitmap,
  rotation: Rotation
): Promise<Candidate> {
  const canvas = renderForOcr(bitmap, rotation);
  return makeCandidate(await recognize(canvas), canvas, rotation, 0);
}

async function straighten(
  bitmap: ImageBitmap,
  current: Candidate
): Promise<Candidate> {
  const tilt = estimateTilt(current.page.lines);
  if (!worthStraightening(tilt)) return current;

  const arg = Math.round(-tilt * 10) / 10;
  const canvas = renderForOcr(bitmap, current.rotation, arg);
  const candidate = makeCandidate(
    await recognize(canvas),
    canvas,
    current.rotation,
    arg
  );
  return better(candidate, current) ? candidate : current;
}

function addLines(target: OcrLine[], more: OcrLine[]): void {
  for (const line of more) {
    const key = line.text.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (key.length < 2) continue;

    const h = Math.max(line.bbox.y1 - line.bbox.y0, 12);
    const twin = target.find((existing) => {
      const other = existing.text.toLowerCase().replace(/[^a-z0-9]/g, "");
      return (
        other === key &&
        Math.abs(existing.bbox.y0 - line.bbox.y0) < h * 1.5 &&
        Math.abs(existing.bbox.x0 - line.bbox.x0) < h * 3
      );
    });

    if (!twin) target.push(line);
  }
}

/** General focused reading for the rest of the label. */
const FOCUS_VARIANTS = [{ channel: "lum", psm: 11 }] as const;

/** Small print beside the brand name. */
const FLANK_VARIANTS: FocusVariant[] = [
  { channel: "red", psm: 6, enlarge: 1.35 },
  { channel: "red", psm: 6, enlarge: 1.8 },
  { channel: "lum", psm: 6, enlarge: 1.35 },
];

/** Two targeted attempts for the brand crop. */
const BRAND_VARIANTS = [{ channel: "lum", psm: 11 }] as const;

function isComplete(fields: {
  brand: string;
  classType: string;
  abv: string;
  netContents: string;
}) {
  return !!(
    fields.brand &&
    fields.classType &&
    fields.abv &&
    fields.netContents
  );
}

export async function readLabelImage(
  file: Blob,
  options: ReadOptions = {}
): Promise<LabelReading> {
  const started = performance.now();
  const stage = options.onStage ?? (() => undefined);

  stage("engine");
  await ensureEngine(1);

  stage("prepare");

  let bitmap: ImageBitmap;

  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new Error(
      "This file could not be opened as a picture. Please use a PNG or JPG image."
    );
  }

  try {
    // 1. First reading, upright.
    stage("read");
    let best: Candidate | null = await readPlain(bitmap, 0);

    // 2. Try other orientations only when the first reading is poor.
    if (!isUpright(best)) {
      for (const rotation of ORIENTATIONS.slice(1)) {
        stage("rotate");
        const candidate = await readPlain(bitmap, rotation);

        if (Math.abs(estimateTilt(candidate.page.lines)) > SIDEWAYS_TILT)
          continue;

        if (better(candidate, best)) best = candidate;
        if (isUpright(best)) break;
      }
    }

    // 3. Straighten a crooked photo.
    stage("straighten");
    best = await straighten(bitmap, best);

    // 4. Try fixed tilts and thresholding only when the reading is still poor.
    if (best.hits < 2 && best.quality < GOOD_ENOUGH) {
      for (const tilt of TRIAL_TILTS) {
        const canvas = renderForOcr(bitmap, best.rotation, tilt);
        const candidate = makeCandidate(
          await recognize(canvas),
          canvas,
          best.rotation,
          tilt
        );

        if (better(candidate, best)) best = candidate;
        if (isUpright(best)) break;
      }

      const thresholded = adaptiveThreshold(best.canvas, 21, 10);
      const candidate = makeCandidate(
        await recognize(thresholded),
        best.canvas,
        best.rotation,
        best.deskew
      );

      if (better(candidate, best)) {
        best = { ...candidate, canvas: best.canvas };
      }
    }

    stage("extract");

    debug(
      "FIRST PASS:",
      best.page.lines.map((line, index) => `${index}: ${line.text}`).join("\n")
    );

    // 5. Extract fields from the first pass.
    const firstPass = extractFields(best.page.lines, options.hints);
    let fields = firstPass.fields;
    let warningWords = firstPass.warningWords;
    let lines = best.page.lines;

    // 6. Re-read the label when fields are missing or hints are not covered.
    if (
      !isComplete(fields) ||
      !coversHint(fields.brand, options.hints?.brand) ||
      !coversHint(fields.classType, options.hints?.classType)
    ) {
      stage("read");

      try {
        const region = findLabelRegion(
          best.page.lines,
          best.canvas.width,
          best.canvas.height
        );

        const geometry: FocusGeometry = {
          bitmap,
          rotation: best.rotation,
          tilt: best.deskew,
          canvasWidth: best.canvas.width,
          canvasHeight: best.canvas.height,
        };

        const merged: OcrLine[] = [...best.page.lines];

        // Targeted brand OCR: exactly two attempts.
        const brandCrop = options.hints?.brand
          ? brandRegion(
              best.page.lines,
              region,
              best.canvas.width,
              best.canvas.height
            )
          : null;

        if (brandCrop) {
          const brandReadings = await focusedRead(
            geometry,
            brandCrop,
            BRAND_VARIANTS
          );

          debug(
            "BRAND CROP OCR:",
            JSON.stringify(
              brandReadings.map((reading, index) => ({
                variant: index,
                lines: reading.map((line) => ({
                  text: line.text,
                  confidence: Math.round(line.confidence),
                  bbox: line.bbox,
                })),
              })),
              null,
              2
            )
          );

          for (const reading of brandReadings) {
            addLines(merged, reading);
          }
        }

        // General focused reading for the rest of the label.
        const readings = await focusedRead(geometry, region, FOCUS_VARIANTS);

        for (const reading of readings) {
          addLines(merged, reading);
        }

        // Small print beside the brand name.
        const flanks = flankRegions(merged, region, best.canvas.width);

        debug("FLANKS:", JSON.stringify(flanks));

        const flankReadings = await regionsRead(
          geometry,
          flanks,
          FLANK_VARIANTS
        );

        debug(
          "FLANK LINES:",
          JSON.stringify(
            flankReadings.map((reading) =>
              reading.map(
                (line) => `${Math.round(line.confidence)} ${line.text}`
              )
            ),
            null,
            1
          )
        );

        for (const reading of flankReadings) {
          addLines(merged, reading);
        }

        merged.sort((a, b) =>
          Math.abs(a.bbox.y0 - b.bbox.y0) > 8
            ? a.bbox.y0 - b.bbox.y0
            : a.bbox.x0 - b.bbox.x0
        );

        debug(
          "FOCUS REGION:",
          JSON.stringify(region),
          best.canvas.width,
          best.canvas.height
        );

        debug("BRAND CROP:", JSON.stringify(brandCrop));

        debug(
          "BRAND READINGS:",
          JSON.stringify(
            brandCrop
              ? merged
                  .filter(
                    (line) =>
                      line.bbox.x0 >= brandCrop.x &&
                      line.bbox.x1 <= brandCrop.x + brandCrop.width &&
                      line.bbox.y0 >= brandCrop.y &&
                      line.bbox.y1 <= brandCrop.y + brandCrop.height
                  )
                  .map((line) => `${Math.round(line.confidence)} ${line.text}`)
              : []
          )
        );

        debug(
          "FOCUSED LINES:",
          JSON.stringify(
            readings.map((reading) =>
              reading.map(
                (line) => `${Math.round(line.confidence)} ${line.text}`
              )
            ),
            null,
            1
          )
        );

        debug("MERGED JSON:", JSON.stringify(merged));

        const second = extractFields(merged, options.hints);
        fields = second.fields;
        lines = merged;

        // Keep warning extraction isolated to the original pass when possible.
        if (firstPass.fields.warning || !second.fields.warning) {
          fields = { ...fields, warning: firstPass.fields.warning };
          warningWords = firstPass.warningWords;
        } else {
          warningWords = second.warningWords;
        }
      } catch (error) {
        console.warn("Focused reading failed; using the first reading:", error);
      }
    }

    // 7. Re-read the government warning block when one was detected.
    if (fields.warning) {
      try {
        const better = await rereadWarning(
          bitmap,
          best,
          lines,
          fields.warning,
          options.hints
        );

        if (better) {
          fields = { ...fields, warning: better.warning };
        }
      } catch (error) {
        console.warn("Warning re-read failed; using the first reading:", error);
      }
    }

    debug("EXTRACTED FIELDS:", fields);

    // 8. Estimate government-warning boldness.
    const bold = fields.warning
      ? estimateBold(best.canvas, warningWords.header, warningWords.body)
      : { verdict: "unknown" as const, ratio: null };

    const confs = best.page.lines
      .flatMap((line) => line.words)
      .map((word) => word.confidence);

    return {
      fields,
      rawText: lines.map((line) => line.text).join("\n"),
      confidence: confs.length
        ? Math.round(
            confs.reduce((sum, value) => sum + value, 0) / confs.length
          )
        : 0,
      rotation: best.rotation,
      deskew: best.deskew,
      bold,
      seconds: (performance.now() - started) / 1000,
    };
  } finally {
    bitmap.close();
  }
}

/** Every meaningful word of the application's value shows up approximately in the OCR text. */
function coversHint(read: string, hint?: string): boolean {
  if (!hint) return true;

  const words = (text: string) =>
    text
      .toLowerCase()
      .split(/[^a-z0-9']+/)
      .filter((word) => word.length >= 3);

  const have = words(read);

  return words(hint).every((word) =>
    have.some((candidate) => similarity(candidate, word) >= 0.8)
  );
}

const WARNING_START_RE = /g[o0]vernment\s+warn/i;

const warningDistance = (text: string) =>
  levenshtein(
    text.replace(/\s+/g, " ").trim().toLowerCase(),
    WARNING.toLowerCase()
  );

async function rereadWarning(
  bitmap: ImageBitmap,
  best: Candidate,
  lines: OcrLine[],
  current: string,
  hints?: Hints
): Promise<{
  warning: string;
  words: ReturnType<typeof extractFields>["warningWords"];
} | null> {
  const header = lines.find((line) => WARNING_START_RE.test(line.text));
  if (!header) return null;

  const h = Math.max(header.bbox.y1 - header.bbox.y0, 12);
  const label = findLabelRegion(lines, best.canvas.width, best.canvas.height);

  const x = Math.max(0, Math.min(label.x, header.bbox.x0 - h));
  const right = Math.min(
    best.canvas.width,
    Math.max(label.x + label.width, header.bbox.x1 + h)
  );

  const y = Math.max(0, header.bbox.y0 - h * 0.6);
  const bottom = Math.min(
    best.canvas.height,
    Math.max(header.bbox.y1 + h * 9, label.y + label.height)
  );

  const region = { x, y, width: right - x, height: bottom - y };

  const readings = await focusedRead(
    {
      bitmap,
      rotation: best.rotation,
      tilt: best.deskew,
      canvasWidth: best.canvas.width,
      canvasHeight: best.canvas.height,
    },
    region,
    [
      { channel: "lum", psm: 6, scale: Math.min(3.5, Math.max(1, 36 / h)) },
      { channel: "lum", psm: 6, scale: Math.min(3.5, Math.max(1.4, 52 / h)) },
      { channel: "red", psm: 6, scale: Math.min(3.5, Math.max(1, 36 / h)) },
    ]
  );

  let bestText = current;
  let bestDistance = warningDistance(current);
  let bestWords: ReturnType<typeof extractFields>["warningWords"] | null = null;

  for (const reading of readings) {
    const result = extractFields(reading, hints);
    if (!result.fields.warning) continue;

    const distance = warningDistance(result.fields.warning);

    if (distance < bestDistance) {
      bestDistance = distance;
      bestText = result.fields.warning;
      bestWords = result.warningWords;
    }
  }

  return bestWords ? { warning: bestText, words: bestWords } : null;
}
