import { levenshtein, similarity } from "../rules/normalize";
import { WARNING } from "../rules/checks";
import { estimateBold } from "./boldCheck";
import { ensureEngine, recognize } from "./engine";
import { estimateTilt, worthStraightening } from "./deskew";
import { extractFields } from "./extractFields";
import {
  findLabelRegion,
  flankRegions,
  focusedRead,
  regionsRead,
  type FocusVariant,
  type FocusGeometry,
} from "./focus";

import { renderForOcr, adaptiveThreshold, type Rotation } from "./preprocess";
import type { Hints, LabelReading, OcrLine, OcrPage, Stage } from "./types";

/** Set to true to print what the reader saw and decided (useful when tuning). */
const DEBUG = false;
const debug = (...args: unknown[]) => {
  if (DEBUG) console.log(...args);
};

/** A reading scoring at least this well is accepted without trying other orientations. */
const GOOD_ENOUGH = 70;

const ORIENTATIONS: Rotation[] = [0, 90, 270, 180];

/** Trial tilts for photos too crooked for the engine to report usable baselines. */
const TRIAL_TILTS = [10, -10, 15, -15];

const SIDEWAYS_TILT = 45;

/**
 * Words that appear on alcohol labels. Finding several of them means the picture is the right
 * way up: text turned on its side or upside down comes out as gibberish.
 */
const LABEL_WORD_RE =
  /\b(alc|alcohol|vol|volume|proof|whiske?y|whisky|bourbon|scotch|rye|vodka|gin|rum|tequila|brandy|liqueur|wine|beer|ale|lager|stout|cider|warning|government|surgeon|general|pregnan\w*|distill\w*|bottled|produced|imported|product|brewed|kentucky|straight|ml|oz|net|contents)\b|\d\s*%/gi;

function labelWordHits(page: OcrPage): number {
  const solid = page.lines
    .filter((line) => line.confidence >= 35)
    .map((line) => line.text)
    .join(" ");
  return solid.match(LABEL_WORD_RE)?.length ?? 0;
}

/** Higher is better: average word confidence, discounted when very little text was found. */
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

/** Ranking used to choose between readings: recognizable label words matter most. */
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
  /** The tilt handed to renderForOcr for this canvas (0 when none). */
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

/** Upright enough to stop looking at other orientations. */
const isUpright = (c: Candidate) =>
  c.hits >= 3 || (c.hits >= 1 && c.quality >= GOOD_ENOUGH);

/** Read the picture turned by `rotation`; a plain reading only, which is the fast path. */
async function readPlain(
  bitmap: ImageBitmap,
  rotation: Rotation
): Promise<Candidate> {
  const canvas = renderForOcr(bitmap, rotation);
  return makeCandidate(await recognize(canvas), canvas, rotation, 0);
}

/** Straighten a slightly crooked picture and keep the result if it reads better. */
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

/** Row-wise duplicate removal so the same text read twice does not count twice. */
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

/** Both the colour variants that usually reveal small print on coloured labels. */
const FOCUS_VARIANTS: FocusVariant[] = [
  { channel: "red", psm: 11 },
  { channel: "lum", psm: 11 },
];

/** For the narrow strips beside the brand name: one block of a few short lines. */
const FLANK_VARIANTS: FocusVariant[] = [
  { channel: "red", psm: 6, enlarge: 1.35 },
  { channel: "red", psm: 6, enlarge: 1.8 },
  { channel: "lum", psm: 6, enlarge: 1.35 },
];

/** Does this reading hold everything the comparison needs (except the optional warning)? */
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

/**
 * Read an image, extract label fields, and estimate warning boldness.
 */
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
    // 1. First reading, upright. Most labels need nothing more than this to find their orientation.
    stage("read");
    let best: Candidate | null = await readPlain(bitmap, 0);

    // 2. Only if the words do not look like label words, turn the picture and look again.
    if (!isUpright(best)) {
      for (const rotation of ORIENTATIONS.slice(1)) {
        stage("rotate");
        const candidate = await readPlain(bitmap, rotation);

        // Text turned on its side is reported with a steep slope: not a usable reading.
        if (Math.abs(estimateTilt(candidate.page.lines)) > SIDEWAYS_TILT)
          continue;

        if (better(candidate, best)) best = candidate;
        if (isUpright(best)) break;
      }
    }

    if (
      Math.abs(estimateTilt(best.page.lines)) > SIDEWAYS_TILT &&
      best.rotation === 0
    ) {
      // Nothing better was found; keep the upright reading.
    }

    // 3. Straighten a crooked photo.
    stage("straighten");
    best = await straighten(bitmap, best);

    // 4. Still little to go on: try fixed tilts, then a high-contrast version.
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
      if (better(candidate, best)) best = { ...candidate, canvas: best.canvas };
    }

    stage("extract");
    debug(
      "FIRST PASS:",
      best.page.lines.map((line, index) => `${index}: ${line.text}`).join("\n")
    );

    // 5. First extraction from the first pass alone.
    const firstPass = extractFields(best.page.lines, options.hints);
    let fields = firstPass.fields;
    let warningWords = firstPass.warningWords;
    let lines = best.page.lines;

    // 6. Small print and decorative lettering: read the label area again from the original photo,
    // at full size. Skipped when the first pass already found everything.

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

        // Start with the original OCR lines.
        const merged: OcrLine[] = [...best.page.lines];

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
            flankReadings.map((r) =>
              r.map((l) => `${Math.round(l.confidence)} ${l.text}`)
            ),
            null,
            1
          )
        );

        for (const reading of flankReadings) {
          addLines(merged, reading);
        }

        // Very large brand lettering is read better at a smaller size than the passes above use.
        // If the brand still does not match the application, read the label area once more at about
        // the first-pass size (red channel, sparse text). Only runs when the brand is missing.
        if (
          options.hints?.brand &&
          !coversHint(
            extractFields(merged, options.hints).fields.brand,
            options.hints.brand
          )
        ) {
          const brandReadings = await focusedRead(geometry, region, [
            { channel: "red", psm: 11, scale: 1.25 },
            { channel: "max", psm: 11, scale: 1 },
          ]);
          debug(
            "BRAND FALLBACK LINES:",
            JSON.stringify(
              brandReadings.map((r) =>
                r.map((l) => `${Math.round(l.confidence)} ${l.text}`)
              )
            )
          );
          for (const reading of brandReadings) addLines(merged, reading);
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

        debug(
          "FOCUSED LINES:",
          JSON.stringify(
            readings.map((r) =>
              r.map((l) => `${Math.round(l.confidence)} ${l.text}`)
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

    // 7. The warning is long and set in small type, so a single slip anywhere in it matters.
    // Read the block again on its own and keep whichever reading is closest to the required text.
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

    // 7. Estimate government-warning boldness.
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

/** Every meaningful word of the application's value shows up (roughly) in what was read. */
function coversHint(read: string, hint?: string): boolean {
  if (!hint) return true;
  const words = (t: string) =>
    t
      .toLowerCase()
      .split(/[^a-z0-9']+/)
      .filter((w) => w.length >= 3);
  const have = words(read);
  return words(hint).every((w) => have.some((h) => similarity(h, w) >= 0.8));
}

const WARNING_START_RE = /g[o0]vernment\s+warn/i;

/** Edits needed to turn a reading into the required warning (lower is closer). */
const warningDistance = (text: string) =>
  levenshtein(
    text.replace(/\s+/g, " ").trim().toLowerCase(),
    WARNING.toLowerCase()
  );

/** Read just the warning block, larger and as one block of text, and keep it if it is closer. */
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
    // Enlarge so the letters come out about 36 pixels tall, the size the reader handles best.
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
