import type { BoldResult, LabelFields } from '../rules/types';

export interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface OcrWord {
  text: string;
  confidence: number;
  bbox: Box;
}

export interface OcrLine {
  text: string;
  confidence: number;
  bbox: Box;
  words: OcrWord[];
  /** The line the letters sit on, as reported by the engine; its slope shows how tilted the text is. */
  baseline?: Box;
}

/** One pass of the OCR engine over an image. */
export interface OcrPage {
  lines: OcrLine[];
  text: string;
  width: number;
  height: number;
}

/** Application values used only to help locate the matching text on the label. */
export interface Hints {
  brand?: string;
  classType?: string;
}

/** Everything learned from reading one label image. */
export interface LabelReading {
  fields: LabelFields;
  /** The raw text exactly as the OCR engine returned it. */
  rawText: string;
  /** Average OCR confidence, 0-100. */
  confidence: number;
  /** Degrees the image had to be turned to read it (0, 90, 180 or 270). */
  rotation: number;
  /** Small tilt, in degrees, that was straightened out before the final reading (0 if none). */
  deskew: number;
  bold: BoldResult;
  seconds: number;
}

export type Stage = 'engine' | 'prepare' | 'read' | 'rotate' | 'straighten' | 'extract';
