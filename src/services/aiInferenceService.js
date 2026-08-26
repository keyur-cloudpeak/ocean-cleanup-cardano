import { env } from '../config/env.js';
import { query } from '../config/connection.js';

const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';
const OPENAI_TRANSCRIBE_URL = 'https://api.openai.com/v1/audio/transcriptions';
const FETCH_TIMEOUT_MS = 20000;

const AUDIO_EXTENSIONS = {
  'audio/webm': 'webm',
  'audio/ogg': 'ogg',
  'audio/mp4': 'm4a',
  'audio/mpeg': 'mp3',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav'
};

export function isAiConfigured() {
  return Boolean(env.openaiApiKey);
}

// Cheap in-process cache — the taxonomy only changes via a schema seed,
// never at runtime, so there's no reason to hit the DB on every inference
// call. Same "fetch once, reuse" spirit as the Redux caching on the
// frontend, just simpler because this is a single process.
let taxonomyCache = null;

async function getTaxonomy() {
  if (taxonomyCache) return taxonomyCache;
  const { rows } = await query(
    `SELECT family, code, label FROM subjects WHERE is_active = true ORDER BY family, code`
  );
  taxonomyCache = rows;
  return rows;
}

function taxonomyPromptBlock(taxonomy) {
  const byFamily = new Map();
  for (const row of taxonomy) {
    if (!byFamily.has(row.family)) byFamily.set(row.family, []);
    byFamily.get(row.family).push(`${row.code} (${row.label})`);
  }
  return [...byFamily.entries()]
    .map(([family, codes]) => `${family}: ${codes.join(', ')}`)
    .join('\n');
}

const SYSTEM_PROMPT = `You are Blue Mind's environmental event classifier. Blue Mind is a platform where citizens and organizations report ocean/coastal environmental observations — pollution, wildlife, habitat conditions, and cleanup/rescue actions.

Given a photo or a short written description of what someone observed or did, identify which subjects from the taxonomy below apply. A single report can have multiple subjects (e.g. a ghost net AND an entangled turtle AND a reef habitat AND a rescue action all in one report).

Only use family/code pairs that appear verbatim in this taxonomy — never invent a code:
{{TAXONOMY}}

Respond with ONLY a JSON object, no other text, in exactly this shape:
{
  "subjects": [{"family": "pollution_waste", "code": "fishing_gear", "confidence": 0.9}],
  "description": "one plain sentence describing what this shows",
  "quantityEstimateKg": 12.5,
  "missingFields": ["quantity", "location"]
}

Rules:
- "subjects" — 1 to 4 entries, each confidence between 0 and 1, most relevant first.
- "quantityEstimateKg" — only for pollution_waste subjects where a weight is visible/stated; otherwise null. Never guess wildly — if you can't estimate, use null.
- "missingFields" — from this fixed set only: "quantity", "location", "species", "action_taken", "hazard". Include a field only if knowing it would materially improve this specific record.
- If the input is not a genuine environmental observation, return {"subjects": [], "description": "", "quantityEstimateKg": null, "missingFields": []}.`;

function validateInference(raw, taxonomy) {
  if (!raw || typeof raw !== 'object') return null;

  const validPairs = new Set(taxonomy.map((t) => `${t.family}:${t.code}`));
  const subjects = Array.isArray(raw.subjects)
    ? raw.subjects
        .filter((s) => s && validPairs.has(`${s.family}:${s.code}`))
        .slice(0, 4)
        .map((s) => {
          const taxonomyEntry = taxonomy.find((t) => t.family === s.family && t.code === s.code);
          return {
            family: s.family,
            code: s.code,
            label: taxonomyEntry.label,
            confidence: Math.max(0, Math.min(1, Number(s.confidence) || 0))
          };
        })
    : [];

  const allowedMissingFields = new Set(['quantity', 'location', 'species', 'action_taken', 'hazard']);
  const missingFields = Array.isArray(raw.missingFields)
    ? raw.missingFields.filter((f) => allowedMissingFields.has(f))
    : [];

  return {
    subjects,
    description: typeof raw.description === 'string' ? raw.description.slice(0, 500) : '',
    quantityEstimateKg: Number.isFinite(Number(raw.quantityEstimateKg)) ? Number(raw.quantityEstimateKg) : null,
    missingFields
  };
}

async function callOpenAi(messages) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const res = await fetch(OPENAI_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${env.openaiApiKey}`
      },
      body: JSON.stringify({
        model: env.openaiModel,
        response_format: { type: 'json_object' },
        max_tokens: 500,
        messages
      }),
      signal: controller.signal
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`OpenAI request failed (${res.status}): ${body.slice(0, 300)}`);
    }

    const data = await res.json();
    const content = data.choices?.[0]?.message?.content;
    if (!content) throw new Error('OpenAI response had no content');
    return JSON.parse(content);
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * inferEventFromImage — classifies a base64-encoded photo against Blue
 * Mind's subject taxonomy. Returns null if AI isn't configured (caller
 * falls back to manual entry, never blocks submission on this).
 */
export async function inferEventFromImage(base64Image, mimeType) {
  if (!isAiConfigured()) return null;

  const taxonomy = await getTaxonomy();
  const systemPrompt = SYSTEM_PROMPT.replace('{{TAXONOMY}}', taxonomyPromptBlock(taxonomy));

  const raw = await callOpenAi([
    { role: 'system', content: systemPrompt },
    {
      role: 'user',
      content: [
        { type: 'text', text: 'Classify this environmental evidence photo.' },
        { type: 'image_url', image_url: { url: `data:${mimeType};base64,${base64Image}` } }
      ]
    }
  ]);

  return validateInference(raw, taxonomy);
}

/**
 * inferEventFromText — classifies a free-text description the same way.
 */
export async function inferEventFromText(text) {
  if (!isAiConfigured()) return null;

  const taxonomy = await getTaxonomy();
  const systemPrompt = SYSTEM_PROMPT.replace('{{TAXONOMY}}', taxonomyPromptBlock(taxonomy));

  const raw = await callOpenAi([
    { role: 'system', content: systemPrompt },
    { role: 'user', content: `Classify this report: "${text}"` }
  ]);

  return validateInference(raw, taxonomy);
}

/**
 * transcribeAudio — sends a voice note to OpenAI's transcription endpoint
 * (a separate multipart API from the chat completions used elsewhere in
 * this file, hence its own request builder rather than reusing callOpenAi).
 * Returns the transcript text, or null if AI isn't configured.
 */
export async function transcribeAudio(base64Audio, mimeType) {
  if (!isAiConfigured()) return null;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const buffer = Buffer.from(base64Audio, 'base64');
    const extension = AUDIO_EXTENSIONS[mimeType] || 'webm';
    const form = new FormData();
    form.append('file', new Blob([buffer], { type: mimeType || 'audio/webm' }), `voice-note.${extension}`);
    form.append('model', env.openaiTranscribeModel);

    const res = await fetch(OPENAI_TRANSCRIBE_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.openaiApiKey}` },
      body: form,
      signal: controller.signal
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`OpenAI transcription failed (${res.status}): ${body.slice(0, 300)}`);
    }

    const data = await res.json();
    return typeof data.text === 'string' ? data.text.trim() : '';
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * inferEventFromVoice — transcribes a voice note, then classifies the
 * transcript exactly like inferEventFromText, so the two "Tell Blue Mind"
 * input modes (typed or spoken) end up producing the identical shape of
 * draft event. The transcript rides along in the response so the
 * contributor can see and correct what Blue Mind heard before submitting
 * (spec §16: transcribe, then extract — never silently commit either).
 */
export async function inferEventFromVoice(base64Audio, mimeType) {
  if (!isAiConfigured()) return null;

  const transcript = await transcribeAudio(base64Audio, mimeType);
  if (!transcript) {
    return { subjects: [], description: '', quantityEstimateKg: null, missingFields: [], transcript: '' };
  }

  const inference = await inferEventFromText(transcript);
  return { ...inference, transcript };
}

/**
 * logAiInference — spec §26's AI_INFERENCE audit trail: what the
 * classifier actually returned, for a given input type and requester,
 * independent of whether the contributor ever confirms or submits it.
 * Called from the controller (which knows the input type and requester)
 * rather than from each inferEventFrom* function, so a voice note logs
 * as 'audio' even though it's classified via the same text path a typed
 * note uses — never mislabeled by which internal function happened to
 * do the classifying. Best-effort: a logging failure must never break
 * the actual response to the contributor.
 */
export async function logAiInference({ requestedBy, inputType, inference }) {
  if (!inference) return;
  try {
    await query(
      `INSERT INTO ai_inferences (requested_by, input_type, model, raw_response)
       VALUES ($1, $2, $3, $4)`,
      [requestedBy || null, inputType, env.openaiModel, JSON.stringify(inference)]
    );
  } catch (err) {
    console.error('[aiInferenceService] failed to log inference:', err.message);
  }
}
