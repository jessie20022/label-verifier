export type Status = 'pass' | 'review' | 'fail';

export interface CheckResult {
  field: string;
  status: Status;
  message: string;
}

/** What the applicant declared on the application form. */
export interface Application {
  brand: string;
  classType: string;
  abv: string;
  netContents: string;
  origin: string;
}

/** What is printed on the label artwork (as text). */
export interface LabelFields {
  brand: string;
  classType: string;
  abv: string;
  netContents: string;
  origin: string;
  warning: string;
}

export type BoldVerdict = 'bold' | 'not-bold' | 'unknown';

/** Result of the approximate "is the warning header bold?" measurement. */
export interface BoldResult {
  verdict: BoldVerdict;
  /** Header stroke thickness divided by body stroke thickness (null if not measurable). */
  ratio: number | null;
}

export interface VerificationResult {
  checks: CheckResult[];
  overall: Status;
}

export interface VerifyOptions {
  /** True when the label text came from reading an image (OCR can misread characters). */
  ocr?: boolean;
  /** Bold measurement for the warning header; only available for images. */
  bold?: BoldResult;
}

export interface BatchRow {
  id: string;
  app: Application;
  /** Label text from the CSV columns (used when there is no image). */
  label: LabelFields;
  /** Name of the label image file listed in the CSV, if any. */
  imageFile: string;
}
