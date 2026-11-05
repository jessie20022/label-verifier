import {
  checkAbv,
  checkBrand,
  checkClass,
  checkNetContents,
  checkOrigin,
  checkWarning,
  checkWarningBold,
} from './checks';
import type {
  Application,
  CheckResult,
  LabelFields,
  Status,
  VerificationResult,
  VerifyOptions,
} from './types';

const SEVERITY: Record<Status, number> = { pass: 0, review: 1, fail: 2 };

export const worstStatus = (statuses: Status[]): Status =>
  statuses.reduce<Status>((worst, s) => (SEVERITY[s] > SEVERITY[worst] ? s : worst), 'pass');

export const severity = (s: Status): number => SEVERITY[s];

/** Run every check and roll the results up to one overall status. */
export function verifyLabel(
  app: Application,
  label: LabelFields,
  options: VerifyOptions = {},
): VerificationResult {
  const o = { ocr: options.ocr };
  const checks: CheckResult[] = [
    checkBrand(app.brand, label.brand, o),
    checkClass(app.classType, label.classType, o),
    checkAbv(app.abv, label.abv),
    checkNetContents(app.netContents, label.netContents),
    checkOrigin(app.origin, label.origin, o),
    checkWarning(label.warning, o),
  ];
  // Boldness can only be estimated from a picture, and only matters if a warning was found.
  if (options.bold && label.warning.trim()) {
    checks.push(checkWarningBold(options.bold));
  }
  return { checks, overall: worstStatus(checks.map((c) => c.status)) };
}
