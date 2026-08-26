// Importing the package's own index.js triggers a known pdf-parse bug: its
// debug-mode check misfires outside a direct CLI invocation and tries to
// read a bundled test fixture off disk. Importing the internal lib file
// sidesteps it entirely — this is the standard workaround.
import pdfParseModule from 'pdf-parse/lib/pdf-parse.js';
const pdfParse = pdfParseModule.default || pdfParseModule;

const TEXT_MIME_TYPES = new Set(['text/plain', 'text/csv']);
const MAX_EXTRACT_CHARS = 8000;

export function isSupportedDocumentType(mimeType) {
  return mimeType === 'application/pdf' || TEXT_MIME_TYPES.has(mimeType) || Boolean(mimeType?.startsWith('text/'));
}

/**
 * extractTextFromDocument — spec §16's document/dataset intake: identify
 * what this is, pull out readable text, then let the same text-based AI
 * classifier used for "Tell Blue Mind" propose an event from it. Returns
 * null for anything unsupported rather than throwing, so the caller can
 * give the contributor a clear "try a PDF, CSV, or text file" message.
 */
export async function extractTextFromDocument(buffer, mimeType) {
  if (mimeType === 'application/pdf') {
    const data = await pdfParse(buffer);
    return (data.text || '').trim().slice(0, MAX_EXTRACT_CHARS);
  }
  if (TEXT_MIME_TYPES.has(mimeType) || mimeType?.startsWith('text/')) {
    return buffer.toString('utf8').trim().slice(0, MAX_EXTRACT_CHARS);
  }
  return null;
}
