import { useMemo, useState } from 'react';
import type { BatchResult } from '../parsing/exportCsv';
import { severity } from '../rules/verify';
import { ReadDetails } from './ReadDetails';
import { StatusBadge } from './StatusBadge';

type SortMode = 'worst' | 'file';

export function ResultsTable({ results }: { results: BatchResult[] }) {
  const [onlyProblems, setOnlyProblems] = useState(false);
  const [sort, setSort] = useState<SortMode>('worst');

  const shown = useMemo(() => {
    let rows = [...results];
    if (onlyProblems) rows = rows.filter((r) => r.result.overall !== 'pass');
    rows.sort((a, b) =>
      sort === 'worst'
        ? severity(b.result.overall) - severity(a.result.overall) || a.order - b.order
        : a.order - b.order,
    );
    return rows;
  }, [results, onlyProblems, sort]);

  return (
    <div>
      <div className="table-controls">
        <label className="inline">
          <input type="checkbox" checked={onlyProblems} onChange={(e) => setOnlyProblems(e.target.checked)} />
          Show only problems
        </label>
        <label className="inline">
          Order:
          <select value={sort} onChange={(e) => setSort(e.target.value as SortMode)}>
            <option value="worst">Worst first</option>
            <option value="file">Same order as the file</option>
          </select>
        </label>
        <span className="muted">
          Showing {shown.length} of {results.length}
        </span>
      </div>

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>ID</th>
              <th>Brand</th>
              <th>Result</th>
              <th>What needs attention</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => {
              const issues = r.result.checks.filter((c) => c.status !== 'pass');
              return (
                <tr key={r.order}>
                  <td>{r.id}</td>
                  <td>
                    {r.app.brand || r.label.brand}
                    {r.imageFile && <div className="muted small">{r.imageFile}</div>}
                  </td>
                  <td>
                    <StatusBadge status={r.result.overall} />
                  </td>
                  <td>
                    {issues.length === 0 ? (
                      <span className="muted">Nothing</span>
                    ) : (
                      <ul className="issues">
                        {issues.map((c) => (
                          <li key={c.field}>
                            <strong>{c.field}:</strong> {c.message}
                          </li>
                        ))}
                      </ul>
                    )}
                    {r.reading && <ReadDetails reading={r.reading} file={r.file} label="See what was read" />}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {shown.length === 0 && <p className="muted pad">No labels to show.</p>}
      </div>
    </div>
  );
}
