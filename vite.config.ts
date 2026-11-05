import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import type { Plugin } from 'vite';
import { defineConfig } from 'vitest/config';

const root = dirname(fileURLToPath(import.meta.url));

/** The OCR engine files the browser needs, and where they live after `npm install`. */
const OCR_FILES: Record<string, string> = {
  'worker.min.js': 'node_modules/tesseract.js/dist/worker.min.js',
  'tesseract-core-lstm.wasm.js': 'node_modules/tesseract.js-core/tesseract-core-lstm.wasm.js',
  'tesseract-core-simd-lstm.wasm.js': 'node_modules/tesseract.js-core/tesseract-core-simd-lstm.wasm.js',
  'tesseract-core-relaxedsimd-lstm.wasm.js': 'node_modules/tesseract.js-core/tesseract-core-relaxedsimd-lstm.wasm.js',
  'eng.traineddata.gz': 'node_modules/@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz',
};

/**
 * Serves the OCR engine from this site (at <base>/tesseract/...) so that reading a label never
 * contacts another server. While developing, the files are served straight from node_modules;
 * in a build they are added to the output. There is no copy step to forget.
 */
function ocrAssets(): Plugin {
  const read = (name: string) => readFileSync(resolve(root, OCR_FILES[name]));
  return {
    name: 'ocr-assets',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const match = (req.url ?? '').split('?')[0].match(/\/tesseract\/([^/]+)$/);
        if (!match) return next();
        const name = decodeURIComponent(match[1]);
        if (!(name in OCR_FILES)) return next();
        try {
          const body = read(name);
          res.setHeader('Content-Type', name.endsWith('.js') ? 'text/javascript' : 'application/octet-stream');
          res.setHeader('Cache-Control', 'no-cache');
          res.end(body);
        } catch {
          res.statusCode = 404;
          res.end(`Missing ${OCR_FILES[name]}. Run "npm install".`);
        }
      });
    },
    generateBundle() {
      for (const name of Object.keys(OCR_FILES)) {
        this.emitFile({ type: 'asset', fileName: `tesseract/${name}`, source: read(name) });
      }
    },
  };
}

// IMPORTANT: `base` must match your GitHub repository name,
// otherwise the deployed site loads as a blank page.
export default defineConfig({
  plugins: [react(), ocrAssets()],
  base: '/label-verifier/',
  test: {
    environment: 'node',
  },
});
