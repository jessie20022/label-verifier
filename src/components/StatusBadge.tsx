import type { Status } from '../rules/types';

const LABELS: Record<Status, string> = {
  pass: '✔ Pass',
  review: '⚠ Needs review',
  fail: '✖ Fail',
};

/** Colour, symbol and words together, so it never relies on colour alone. */
export function StatusBadge({ status }: { status: Status }) {
  return <span className={`badge badge-${status}`}>{LABELS[status]}</span>;
}
