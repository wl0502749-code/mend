// mend: one patch tool for every AI edit format.
//
// Reads a patch in one of four formats -- a unified diff (often with wrong
// line numbers), SEARCH/REPLACE blocks, a V4A patch, or JSON text-editor tool
// calls -- and applies it to the tree of text files rooted at the working
// directory: every file is changed or nothing is. SPEC.md is the contract
// this implements; the section numbers in the comments below refer to it.
// Node 22, standard library only.
//
//   node main.ts [--format=NAME] [--check] [--strict] [PATCH]
//
// In a make.fun trial (MAKEFUN_ENV_URL set) the last lines hand over to
// runner.ts, which runs this file on each of the trial's checks.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

/** An exit-2 outcome: the single line to print. */
class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}

/** One edit's failure: its code and the path it concerns. */
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const isBlank = (s: string): boolean => s.trim() === '';

/** A patch's lines (section 3): split at \n, one trailing \r removed each, no empty piece after a final \n. */
function splitPatch(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

/** A safe path (section 3). */
function isSafePath(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

function leadingWs(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
}

/** A file as lines: its line break, its lines, and whether it ends with a break (section 3). */
interface FileDoc {
  lines: string[];
  br: string;
  final: boolean;
}

function readDoc(text: string): FileDoc {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const lines = text.split(br);
  const final = text.endsWith(br);
  if (final) lines.pop();
  return { lines, br, final };
}

function writeDoc(doc: FileDoc): string {
  if (doc.lines.length === 0) return '';
  return doc.lines.join(doc.br) + (doc.final ? doc.br : '');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: Array<[string, string]> = [];

  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p) as string | null;
  }

  get(p: string): string | null {
    return this.now.has(p) ? (this.now.get(p) as string | null) : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

/** One line of the replacement text: a context line names its index in O, a new line has ctx null (section 5). */
interface NewLine {
  text: string;
  ctx: number | null;
}

/** A line at a matching tier (section 5). */
function normLine(line: string, tier: number): string {
  if (tier === 0) return line;
  if (tier === 1) return line.replace(/[ \t]+$/, '');
  return line.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

/** Every position where O occurs in lines at a tier, from `from` on; with eofOnly only the one ending at the last line. */
function occurrences(O: string[], lines: string[], tier: number, from = 0, eofOnly = false): number[] {
  const out: number[] = [];
  const normed = O.map((l) => normLine(l, tier));
  const last = lines.length - O.length;
  const at = (i: number): boolean => {
    for (let j = 0; j < O.length; j++) {
      if (normLine(lines[i + j], tier) !== normed[j]) return false;
    }
    return true;
  };
  if (eofOnly) {
    if (last >= from && at(last)) out.push(last);
    return out;
  }
  for (let i = from; i <= last; i++) {
    if (at(i)) out.push(i);
  }
  return out;
}

/** The first tier at which O occurs (from `from` on), with its occurrences; null when no tier has one. */
function findTier(O: string[], lines: string[], strict: boolean, from = 0, eofOnly = false): { tier: number; occ: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const occ = occurrences(O, lines, t, from, eofOnly);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

/** Render N at a match: context lines are the file's own matched lines; at tier 2 other lines are re-indented. */
function renderNew(N: NewLine[], O: string[], fileLines: string[], at: number, tier: number): string[] {
  const pfx = tier === 2 ? leadingWs(O[0]) : '';
  const fix = tier === 2 ? leadingWs(fileLines[at]) : '';
  return N.map((nl) => {
    if (nl.ctx !== null) return fileLines[at + nl.ctx];
    if (tier === 2 && nl.text.trim() !== '' && nl.text.startsWith(pfx)) return fix + nl.text.slice(pfx.length);
    return nl.text;
  });
}

/** Format detection (section 4). */
function detectFormat(lines: string[]): string | null {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) return null;
  if (lines[first].trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first].trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

// ---------------------------------------------------------------------------
// JSON edits (section 9)
// ---------------------------------------------------------------------------

function jsonObjectEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const requireFile = (tree: Tree): string => {
    if (!isSafePath(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create') {
    if (typeof o.file_text !== 'string') return null;
    const text = o.file_text;
    return (tree) => {
      if (!isSafePath(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace') {
    if (typeof o.old_str !== 'string' || o.old_str === '') return null;
    if (o.new_str !== undefined && typeof o.new_str !== 'string') return null;
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = requireFile(tree);
      const crlf = readDoc(before).br === '\r\n';
      const flat = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = flat(before);
      const old = flat(oldStr);
      let count = 0;
      let at = -1;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) {
        if (at < 0) at = k;
        count += 1;
      }
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const out = t.slice(0, at) + flat(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert') {
    if (typeof o.insert_line !== 'number' || !Number.isInteger(o.insert_line)) return null;
    if (typeof o.new_str !== 'string') return null;
    const line = o.insert_line;
    const add = splitPatch(o.new_str);
    return (tree) => {
      const before = requireFile(tree);
      const doc = readDoc(before);
      if (line < 0 || line > doc.lines.length) throw new Fail('no-match', p);
      doc.lines.splice(line, 0, ...add);
      tree.now.set(p, writeDoc(doc));
    };
  }
  return null;
}

function parseJson(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first].trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonObjectEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (isBlank(l)) continue;
    let e: Edit | null = null;
    try {
      e = jsonObjectEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  }
  return edits;
}

// ---------------------------------------------------------------------------
// Unified diffs (section 6)
// ---------------------------------------------------------------------------

interface Hunk {
  a: number;
  oldLines: string[];
  newLines: NewLine[];
  hasPlus: boolean;
  lastPlusBs: boolean;
  lastCtxPlusBs: boolean;
}

/** A hunk from its body lines: context and `-` lines are O, context and `+` lines are N. */
function buildHunk(a: number, body: string[]): Hunk {
  const oldLines: string[] = [];
  const newLines: NewLine[] = [];
  let hasPlus = false;
  let lastPlusBs = false;
  let lastCtxPlusBs = false;
  for (let k = 0; k < body.length; k++) {
    const b = body[k];
    const next = body[k + 1];
    const bsAfter = next !== undefined && next.startsWith('\\');
    if (b === '' || b[0] === ' ') {
      const text = b === '' ? '' : b.slice(1);
      oldLines.push(text);
      newLines.push({ text, ctx: oldLines.length - 1 });
      lastCtxPlusBs = bsAfter;
    } else if (b[0] === '-') {
      oldLines.push(b.slice(1));
    } else if (b[0] === '+') {
      newLines.push({ text: b.slice(1), ctx: null });
      hasPlus = true;
      lastPlusBs = bsAfter;
      lastCtxPlusBs = bsAfter;
    }
    // A `\` line refers to the body line before it; its presence is recorded above.
  }
  return { a, oldLines, newLines, hasPlus, lastPlusBs, lastCtxPlusBs };
}

/** The path after `--- ` or `+++ `: up to the first tab, surrounding spaces removed, a leading a/ or b/ removed. */
function dashPath(line: string): string | null {
  let p = line.slice(4);
  const tab = p.indexOf('\t');
  if (tab >= 0) p = p.slice(0, tab);
  p = p.trim();
  if (p === '/dev/null') return null;
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

interface UniSection {
  diffOld: string | null;
  diffNew: string | null;
  dashOld: string | null | undefined;
  dashNew: string | null | undefined;
  renameOld: string | undefined;
  renameNew: string | undefined;
  sawDash: boolean;
  isNew: boolean;
  isDel: boolean;
  hunks: Hunk[];
}

function newUniSection(diffOld: string | null, diffNew: string | null): UniSection {
  return { diffOld, diffNew, dashOld: undefined, dashNew: undefined, renameOld: undefined, renameNew: undefined, sawDash: false, isNew: false, isDel: false, hunks: [] };
}

/** Apply a section's hunks in order to a file, tracking the drift d and the final line break. */
function applyHunks(doc: FileDoc, hunks: Hunk[], strict: boolean, path: string): void {
  let d = 0;
  for (const h of hunks) {
    if (h.oldLines.length === 0) {
      const at = Math.min(Math.max(h.a + d, 0), doc.lines.length);
      const ins = h.newLines.map((nl) => nl.text);
      doc.lines.splice(at, 0, ...ins);
      if (at === doc.lines.length - ins.length) doc.final = !h.lastCtxPlusBs;
    } else {
      const found = findTier(h.oldLines, doc.lines, strict);
      if (found === null) throw new Fail('no-match', path);
      const target = h.a - 1 + d;
      let best = found.occ[0];
      for (const o of found.occ) {
        if (Math.abs(o - target) < Math.abs(best - target)) best = o;
      }
      const ranToEnd = best + h.oldLines.length === doc.lines.length;
      const replacement = renderNew(h.newLines, h.oldLines, doc.lines, best, found.tier);
      doc.lines.splice(best, h.oldLines.length, ...replacement);
      if (ranToEnd) doc.final = !h.lastCtxPlusBs;
    }
    d += h.newLines.length - h.oldLines.length;
  }
}

function unifiedEdit(sec: UniSection, strict: boolean): Edit {
  const oldP = sec.dashOld !== undefined ? sec.dashOld : sec.renameOld !== undefined ? sec.renameOld : sec.diffOld;
  const newP = sec.dashNew !== undefined ? sec.dashNew : sec.renameNew !== undefined ? sec.renameNew : sec.diffNew;
  if (sec.isNew || oldP === null) {
    const hunks = sec.hunks;
    return (tree) => {
      if (newP === null) throw new Fail('unsafe', '');
      if (!isSafePath(newP)) throw new Fail('unsafe', newP);
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const plus: string[] = [];
      let endsBreak = true;
      for (const h of hunks) {
        for (const nl of h.newLines) {
          if (nl.ctx === null) plus.push(nl.text);
        }
        if (h.hasPlus) endsBreak = !h.lastPlusBs;
      }
      tree.now.set(newP, plus.length === 0 ? '' : plus.join('\n') + (endsBreak ? '\n' : ''));
    };
  }
  if (sec.isDel || newP === null) {
    return (tree) => {
      if (oldP === null) throw new Fail('unsafe', '');
      if (!isSafePath(oldP)) throw new Fail('unsafe', oldP);
      if (tree.get(oldP) === null) throw new Fail('missing', oldP);
      tree.now.set(oldP, null);
    };
  }
  if (oldP !== newP) {
    const hunks = sec.hunks;
    return (tree) => {
      if (!isSafePath(oldP)) throw new Fail('unsafe', oldP);
      if (!isSafePath(newP)) throw new Fail('unsafe', newP);
      const t = tree.get(oldP);
      if (t === null) throw new Fail('missing', oldP);
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const doc = readDoc(t);
      applyHunks(doc, hunks, strict, oldP);
      tree.now.set(oldP, null);
      tree.now.set(newP, writeDoc(doc));
      tree.moves.push([oldP, newP]);
    };
  }
  const hunks = sec.hunks;
  return (tree) => {
    if (!isSafePath(oldP)) throw new Fail('unsafe', oldP);
    const t = tree.get(oldP);
    if (t === null) throw new Fail('missing', oldP);
    const doc = readDoc(t);
    applyHunks(doc, hunks, strict, oldP);
    tree.now.set(oldP, writeDoc(doc));
  };
}

function parseUnified(lines: string[], strict: boolean): Edit[] {
  const sections: UniSection[] = [];
  let cur: UniSection | null = null;
  let inHeader = false;
  let i = 0;
  while (i < lines.length) {
    const l = lines[i];
    if (l.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.+) b\/(.+)$/.exec(l);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      cur = newUniSection(m[1], m[2]);
      sections.push(cur);
      inHeader = true;
      i += 1;
      continue;
    }
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (cur !== null && inHeader && !cur.sawDash) {
        cur.dashOld = dashPath(l);
        cur.dashNew = dashPath(lines[i + 1]);
        cur.sawDash = true;
      } else {
        cur = newUniSection(null, null);
        sections.push(cur);
        cur.dashOld = dashPath(l);
        cur.dashNew = dashPath(lines[i + 1]);
        cur.sawDash = true;
        inHeader = true;
      }
      i += 2;
      continue;
    }
    if (l.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(l);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const body: string[] = [];
      let j = i + 1;
      while (j < lines.length) {
        const b = lines[j];
        // The body ends at a `--- ` line followed by a `+++ ` line: a new section starts there.
        if (b.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
        if (b === '' || b[0] === ' ' || b[0] === '-' || b[0] === '+' || b[0] === '\\') {
          body.push(b);
          j += 1;
        } else break;
      }
      while (body.length > 0 && body[body.length - 1] === '') body.pop();
      cur.hunks.push(buildHunk(parseInt(m[1], 10), body));
      inHeader = false;
      i = j;
      continue;
    }
    if (cur !== null && inHeader) {
      if (l.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
      if (l.startsWith('+++ ')) {
        cur.dashNew = dashPath(l);
        i += 1;
        continue;
      }
      if (l.startsWith('rename from ')) {
        cur.renameOld = l.slice(12).trim();
        i += 1;
        continue;
      }
      if (l.startsWith('rename to ')) {
        cur.renameNew = l.slice(10).trim();
        i += 1;
        continue;
      }
      if (l.startsWith('new file mode')) {
        cur.isNew = true;
        i += 1;
        continue;
      }
      if (l.startsWith('deleted file mode')) {
        cur.isDel = true;
        i += 1;
        continue;
      }
      i += 1;
      continue;
    }
    i += 1;
  }
  return sections.map((s) => unifiedEdit(s, strict));
}

// ---------------------------------------------------------------------------
// SEARCH/REPLACE blocks (section 7)
// ---------------------------------------------------------------------------

function searchReplaceEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  const news: NewLine[] = newLines.map((text) => ({ text, ctx: null }));
  return (tree) => {
    if (!isSafePath(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const t = tree.get(path);
    if (t === null) throw new Fail('missing', path);
    const doc = readDoc(t);
    const found = findTier(oldLines, doc.lines, strict);
    if (found === null) throw new Fail('no-match', path);
    if (found.occ.length > 1) throw new Fail('ambiguous', path);
    const at = found.occ[0];
    const replacement = renderNew(news, oldLines, doc.lines, at, found.tier);
    doc.lines.splice(at, oldLines.length, ...replacement);
    tree.now.set(path, writeDoc(doc));
  };
}

function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevPath: string | null = null;
  let prevEnd = 0;
  let i = 0;
  while (i < lines.length) {
    if (lines[i].trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchIdx = i;
    let path: string | null = null;
    for (let j = searchIdx - 1; j >= prevEnd; j--) {
      const l = lines[j];
      if (isBlank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new Exit2(`error: parse ${searchIdx + 1}`);
    let eq = -1;
    for (let j = searchIdx + 1; j < lines.length; j++) {
      if (lines[j].trimEnd() === '=======') {
        eq = j;
        break;
      }
    }
    let rep = -1;
    if (eq >= 0) {
      for (let j = eq + 1; j < lines.length; j++) {
        if (lines[j].trimEnd() === '>>>>>>> REPLACE') {
          rep = j;
          break;
        }
      }
    }
    if (eq < 0 || rep < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);
    edits.push(searchReplaceEdit(path, lines.slice(searchIdx + 1, eq), lines.slice(eq + 1, rep), strict));
    prevPath = path;
    prevEnd = rep + 1;
    i = rep + 1;
  }
  return edits;
}

// ---------------------------------------------------------------------------
// V4A patches (section 8)
// ---------------------------------------------------------------------------

interface V4aChunk {
  anchor: string | null;
  oldLines: string[];
  newLines: NewLine[];
  eof: boolean;
}

function v4aAddEdit(path: string, fileLines: string[]): Edit {
  return (tree) => {
    if (!isSafePath(path)) throw new Fail('unsafe', path);
    if (tree.get(path) !== null) throw new Fail('exists', path);
    tree.now.set(path, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
  };
}

function v4aDeleteEdit(path: string): Edit {
  return (tree) => {
    if (!isSafePath(path)) throw new Fail('unsafe', path);
    if (tree.get(path) === null) throw new Fail('missing', path);
    tree.now.set(path, null);
  };
}

function v4aUpdateEdit(path: string, moveTo: string | null, chunks: V4aChunk[], strict: boolean): Edit {
  return (tree) => {
    if (!isSafePath(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !isSafePath(moveTo)) throw new Fail('unsafe', moveTo);
    const t = tree.get(path);
    if (t === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const doc = readDoc(t);
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null) {
        let at = -1;
        const tiers = strict ? [0] : [0, 1, 2];
        for (const tier of tiers) {
          for (let j = cursor; j < doc.lines.length; j++) {
            if (normLine(doc.lines[j], tier) === normLine(ch.anchor, tier)) {
              at = j;
              break;
            }
          }
          if (at >= 0) break;
        }
        if (at < 0) throw new Fail('no-match', path);
        cursor = at + 1;
      }
      if (ch.oldLines.length === 0) {
        const at = ch.eof ? doc.lines.length : cursor;
        const ins = ch.newLines.map((nl) => nl.text);
        doc.lines.splice(at, 0, ...ins);
        cursor = at + ins.length;
      } else {
        const found = findTier(ch.oldLines, doc.lines, strict, cursor, ch.eof);
        if (found === null) throw new Fail('no-match', path);
        const at = found.occ[0];
        const replacement = renderNew(ch.newLines, ch.oldLines, doc.lines, at, found.tier);
        doc.lines.splice(at, ch.oldLines.length, ...replacement);
        cursor = at + replacement.length;
      }
    }
    const out = writeDoc(doc);
    if (moveTo !== null) {
      tree.now.set(path, null);
      tree.now.set(moveTo, out);
      tree.moves.push([path, moveTo]);
    } else {
      tree.now.set(path, out);
    }
  };
}

const v4aSectionStart = (l: string): boolean => l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');

function parseV4a(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first].trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = lines.length - 1;
  while (last >= 0 && isBlank(lines[last])) last -= 1;
  if (lines[last].trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const l = lines[i];
    if (isBlank(l)) {
      i += 1;
      continue;
    }
    if (l.startsWith('*** Add File: ')) {
      const path = l.slice(14).trim();
      const body: string[] = [];
      let j = i + 1;
      while (j < last && !v4aSectionStart(lines[j])) {
        body.push(lines[j]);
        j += 1;
      }
      while (body.length > 0 && isBlank(body[body.length - 1])) body.pop();
      const fileLines: string[] = [];
      for (let k = 0; k < body.length; k++) {
        const b = body[k];
        if (b.startsWith('+')) fileLines.push(b.slice(1));
        else if (b === '') fileLines.push('');
        else throw new Exit2(`error: parse ${i + 2 + k}`);
      }
      edits.push(v4aAddEdit(path, fileLines));
      i = j;
      continue;
    }
    if (l.startsWith('*** Delete File: ')) {
      const path = l.slice(17).trim();
      let j = i + 1;
      while (j < last && !v4aSectionStart(lines[j])) {
        if (!isBlank(lines[j])) throw new Exit2(`error: parse ${j + 1}`);
        j += 1;
      }
      edits.push(v4aDeleteEdit(path));
      i = j;
      continue;
    }
    if (l.startsWith('*** Update File: ')) {
      const path = l.slice(17).trim();
      const body: string[] = [];
      let j = i + 1;
      while (j < last && !v4aSectionStart(lines[j])) {
        body.push(lines[j]);
        j += 1;
      }
      while (body.length > 0 && isBlank(body[body.length - 1])) body.pop();
      let moveTo: string | null = null;
      let k = 0;
      if (body.length > 0 && body[0].startsWith('*** Move to: ')) {
        moveTo = body[0].slice(13).trim();
        k = 1;
      }
      const chunks: V4aChunk[] = [];
      let cur: V4aChunk | null = null;
      for (; k < body.length; k++) {
        const b = body[k];
        if (b.startsWith('@@')) {
          if (cur !== null) chunks.push(cur);
          const anchor = b.slice(2).trim();
          cur = { anchor: anchor === '' ? null : anchor, oldLines: [], newLines: [], eof: false };
          continue;
        }
        if (b === '*** End of File') {
          if (cur !== null) {
            cur.eof = true;
            chunks.push(cur);
            cur = null;
          }
          continue;
        }
        if (b === '' || b[0] === ' ' || b[0] === '-' || b[0] === '+') {
          if (cur === null) cur = { anchor: null, oldLines: [], newLines: [], eof: false };
          if (b === '' || b[0] === ' ') {
            const text = b === '' ? '' : b.slice(1);
            cur.oldLines.push(text);
            cur.newLines.push({ text, ctx: cur.oldLines.length - 1 });
          } else if (b[0] === '-') {
            cur.oldLines.push(b.slice(1));
          } else {
            cur.newLines.push({ text: b.slice(1), ctx: null });
          }
          continue;
        }
        throw new Exit2(`error: parse ${i + 2 + k}`);
      }
      if (cur !== null) chunks.push(cur);
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${i + 1}`);
      edits.push(v4aUpdateEdit(path, moveTo, chunks, strict));
      i = j;
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  return edits;
}

// ---------------------------------------------------------------------------
// The command line (sections 1, 2, 10)
// ---------------------------------------------------------------------------

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') {
      ended = true;
      continue;
    }
    if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
      continue;
    }
    pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0];
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = splitPatch(text);
  const kind = format === null || format === 'auto' ? detectFormat(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = parseJson(text, lines);
    else if (kind === 'unified') edits = parseUnified(lines, strict);
    else if (kind === 'search-replace') edits = parseSearchReplace(lines, strict);
    else edits = parseV4a(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const snap = new Map(tree.now);
    const movesLen = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of snap) tree.now.set(k, v);
      tree.moves.length = movesLen;
      fails.push(e);
    }
  }
  if (fails.length > 0) {
    return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  }
  const changed = new Map<string, { was: string | null; now: string | null }>();
  for (const p of tree.now.keys()) {
    const was = tree.original(p);
    const now = tree.now.get(p) as string | null;
    if (was !== now) changed.set(p, { was, now });
  }
  const rows: Array<{ key: string; text: string }> = [];
  const claimed = new Set<string>();
  for (const [o, n] of tree.moves) {
    const oc = changed.get(o);
    const nc = changed.get(n);
    if (oc !== undefined && oc.was !== null && oc.now === null && nc !== undefined && nc.was === null && nc.now !== null && !claimed.has(o) && !claimed.has(n)) {
      rows.push({ key: n, text: `R ${o} -> ${n}` });
      claimed.add(o);
      claimed.add(n);
    }
  }
  for (const [p, c] of changed) {
    if (claimed.has(p)) continue;
    rows.push({ key: p, text: `${c.was === null ? 'A' : c.now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  if (!check) {
    for (const [p, c] of changed) {
      if (c.now === null) rmSync(p, { force: true });
    }
    for (const p of [...changed.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
      const c = changed.get(p) as { was: string | null; now: string | null };
      if (c.now === null) continue;
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, c.now);
    }
  }
  return { code: 0, out: [...rows.map((r) => r.text), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
