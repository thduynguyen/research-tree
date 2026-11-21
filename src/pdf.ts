import * as pdfjs from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { db } from './db';
import { fetchThroughHelper, hasFolder, readWorkspaceFile, WORKSPACE } from './folder';
import type { DocRef } from './types';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

export type PdfDocument = pdfjs.PDFDocumentProxy;
export { pdfjs };
export { pdfUrlOf } from './text';
import { paperLabel, whenAndWhere } from './text';

export interface OpenedPdf {
  pdf: PdfDocument;
  fingerprint: string;
  /** A readable name for the paper, when one could be worked out. */
  title: string | undefined;
  pages: number;
}

/** Parses a PDF. The bytes are copied first because the library takes ownership of what it is given. */
export async function openPdf(data: ArrayBuffer, url?: string): Promise<OpenedPdf> {
  const pdf = await pdfjs.getDocument({ data: new Uint8Array(data.slice(0)) }).promise;
  const info = (await pdf.getMetadata().catch(() => null))?.info as { Title?: string; Author?: string } | undefined;
  const seen = await describe(pdf, url).catch(() => ({}) as Awaited<ReturnType<typeof describe>>);
  const title = info?.Title?.trim() || seen.title;
  const author = seen.author ?? firstName(info?.Author ?? '');
  const label = title ? paperLabel({ ...seen, title, author }, title) : undefined;
  return { pdf, fingerprint: pdf.fingerprints[0] ?? '', title: label, pages: pdf.numPages };
}

/** What can be read off a paper's first page (and its link) to name it. */
async function describe(pdf: PdfDocument, url?: string): Promise<{ title?: string; author?: string; year?: string; venue?: string }> {
  const content = await (await pdf.getPage(1)).getTextContent();
  // Upright text only: arXiv prints its identifier up the left margin in large type.
  const items = content.items.flatMap((item) =>
    'str' in item && item.str.trim() ? [{ text: item.str.trim(), size: item.height, upright: Math.abs(item.transform[1]) < Math.abs(item.transform[0]) * 0.1 }] : [],
  );
  const upright = items.filter((i) => i.upright);
  // Many papers carry no title in their metadata: take the largest text on the page.
  const largest = Math.max(0, ...upright.map((i) => i.size));
  const titleItems = upright.filter((i) => i.size > largest * 0.97);
  const title = titleItems.map((i) => i.text).join(' ').replace(/\s+/g, ' ').trim();
  // The first author is the first thing after the title that reads like a person's name.
  const after = upright.slice(upright.indexOf(titleItems[titleItems.length - 1]) + 1, upright.indexOf(titleItems[titleItems.length - 1]) + 12);
  const author = after.map((i) => firstName(i.text)).find(Boolean);
  const text = items.map((i) => i.text).join(' ');
  return { title: title.length >= 4 && title.length <= 200 ? title : undefined, author, ...whenAndWhere(text, url) };
}

/** The whole-page text of an author line can list several people; returns the first, cleaned of footnote marks. */
function firstName(text: string): string | undefined {
  const first = text.split(/,| and |;|·/)[0].replace(/[^\p{L}\s.'-]/gu, '').trim();
  const words = first.split(/\s+/);
  const nameLike = words.length >= 2 && words.length <= 4 && words.every((w) => /^\p{Lu}[\p{L}.'-]*$/u.test(w));
  const stop = /^(Abstract|Introduction|Google|University|Institute|Department|Research|Under Review|Published)/i;
  return nameLike && !stop.test(first) ? first : undefined;
}

/** The text of each page, in reading order as far as the PDF records it, for the model's context. */
export async function extractText(pdf: PdfDocument): Promise<string[]> {
  const pages: string[] = [];
  for (let n = 1; n <= pdf.numPages; n++) {
    const content = await (await pdf.getPage(n)).getTextContent();
    pages.push(
      content.items
        .map((item) => ('str' in item ? item.str + (item.hasEOL ? '\n' : '') : ''))
        .join(''),
    );
  }
  return pages;
}

/**
 * Downloads a PDF. This only works for sites that allow other pages to read
 * their files (arXiv does); for the rest the browser blocks it, and the reader
 * asks for the downloaded file instead.
 */
export async function fetchPdf(url: string): Promise<ArrayBuffer> {
  if (url.startsWith(WORKSPACE)) return readWorkspaceFile(url.slice(WORKSPACE.length));
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`The server answered ${res.status}.`);
    return await res.arrayBuffer();
  } catch (e) {
    // Most sites do not let a page read their files; a local server, when there is one, can fetch it instead.
    if (!hasFolder()) throw e;
    return fetchThroughHelper(url);
  }
}

/** Keeps a copy of the PDF on this device, with its text, so it opens instantly and offline. */
export async function storeFile(opened: OpenedPdf, data: ArrayBuffer): Promise<void> {
  if (!opened.fingerprint) return;
  const existing = await db.files.get(opened.fingerprint);
  if (existing?.text) return;
  await db.files.put({ fingerprint: opened.fingerprint, data, text: await extractText(opened.pdf) });
}

export function docRefOf(opened: OpenedPdf, fallbackTitle: string, url?: string): DocRef {
  return { fingerprint: opened.fingerprint, title: opened.title ?? fallbackTitle, url, pages: opened.pages };
}
