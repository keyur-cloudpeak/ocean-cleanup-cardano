import { isAiConfigured, inferEventFromImage, inferEventFromText, inferEventFromVoice, logAiInference, chatWithBlueMind } from '../services/aiInferenceService.js';
import { isSupportedDocumentType, extractTextFromDocument } from '../services/documentService.js';
import asyncHandler from '../middleware/asyncHandler.js';

// Helper: convert a base64 data URI → { base64, mimeType }, or fall back
// to treating the input as already-bare base64 if it has no data: prefix.
function parseDataUri(value, fallbackMimeType) {
  const match = value.match(/^data:([^;]+);base64,(.+)$/);
  if (match) return { mimeType: match[1], base64: match[2] };
  return { mimeType: fallbackMimeType, base64: value };
}

/**
 * POST /api/ai/infer
 * Body: { imageBase64?: string, audioBase64?: string, documentBase64?: string, text?: string }
 * Exactly one of these is expected. Returns a draft classification for
 * the contributor to confirm or correct — never something committed on
 * its own. For audio the response carries a transcript; for a document
 * it carries the extracted text — either way, spec §16-17's "retain the
 * original, never let AI silently replace it" principle.
 */
async function infer(req, res) {
  if (!isAiConfigured()) {
    return res.status(503).json({ ok: false, error: 'AI classification is not configured on this server yet.' });
  }

  const { imageBase64, audioBase64, documentBase64, text } = req.body;
  if (!imageBase64 && !audioBase64 && !documentBase64 && !(text && text.trim())) {
    return res.status(400).json({ ok: false, error: 'Provide imageBase64, audioBase64, documentBase64, or text.' });
  }

  let inference;
  let inputType;
  if (imageBase64) {
    inputType = 'image';
    const { base64, mimeType } = parseDataUri(imageBase64, 'image/jpeg');
    inference = await inferEventFromImage(base64, mimeType);
  } else if (audioBase64) {
    inputType = 'audio';
    const { base64, mimeType } = parseDataUri(audioBase64, 'audio/webm');
    inference = await inferEventFromVoice(base64, mimeType);
  } else if (documentBase64) {
    inputType = 'document';
    const { base64, mimeType } = parseDataUri(documentBase64, 'application/octet-stream');
    if (!isSupportedDocumentType(mimeType)) {
      return res.status(400).json({ ok: false, error: 'Unsupported document type. Try a PDF, CSV, or plain text file.' });
    }
    const extractedText = await extractTextFromDocument(Buffer.from(base64, 'base64'), mimeType);
    if (!extractedText) {
      return res.status(400).json({ ok: false, error: "Couldn't find any readable text in that document." });
    }
    const textInference = await inferEventFromText(extractedText);
    inference = textInference ? { ...textInference, extractedText } : null;
  } else {
    inputType = 'text';
    inference = await inferEventFromText(text.trim());
  }

  if (!inference) {
    return res.status(503).json({ ok: false, error: 'AI classification is not configured on this server yet.' });
  }

  await logAiInference({ requestedBy: req.user?.id, inputType, inference });

  res.json({ ok: true, inference });
}

async function chat(req, res) {
  const { messages } = req.body;
  if (!Array.isArray(messages)) {
    return res.status(400).json({ ok: false, error: 'messages must be an array.' });
  }

  const reply = await chatWithBlueMind(messages);
  if (!reply) {
    return res.status(503).json({ ok: false, error: 'AI chat is not configured on this server yet.' });
  }

  return res.json({ ok: true, reply });
}

export default {
  infer: asyncHandler(infer),
  chat: asyncHandler(chat)
};
