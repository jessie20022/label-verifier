/**
 * Turn whatever was thrown into a sentence a person can read.
 * Browsers report some failures (a worker that cannot start, a script that will not load)
 * as plain events or strings rather than Error objects, which used to show up as nothing at all.
 */
export function errorMessage(e: unknown): string {
  const raw = rawText(e);
  if (/unexpected token '?<|<!doctype|is not valid json/i.test(raw)) {
    return "The reader's program files could not be loaded (the server sent a web page instead). If you are running this on your computer, stop it, run \"npm install\", then start it again with \"npm run dev\". If this is the published site, it needs to be rebuilt.";
  }
  if (raw) return raw;
  if (typeof Event !== 'undefined' && e instanceof Event) {
    return 'The reader could not be started in this browser. Reload the page and try again; if it keeps happening, try a different browser.';
  }
  return 'Something went wrong while reading the label. Please try again.';
}

function rawText(e: unknown): string {
  if (typeof e === 'string') return e.trim();
  if (e && typeof e === 'object') {
    const m = (e as { message?: unknown }).message;
    if (typeof m === 'string') return m.trim();
  }
  return '';
}
