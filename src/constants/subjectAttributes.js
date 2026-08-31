// Controlled attribute vocabularies from the ontology spec (§7.3, §7.4).
// The subjects table (db/schema.sql) already covers every subject *type*
// in the taxonomy, but the spec also names fixed value sets for two
// per-subject attributes — a life subject's condition and a habitat
// subject's condition — that nothing in the codebase previously defined
// anywhere. Shared between aiInferenceService.js (what the classifier is
// allowed to return) and environmentalEventService.js/eventController.js
// (validating anything written to event_subjects.attributes), so both
// sides of the AI → DB path agree on the same fixed lists.

// spec §7.3: "Life observations should support state/condition such as:
// observed · abundance/count · healthy · injured · stranded · entangled ·
// deceased · unusual behavior · invasive · bloom/outbreak · nesting/breeding"
export const LIFE_CONDITION_VALUES = [
  'observed', 'healthy', 'injured', 'stranded', 'entangled', 'deceased',
  'unusual_behavior', 'invasive', 'bloom_outbreak', 'nesting_breeding'
];

// spec §7.4: "Potential condition: healthy · improving · stable · stressed
// · damaged · degraded · restored · unknown"
export const HABITAT_CONDITION_VALUES = [
  'healthy', 'improving', 'stable', 'stressed', 'damaged', 'degraded', 'restored', 'unknown'
];

// spec §7.1 names these as expected context attributes for a
// pollution_waste subject but — unlike Life/Habitat — gives no fixed
// value list for them, so they're validated as short free text rather
// than against an enum.
export const POLLUTION_FREE_TEXT_ATTRIBUTES = ['severity', 'hazard'];

const FREE_TEXT_MAX_LENGTH = 80;

/**
 * sanitizeSubjectAttributes — keeps only the attribute keys the ontology
 * actually defines for a given subject family, and only values that pass
 * that attribute's own rule (enum membership for condition, length cap
 * for free text). Everything else (an unknown key, an out-of-vocabulary
 * condition, a wildly long string) is silently dropped rather than
 * stored — this is the single point both the AI response path and any
 * future manual-edit path should call before writing to
 * event_subjects.attributes, so the vocabulary stays enforced regardless
 * of who supplied the value (spec §17: AI_INFERRED vs USER_PROVIDED both
 * still have to be valid data).
 */
export function sanitizeSubjectAttributes(family, rawAttributes) {
  if (!rawAttributes || typeof rawAttributes !== 'object') return {};
  const out = {};

  if (family === 'life' && LIFE_CONDITION_VALUES.includes(rawAttributes.condition)) {
    out.condition = rawAttributes.condition;
  }
  if (family === 'habitat' && HABITAT_CONDITION_VALUES.includes(rawAttributes.condition)) {
    out.condition = rawAttributes.condition;
  }
  if (family === 'pollution_waste') {
    for (const key of POLLUTION_FREE_TEXT_ATTRIBUTES) {
      const value = rawAttributes[key];
      if (typeof value === 'string' && value.trim()) {
        out[key] = value.trim().slice(0, FREE_TEXT_MAX_LENGTH);
      }
    }
  }

  return out;
}
