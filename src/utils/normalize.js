// Small shared coercion helpers. Extracted out of activityService.js and
// userService.js, which each independently implemented the same
// number/string/JSON coercion logic under different function names.

// Coerce a value to a finite Number, or null if it's empty/blank/unparseable.
export function toNumber(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }

  const parsed = Number(value);
  return Number.isNaN(parsed) ? null : parsed;
}

// Coerce a value to a trimmed, lowercased string ('' for null/undefined).
export function toTrimmedLower(value) {
  return String(value || '').trim().toLowerCase();
}

// Parse a value into a JSON-able object, or null if it's null/undefined/
// unparseable/not an object. Accepts either a JSON string or an already-
// parsed object.
export function toJsonOrNull(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') {
    try {
      return JSON.parse(value);
    } catch {
      return null;
    }
  }
  return typeof value === 'object' ? value : null;
}
