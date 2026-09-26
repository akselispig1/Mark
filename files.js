// Finding and reading the user's own documents, so Mark can answer "what did that letter say?"
// without you opening anything. Nothing here leaves the machine.
import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const text = (t) => ({ content: [{ type: 'text', text: typeof t === 'string' ? t : JSON.stringify(t) }] });
const fail = (t) => ({ ...text(t), isError: true });

const HOME = os.homedir();
// Where a person's documents actually live. OneDrive shadows Desktop/Documents on most Windows setups.
const PLACES = ['Desktop', 'Documents', 'Downloads', 'Pictures', 'OneDrive', 'OneDrive/Desktop', 'OneDrive/Documents']
  .map((p) => path.join(HOME, p)).filter((p) => fs.existsSync(p));
const SKIP = /^(node_modules|\.git|AppData|\$RECYCLE\.BIN|System Volume Information|\.cache|venv|\.venv|dist|build)$/i;
const READABLE = /\.(pdf|docx|xlsx|xls|csv|txt|md|json|log|ya?ml|html?|js|ts|py|css|rtf)$/i;

const human = (n) => (n > 1e6 ? (n / 1e6).toFixed(1) + ' MB' : n > 1e3 ? Math.round(n / 1e3) + ' KB' : n + ' B');

/** Walk a few folders deep, newest first, without wandering into the whole disk. */
function search(needle, roots = PLACES, { maxDepth = 5, limit = 25, msBudget = 6000 } = {}) {
  const want = needle.toLowerCase().split(/\s+/).filter(Boolean);
  const hits = [];
  const until = Date.now() + msBudget;
  const walk = (dir, depth) => {
    if (depth > maxDepth || Date.now() > until || hits.length >= limit * 4) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith('.') || SKIP.test(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full, depth + 1);
      else if (want.every((w) => e.name.toLowerCase().includes(w))) {
        try { const s = fs.statSync(full); hits.push({ path: full, size: s.size, modified: s.mtime }); } catch {}
      }
    }
  };
  for (const r of roots) walk(r, 0);
  return hits.sort((a, b) => b.modified - a.modified).slice(0, limit);
}

/** Plain text out of whatever the file happens to be. */
async function extract(file) {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.pdf') {
    const { PDFParse } = await import('pdf-parse');
    const parser = new PDFParse({ data: fs.readFileSync(file) });
    try {
      const d = await parser.getText();
      return { text: d.text, note: `${d.total} page${d.total === 1 ? '' : 's'}` };
    } finally { await parser.destroy().catch(() => {}); }
  }
  if (ext === '.docx') {
    const mod = await import('mammoth');
    const mammoth = mod.default ?? mod;                  // these libraries are CommonJS underneath
    const r = await mammoth.extractRawText({ path: file });
    return { text: r.value };
  }
  if (['.xlsx', '.xls', '.csv'].includes(ext)) {
    const mod = await import('xlsx');
    const XLSX = mod.default ?? mod;
    const wb = XLSX.readFile(file);
    const parts = wb.SheetNames.map((n) => `--- ${n} ---\n${XLSX.utils.sheet_to_csv(wb.Sheets[n])}`);
    return { text: parts.join('\n\n'), note: `${wb.SheetNames.length} sheet(s)` };
  }
  return { text: fs.readFileSync(file, 'utf8') };
}

export const fileTools = () => [
  tool('find_file',
    "Find one of the user's own files by name (Desktop, Documents, Downloads, Pictures, OneDrive). Use this before read_document when you only know roughly what it's called.",
    { name: z.string().describe('Words from the file name, e.g. "insurance pdf" or "rent"'),
      folder: z.string().optional().describe('Only look in this folder (full path)') },
    async ({ name, folder }) => {
      const roots = folder ? [folder] : PLACES;
      if (folder && !fs.existsSync(folder)) return fail(`There's no folder at ${folder}.`);
      const hits = search(name, roots);
      if (!hits.length) return text(`Nothing matching "${name}" in ${folder || 'the usual folders'}.`);
      return text(JSON.stringify(hits.map((h) => ({
        path: h.path, size: human(h.size), modified: h.modified.toISOString().slice(0, 16).replace('T', ' '),
      }))));
    }),

  tool('read_document',
    'Read what a document actually says: PDF, Word, Excel, CSV, text, code. Use it when the user asks about the contents of one of their files. Returns the text, shortened if it is very long.',
    { path: z.string().describe('Full path to the file (from find_file)'),
      search: z.string().optional().describe('Only return the parts mentioning this'),
      limit: z.number().optional().describe('Max characters back, default 6000') },
    async ({ path: file, search: needle, limit = 6000 }) => {
      if (!fs.existsSync(file)) return fail(`There's no file at ${file}.`);
      if (!READABLE.test(file)) return fail(`I can't read ${path.extname(file) || 'that kind of'} files — only PDF, Word, Excel, CSV, text and code.`);
      try {
        const { text: raw, note } = await extract(file);
        let out = (raw || '').replace(/\n{3,}/g, '\n\n').trim();
        if (!out) return text(`${path.basename(file)} has no text in it${note ? ` (${note})` : ''} — it may be a scan.`);
        if (needle) {
          const lines = out.split('\n');
          const keep = lines.filter((l) => l.toLowerCase().includes(needle.toLowerCase()));
          out = keep.length ? keep.join('\n') : `(nothing mentions "${needle}"; here's the start instead)\n` + out;
        }
        const head = `${path.basename(file)}${note ? ` · ${note}` : ''} · ${human(fs.statSync(file).size)}\n\n`;
        return text(head + (out.length > limit ? out.slice(0, limit) + `\n… (${out.length - limit} more characters — ask for a specific part)` : out));
      } catch (e) { return fail(`Couldn't read that: ${e.message}`); }
    }),
];
