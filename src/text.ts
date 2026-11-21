// Text helpers with no browser or PDF-library dependencies, so they can be unit tested.

const squash = (s: string) => s.replace(/\s+/g, '');

/**
 * Where a quote sits in a page's text. Stored offsets are trusted when the
 * text there still matches; otherwise the quote is searched for. Whitespace is
 * ignored throughout, because the quote is stored as the reader saw it while
 * the page text has no spaces where lines break.
 */
export function locate(all: string, start: number, end: number, quote: string): [number, number] | null {
  const wanted = squash(quote);
  if (!wanted) return null;
  if (squash(all.slice(start, end)) === wanted) return [start, end];
  // Map each non-space character of the page back to its index.
  const index: number[] = [];
  let compact = '';
  for (let i = 0; i < all.length; i++) {
    if (!/\s/.test(all[i])) {
      index.push(i);
      compact += all[i];
    }
  }
  const at = compact.indexOf(wanted);
  return at < 0 ? null : [index[at], index[at + wanted.length - 1] + 1];
}

/** Turns a link to a paper's landing page into a link to its PDF where the pattern is known. */
export function pdfUrlOf(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (!/^https?:$/.test(u.protocol)) return null;
  if (/(^|\.)arxiv\.org$/.test(u.hostname)) {
    const m = u.pathname.match(/^\/(?:abs|pdf|html)\/(.+?)(?:\.pdf)?$/);
    if (m) return `https://arxiv.org/pdf/${m[1]}`;
  }
  if (/\.pdf$/i.test(u.pathname)) return u.toString();
  return null;
}

const VENUES = 'NeurIPS|NIPS|ICML|ICLR|CVPR|ICCV|ECCV|ACL|EMNLP|NAACL|AAAI|IJCAI|KDD|SIGGRAPH|CoRL|RSS|ICRA|IROS|UAI|AISTATS|COLT|TMLR|JMLR|TACL|WWW|SIGIR|CHI|UIST|OSDI|SOSP|NSDI|PLDI|POPL|Nature|Science';

/** The venue and year printed on the first page, falling back to the year in an arXiv identifier. */
export function whenAndWhere(text: string, url?: string): { year?: string; venue?: string } {
  const venue = text.match(new RegExp(`\\b(${VENUES})\\b[\\s,'’(]*((?:19|20)\\d{2}|\\d{2})\\b`));
  if (venue) return { venue: venue[1] === 'NIPS' ? 'neurips' : venue[1].toLowerCase(), year: venue[2].slice(-2) };
  // New-style arXiv identifiers start with the year and month the paper was first submitted.
  const arxiv = `${url ?? ''} ${text}`.match(/(?:arxiv\.org\/(?:abs|pdf)\/|arXiv:)(\d{2})(\d{2})\.\d{4,5}/i);
  if (arxiv && Number(arxiv[2]) >= 1 && Number(arxiv[2]) <= 12) return { venue: 'arxiv', year: arxiv[1] };
  return {};
}

/** "Vaswani17neurips - Attention Is All You Need", with whatever parts are known. */
export function paperLabel(d: { title?: string; author?: string; year?: string; venue?: string }, fallback: string): string {
  const title = d.title ?? fallback;
  if (!d.author) return title;
  const last = d.author.trim().split(/\s+/).pop()!;
  return `${last}${d.year ?? ''}${d.year ? d.venue ?? '' : ''} - ${title}`;
}

/**
 * Every place `query` occurs in `text`, as [start, end) offsets. Case and
 * whitespace are ignored: a PDF page's text has no spaces where lines break,
 * so "attention mechanism" must also match "attention" at the end of one line
 * followed by "mechanism" on the next.
 */
export function findAll(text: string, query: string, limit = 2000): [number, number][] {
  const wanted = squash(query).toLowerCase();
  if (!wanted) return [];
  const index: number[] = [];
  let compact = '';
  for (let i = 0; i < text.length; i++) {
    if (/\s/.test(text[i])) continue;
    index.push(i);
    // A few letters change length when lower-cased; keep those as they are so the offsets stay true.
    const lower = text[i].toLowerCase();
    compact += lower.length === 1 ? lower : text[i];
  }
  const out: [number, number][] = [];
  for (let at = compact.indexOf(wanted); at >= 0 && out.length < limit; at = compact.indexOf(wanted, at + wanted.length)) {
    out.push([index[at], index[at + wanted.length - 1] + 1]);
  }
  return out;
}

/**
 * How well a file's path matches what was typed, or -1 when it does not: every
 * typed letter must appear in order; letters in the file's own name, at the
 * start of a word, and next to each other count for more.
 */
export function fuzzyScore(path: string, typed: string): number {
  const text = path.toLowerCase();
  const query = typed.toLowerCase().replace(/\s+/g, '');
  if (!query) return 0;
  const nameAt = text.lastIndexOf('/') + 1;
  let score = 0;
  let from = 0;
  let last = -2;
  for (const ch of query) {
    const at = text.indexOf(ch, from);
    if (at < 0) return -1;
    score += 1;
    if (at === last + 1) score += 3;
    if (at >= nameAt) score += 2;
    if (at === 0 || '/._-'.includes(text[at - 1])) score += 3;
    last = at;
    from = at + 1;
  }
  return score - text.length / 200;
}

export interface DiffLine {
  kind: 'same' | 'add' | 'drop';
  text: string;
}

/**
 * The lines of `before` and `after` set against each other: kept, dropped or
 * added, in reading order. Unchanged stretches longer than a few lines around
 * a change are left out, each marked by one line of dots.
 */
export function lineDiff(before: string, after: string, context = 3): DiffLine[] {
  const a = before ? before.split('\n') : [];
  const b = after ? after.split('\n') : [];
  // The longest run of lines common to both, found from the end so it can be read off from the start.
  const width = b.length + 1;
  const table = new Uint32Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i * width + j] = a[i] === b[j] ? table[(i + 1) * width + j + 1] + 1 : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
    }
  }
  const all: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) all.push({ kind: 'same', text: a[i++] }), j++;
    else if (j < b.length && (i >= a.length || table[i * width + j + 1] > table[(i + 1) * width + j])) all.push({ kind: 'add', text: b[j++] });
    else all.push({ kind: 'drop', text: a[i++] });
  }
  if (!all.some((line) => line.kind !== 'same')) return all;
  const keep = all.map((line, at) => line.kind !== 'same' || all.slice(Math.max(0, at - context), at + context + 1).some((near) => near.kind !== 'same'));
  const out: DiffLine[] = [];
  all.forEach((line, at) => {
    if (keep[at]) out.push(line);
    else if (at === 0 || keep[at - 1]) out.push({ kind: 'same', text: '…' });
  });
  return out;
}
