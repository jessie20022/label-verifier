import {
  collapse,
  compareText,
  parseVolumeMl,
  similarity,
  stripToAlnum,
} from "./normalize";
import type { BoldResult, CheckResult } from "./types";
import { describeEdit, diffWords } from "./wordDiff";

/** The standard Government Health Warning Statement (27 CFR part 16). */
export const WARNING =
  "GOVERNMENT WARNING: (1) According to the Surgeon General, women should not drink alcoholic beverages during pregnancy because of the risk of birth defects. (2) Consumption of alcoholic beverages impairs your ability to drive a car or operate machinery, and may cause health problems.";

const WARNING_HEADER = "GOVERNMENT WARNING:";

export interface CheckOptions {
  /** The label text came from reading an image, so small misreads are possible. */
  ocr?: boolean;
}

/** How close two texts must be to be called "probably the same, misread". */
const NEAR_MATCH = 0.85;

/** Shared logic for free-text fields such as brand name and class/type. */
function checkText(
  field: string,
  app: string,
  label: string,
  opts: CheckOptions = {}
): CheckResult {
  if (!collapse(app)) {
    return {
      field,
      status: "fail",
      message: "Not provided on the application",
    };
  }
  if (!collapse(label)) {
    return { field, status: "fail", message: "Not found on the label" };
  }
  const match = compareText(app, label);
  if (match === "exact") {
    return { field, status: "pass", message: "Exact match" };
  }
  if (match === "loose") {
    return {
      field,
      status: "pass",
      message: "Match (ignoring capitalization and punctuation)",
    };
  }
  if (opts.ocr && similarity(app, label) >= NEAR_MATCH) {
    return {
      field,
      status: "review",
      message: `Very close but not identical: label reads "${collapse(
        label
      )}", application says "${collapse(
        app
      )}". This may be a misread of the image, so please check the label itself.`,
    };
  }
  return {
    field,
    status: "fail",
    message: `Label says "${collapse(label)}", application says "${collapse(
      app
    )}"`,
  };
}

export const checkBrand = (
  app: string,
  label: string,
  opts: CheckOptions = {}
): CheckResult => checkText("Brand name", app, label, opts);

export const checkClass = (
  app: string,
  label: string,
  opts: CheckOptions = {}
): CheckResult => checkText("Class/type", app, label, opts);

const NUM = "(\\d+(?:\\.\\d+)?)";

export function checkAbv(appAbv: string, labelText: string): CheckResult {
  const field = "Alcohol content";
  const appPct = parseFloat(appAbv.replace("%", ""));
  if (Number.isNaN(appPct)) {
    return {
      field,
      status: "fail",
      message: "Application ABV is missing or not a number",
    };
  }

  const pctMatch =
    labelText.match(new RegExp(`${NUM}\\s*%`)) ??
    labelText.match(new RegExp(`${NUM}\\s*(?:alc|abv)`, "i"));
  const labelPct = pctMatch ? parseFloat(pctMatch[1]) : NaN;
  if (Number.isNaN(labelPct)) {
    return {
      field,
      status: "fail",
      message: "No alcohol percentage found on the label",
    };
  }

  if (Math.abs(labelPct - appPct) > 0.001) {
    return {
      field,
      status: "fail",
      message: `Label shows ${labelPct}% but application says ${appPct}%`,
    };
  }

  const proofMatch = labelText.match(new RegExp(`${NUM}\\s*proof`, "i"));
  if (proofMatch) {
    const proof = parseFloat(proofMatch[1]);
    if (Math.abs(proof - labelPct * 2) > 0.001) {
      return {
        field,
        status: "fail",
        message: `Proof on label (${proof}) does not equal 2 x ${labelPct}% (${
          labelPct * 2
        })`,
      };
    }
  }

  return {
    field,
    status: "pass",
    message: `${labelPct}% matches the application`,
  };
}

const VOLUME_TOLERANCE_ML = 1.5;

export function checkNetContents(app: string, label: string): CheckResult {
  const field = "Net contents";
  if (!collapse(app)) {
    return {
      field,
      status: "fail",
      message: "Not provided on the application",
    };
  }
  if (!collapse(label)) {
    return { field, status: "fail", message: "Not found on the label" };
  }
  const a = parseVolumeMl(app);
  const b = parseVolumeMl(label);
  if (a === null || b === null) {
    return {
      field,
      status: "fail",
      message: `Could not read a volume from "${
        a === null ? collapse(app) : collapse(label)
      }"`,
    };
  }
  if (Math.abs(a - b) > VOLUME_TOLERANCE_ML) {
    return {
      field,
      status: "fail",
      message: `Label says "${collapse(label)}", application says "${collapse(
        app
      )}"`,
    };
  }
  const same = collapse(app).toLowerCase() === collapse(label).toLowerCase();
  return {
    field,
    status: "pass",
    message: same
      ? "Exact match"
      : `Same volume: "${collapse(label)}" = "${collapse(app)}"`,
  };
}

export function checkOrigin(
  app: string,
  label: string,
  opts: CheckOptions = {}
): CheckResult {
  const field = "Country of origin";
  const hasApp = collapse(app).length > 0;
  const hasLabel = collapse(label).length > 0;

  if (!hasApp && !hasLabel) {
    return {
      field,
      status: "pass",
      message: "Not applicable (no import declared)",
    };
  }
  if (!hasApp) {
    return {
      field,
      status: "review",
      message: `Label shows "${collapse(
        label
      )}" but the application lists no country of origin`,
    };
  }
  if (!hasLabel) {
    return {
      field,
      status: "fail",
      message: "Imported product: country of origin is missing from the label",
    };
  }
  // Accept statements such as "Product of Scotland" for an application that says "Scotland".
  if (
    compareText(app, label) === "different" &&
    stripToAlnum(label).includes(stripToAlnum(app))
  ) {
    return {
      field,
      status: "pass",
      message: `Label says "${collapse(label)}"`,
    };
  }
  return checkText(field, app, label, opts);
}

/** Maximum number of near-miss words tolerated, per image read, before calling it a failure. */
const OCR_MAX_NEAR_MISSES = 3;

export function checkWarning(
  label: string,
  opts: CheckOptions = {}
): CheckResult {
  const field = "Government warning";
  let text = collapse(label);

  if (!text) {
    return {
      field,
      status: "fail",
      message: "Government warning is missing from the label",
    };
  }

  // OCR sometimes reads the colon as another mark; do not fail the header for that alone.
  if (opts.ocr) text = text.replace(/^(GOVERNMENT WARNING)\s*[;.,!|]/, "$1:");

  if (!text.startsWith(WARNING_HEADER)) {
    const looksLikeHeader = text
      .toLowerCase()
      .startsWith(WARNING_HEADER.toLowerCase());
    return {
      field,
      status: "fail",
      message: looksLikeHeader
        ? `Header must be "GOVERNMENT WARNING:" in all capital letters (label has "${text.slice(
            0,
            WARNING_HEADER.length
          )}")`
        : 'Warning must begin with "GOVERNMENT WARNING:"',
    };
  }
  if (text === WARNING) {
    return {
      field,
      status: "pass",
      message: "Exact standard text with all-caps header",
    };
  }

  const edits = diffWords(WARNING.split(" "), text.split(" "));
  const summary =
    edits.slice(0, 3).map(describeEdit).join("; ") +
    (edits.length > 3 ? ` (+${edits.length - 3} more)` : "");

  if (
    opts.ocr &&
    edits.length <= OCR_MAX_NEAR_MISSES &&
    edits.every((e) => e.ocrLike)
  ) {
    return {
      field,
      status: "review",
      message: `Nearly identical, but the reading differs slightly: ${summary}. This may be a misread of the image, so please check the label itself.`,
    };
  }
  return {
    field,
    status: "fail",
    message: `Wording differs from the required text: ${summary}`,
  };
}

/** Approximate check that the warning header is bold, from the image's stroke thickness. */
export function checkWarningBold(bold: BoldResult): CheckResult {
  const field = "Warning header bold";
  if (bold.verdict === "bold") {
    return {
      field,
      status: "pass",
      message:
        "Header looks bolder than the text after it (estimated from the image)",
    };
  }
  if (bold.verdict === "not-bold") {
    return {
      field,
      status: "review",
      message:
        "The header does not look bolder than the text after it. This is an estimate from the image, so please check the label itself.",
    };
  }
  return {
    field,
    status: "review",
    message:
      "Could not measure boldness from this image. Please check the label itself.",
  };
}
