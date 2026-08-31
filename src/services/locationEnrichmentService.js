const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/reverse';
const FETCH_TIMEOUT_MS = 8000;

const EMPTY_RESULT = { adminArea: null, country: null, waterBody: null };

// A geocode result recognized as a water feature — only trusted when the
// result actually resolves onto/near one, never guessed from a land
// address (spec §17: never invent a value from thin evidence).
const WATER_FEATURE_TYPES = new Set(['bay', 'sea', 'ocean', 'strait', 'water', 'reef', 'wetland']);

/**
 * fetchLocationContext — best-effort reverse geocode of an event's lat/lon
 * into admin_area/country/water_body (spec §18), via OpenStreetMap's free
 * Nominatim API (no key required). Mirrors weatherService.fetchWeatherContext's
 * resilience contract exactly: never throws, any failure (network, timeout,
 * malformed response, bad coordinates) resolves to null fields so event
 * creation is never blocked or failed by a flaky third-party geocoder.
 */
export async function fetchLocationContext(lat, lon) {
  const numericLat = Number(lat);
  const numericLon = Number(lon);
  if (!Number.isFinite(numericLat) || !Number.isFinite(numericLon)) {
    return { ...EMPTY_RESULT };
  }

  const params = new URLSearchParams({
    format: 'jsonv2',
    lat: numericLat.toFixed(6),
    lon: numericLon.toFixed(6),
    addressdetails: '1',
    zoom: '10'
  });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const res = await fetch(`${NOMINATIM_URL}?${params.toString()}`, {
      signal: controller.signal,
      headers: {
        'Accept-Language': 'en',
        // Nominatim's usage policy requires a descriptive User-Agent
        // identifying the calling application — see
        // https://operations.osmfoundation.org/policies/nominatim/
        'User-Agent': 'BlueMind-OceanCleanup/1.0 (environmental event location enrichment)'
      }
    });
    if (!res.ok) {
      throw new Error(`Nominatim request failed with status ${res.status}`);
    }

    const data = await res.json();
    const address = data?.address || {};

    const adminArea = address.state || address.region || address.state_district || address.county || null;
    const country = address.country || null;
    const waterBody = WATER_FEATURE_TYPES.has(data?.type)
      ? (data?.name || address.bay || address.sea || null)
      : (address.bay || address.sea || address.ocean || null);

    return { adminArea, country, waterBody };
  } catch (err) {
    console.error('[locationEnrichmentService] fetch failed:', err.message);
    return { ...EMPTY_RESULT };
  } finally {
    clearTimeout(timeout);
  }
}

export default { fetchLocationContext };
