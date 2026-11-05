import { useState } from 'react';
import { BatchUpload } from './components/BatchUpload';
import { SingleCheck } from './components/SingleCheck';

type Tab = 'single' | 'batch';

export default function App() {
  const [tab, setTab] = useState<Tab>('single');

  return (
    <div className="page">
      <header className="header">
        <h1>Label Verifier</h1>
        <p>Check that what is printed on a label matches the application.</p>
      </header>

      <div className="tabs" role="tablist" aria-label="Choose what to check">
        <button
          role="tab"
          aria-selected={tab === 'single'}
          className={`tab ${tab === 'single' ? 'tab-active' : ''}`}
          onClick={() => setTab('single')}
        >
          Check one label
        </button>
        <button
          role="tab"
          aria-selected={tab === 'batch'}
          className={`tab ${tab === 'batch' ? 'tab-active' : ''}`}
          onClick={() => setTab('batch')}
        >
          Check many labels
        </button>
      </div>

      <main className="panel" role="tabpanel">
        {tab === 'single' ? <SingleCheck /> : <BatchUpload />}
      </main>

      <footer className="footer">
        Prototype. Everything runs in your browser; no files are uploaded or stored.
      </footer>
    </div>
  );
}
