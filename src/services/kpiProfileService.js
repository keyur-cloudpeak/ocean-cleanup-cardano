/**
 * kpiProfileService — per-contributor KPIs (spec §8): "metrics can exist,
 * but should adapt to contributor type".
 *
 * Two halves, deliberately separated:
 *
 *   THE CHOICE  — which KPIs suit this person — is made once by the AI from
 *                 the fixed catalogue in config/kpiCatalogue.js, then stored
 *                 in contributor_kpi_profiles. It is only revisited when the
 *                 SHAPE of their contributions changes (a new subject family,
 *                 a new intake method, a jump in scale), captured as
 *                 `profile_signature`. A dashboard load never costs an AI
 *                 call on its own.
 *
 *   THE VALUES  — are never stored. They are recomputed from the event model
 *                 on every read, so the numbers move the moment the data
 *                 does, without the AI being involved again.
 *
 * The AI is constrained to catalogue keys, so it cannot pick a KPI the
 * backend has no way to compute — the same rule the subject classifier
 * works under.
 */
import crypto from 'crypto';
import { query } from '../config/connection.js';
import { env } from '../config/env.js';
import { KPI_CATALOGUE, KPI_KEYS, KPI_COUNT, FALLBACK_KPIS } from '../config/kpiCatalogue.js';

const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';
const FETCH_TIMEOUT_MS = 15000;

/**
 * A description of WHAT this person contributes, not how much. Counts are
 * bucketed by magnitude on purpose: going from 12 to 13 cleanups shouldn't
 * re-trigger a decision, but picking up water-quality work for the first
 * time should.
 */
export async function getContributorProfile(contributorId) {
  const [{ rows: families }, { rows: intake }, { rows: extras }] = await Promise.all([
    query(
      `SELECT s.family, COUNT(DISTINCT es.event_id)::int AS n
       FROM event_subjects es
       JOIN subjects s ON s.subject_id = es.subject_id
       JOIN environmental_events e ON e.event_id = es.event_id
       JOIN contributions c ON c.contribution_id = e.contribution_id
       WHERE c.contributor_id = $1
       GROUP BY s.family ORDER BY n DESC`,
      [contributorId]
    ),
    query(
      `SELECT intake_method, COUNT(*)::int AS n FROM contributions
       WHERE contributor_id = $1 GROUP BY intake_method ORDER BY n DESC`,
      [contributorId]
    ),
    query(
      `SELECT
         (SELECT COUNT(*)::int FROM measurements m
          WHERE m.event_id IN (SELECT e.event_id FROM environmental_events e
                               JOIN contributions c ON c.contribution_id = e.contribution_id
                               WHERE c.contributor_id = $1)) AS measurements,
         (SELECT COUNT(DISTINCT o.name)::int FROM contributions c
          JOIN organizations o ON o.org_id = c.organization_id
          WHERE c.contributor_id = $1) AS organizations`,
      [contributorId]
    ),
  ]);

  const bucket = (n) => (n === 0 ? 'none' : n < 5 ? 'few' : n < 25 ? 'some' : 'many');

  return {
    families: families.map((f) => ({ family: f.family, count: f.n, scale: bucket(f.n) })),
    intakeMethods: intake.map((i) => ({ method: i.intake_method, count: i.n, scale: bucket(i.n) })),
    measurements: Number(extras[0]?.measurements) || 0,
    organizations: Number(extras[0]?.organizations) || 0,
  };
}

// Only the shape-bearing parts of the profile feed the signature — raw
// counts are excluded so ordinary activity doesn't churn the decision.
export function profileSignature(profile) {
  const shape = {
    families: profile.families.map((f) => `${f.family}:${f.scale}`).sort(),
    intake: profile.intakeMethods.map((i) => `${i.method}:${i.scale}`).sort(),
    measurements: profile.measurements > 0,
    organizations: profile.organizations > 0,
  };
  return crypto.createHash('sha256').update(JSON.stringify(shape)).digest('hex').slice(0, 32);
}

const SYSTEM_PROMPT = `You choose which metrics a Blue Mind contributor's dashboard should lead with.

Blue Mind contributors are not all cleanup crews. A marine biologist, a water-quality team, a diver, a researcher, a restoration group and a beach-cleanup organiser all use the same product, and each should see numbers that reflect THEIR work. Showing "kilograms removed" to someone who only records coral bleaching is the failure this is meant to prevent.

You will be given a profile describing what a contributor actually contributes. Choose exactly ${KPI_COUNT} metric keys from the catalogue, ordered most important first.

The profile includes "availableMetrics" — every metric that currently has a real number for this person, with its current value. These are your ONLY options.

Rules:
- Choose ONLY keys listed in availableMetrics. Never invent a key, and never pick one that isn't listed.
- Pick the metrics that best describe THIS person's work. A contributor whose work is pollution and cleanup should lead with what they removed; a water-quality team with their readings and anomalies; a wildlife observer with sightings and rescues; a researcher with datasets and connections; a restoration group with sites and area recovered.
- Include at least one universal metric (contributions_total or verified_events) so the dashboard has a stable anchor.
- Prefer variety: don't pick five near-identical counts.
- The first key is the headline metric and gets the most visual weight — make it the number this person would most want to see.

Respond with ONLY a JSON object:
{"kpis": ["key1","key2","key3","key4","key5"], "rationale": "one short sentence explaining the choice"}`;

function catalogueForPrompt() {
  return KPI_KEYS.map((k) => `- ${k}: ${KPI_CATALOGUE[k].describe}`).join('\n');
}

async function askAi(profile) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(OPENAI_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.openaiApiKey}` },
      body: JSON.stringify({
        model: env.openaiModel,
        response_format: { type: 'json_object' },
        max_tokens: 300,
        messages: [
          { role: 'system', content: `${SYSTEM_PROMPT}\n\nCatalogue:\n${catalogueForPrompt()}` },
          { role: 'user', content: JSON.stringify(profile) },
        ],
      }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`OpenAI ${res.status}`);
    const body = await res.json();
    const parsed = JSON.parse(body.choices?.[0]?.message?.content || '{}');
    return parsed;
  } finally {
    clearTimeout(timeout);
  }
}

// Never trust the model's list straight through: drop unknown keys, drop
// duplicates, and top up from the fallback so the dashboard always gets a
// full row even if the model returns two keys or twenty.
function sanitizeChoice(raw, candidates) {
  const allowed = new Set(candidates);
  const picked = Array.isArray(raw?.kpis) ? raw.kpis : [];
  const seen = new Set();
  const keys = [];
  // Anything outside the candidate set is dropped — that's what stops an
  // empty metric reaching the dashboard even if the model asks for one.
  for (const k of picked) {
    if (typeof k === 'string' && allowed.has(k) && !seen.has(k)) { seen.add(k); keys.push(k); }
    if (keys.length === KPI_COUNT) break;
  }
  // Top up from the candidates themselves, fallbacks first for familiarity.
  for (const k of [...FALLBACK_KPIS, ...candidates]) {
    if (keys.length === KPI_COUNT) break;
    if (allowed.has(k) && !seen.has(k)) { seen.add(k); keys.push(k); }
  }
  return {
    keys: keys.slice(0, KPI_COUNT),
    rationale: typeof raw?.rationale === 'string' ? raw.rationale.slice(0, 300) : null,
  };
}

async function decideAndStore(contributorId, profile, signature) {
  // Compute every catalogue metric BEFORE asking. Given only the profile
  // shape, the model can't tell which metrics would come back empty — and it
  // duly picked "Anomalies Flagged: 0" and "Surveys Logged: 0" for a pure
  // cleanup contributor while skipping kg removed. Candidates are therefore
  // restricted to metrics that actually have a number behind them, so an
  // empty KPI can't be chosen no matter how the model behaves.
  const allValues = await computeValues(contributorId, KPI_KEYS);
  const valueByKey = new Map(allValues.map((v) => [v.key, v.value]));
  const candidates = allValues.filter((v) => v.value > 0).map((v) => v.key);

  // Anchors stay available even at zero — a brand-new contributor still needs
  // a dashboard, and "Contributions: 0" is honest rather than misleading.
  for (const anchor of ['contributions_total', 'verified_events']) {
    if (!candidates.includes(anchor)) candidates.push(anchor);
  }

  let choice = {
    keys: FALLBACK_KPIS.filter((k) => candidates.includes(k)).slice(0, KPI_COUNT),
    rationale: null,
  };
  let decidedBy = 'fallback';

  if (env.openaiApiKey && candidates.length > 0) {
    try {
      choice = sanitizeChoice(await askAi({ ...profile, availableMetrics: candidates.map((k) => ({ key: k, currentValue: valueByKey.get(k) })) }), candidates);
      decidedBy = 'ai';
    } catch (err) {
      // A dashboard must still render if the model is slow or down.
      console.error('[kpiProfileService] AI choice failed, using fallback:', err.message);
    }
  }

  await query(
    `INSERT INTO contributor_kpi_profiles (contributor_id, kpi_keys, rationale, profile_signature, decided_by, updated_at)
     VALUES ($1, $2, $3, $4, $5, NOW())
     ON CONFLICT (contributor_id) DO UPDATE
       SET kpi_keys = EXCLUDED.kpi_keys, rationale = EXCLUDED.rationale,
           profile_signature = EXCLUDED.profile_signature, decided_by = EXCLUDED.decided_by,
           updated_at = NOW()`,
    [contributorId, choice.keys, choice.rationale, signature, decidedBy]
  );

  return { ...choice, decidedBy };
}

/** Values, computed fresh — one catalogue query per chosen KPI. */
async function computeValues(contributorId, keys) {
  const results = await Promise.all(keys.map(async (key) => {
    const metric = KPI_CATALOGUE[key];
    try {
      const { rows } = await query(metric.sql, [contributorId]);
      return { key, value: Number(rows[0]?.value) || 0 };
    } catch (err) {
      console.error(`[kpiProfileService] metric ${key} failed:`, err.message);
      return { key, value: 0, error: true };
    }
  }));

  return results.map(({ key, value, error }) => ({
    key,
    label: KPI_CATALOGUE[key].label,
    sub: KPI_CATALOGUE[key].sub,
    unit: KPI_CATALOGUE[key].unit,
    value,
    ...(error ? { error: true } : {}),
  }));
}

/**
 * The one entry point: returns this contributor's KPI row, deciding via AI
 * only when there's no stored decision or their contribution shape changed.
 * `force` re-runs the decision regardless (used by an explicit refresh).
 */
export async function getContributorKpis(contributorId, { force = false } = {}) {
  const profile = await getContributorProfile(contributorId);
  const signature = profileSignature(profile);

  const { rows } = await query(
    `SELECT kpi_keys, rationale, profile_signature, decided_by, decided_at, updated_at
     FROM contributor_kpi_profiles WHERE contributor_id = $1`,
    [contributorId]
  );
  const stored = rows[0];

  let keys;
  let rationale;
  let decidedBy;
  let reused;

  if (!force && stored && stored.profile_signature === signature && stored.kpi_keys?.length) {
    // Stale keys are dropped here too — a catalogue entry could be removed
    // after a decision was stored.
    keys = stored.kpi_keys.filter((k) => KPI_CATALOGUE[k]);
    rationale = stored.rationale;
    decidedBy = stored.decided_by;
    reused = true;
    if (keys.length === 0) reused = false;
  }

  if (!reused) {
    const decided = await decideAndStore(contributorId, profile, signature);
    keys = decided.keys;
    rationale = decided.rationale;
    decidedBy = decided.decidedBy;
  }

  return {
    kpis: await computeValues(contributorId, keys),
    rationale,
    decidedBy,
    reusedStoredChoice: Boolean(reused),
    profile,
  };
}

export default { getContributorKpis, getContributorProfile, profileSignature };
