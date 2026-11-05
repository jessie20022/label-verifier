import type { VerificationResult } from '../rules/types';
import { StatusBadge } from './StatusBadge';

const HEADLINE = {
  pass: 'All checks passed',
  review: 'A person should take a look',
  fail: 'This label has problems',
} as const;

export function CheckList({ result }: { result: VerificationResult }) {
  return (
    <section className={`result result-${result.overall}`} aria-live="polite">
      <h3 className="result-headline">
        <StatusBadge status={result.overall} /> {HEADLINE[result.overall]}
      </h3>
      <ul className="checks">
        {result.checks.map((c) => (
          <li key={c.field} className="check">
            <StatusBadge status={c.status} />
            <div>
              <strong>{c.field}</strong>
              <div className="muted">{c.message}</div>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
