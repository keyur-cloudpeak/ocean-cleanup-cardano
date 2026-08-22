const ARCHIVE_URL = 'https://archive-api.open-meteo.com/v1/archive';
const FETCH_TIMEOUT_MS = 8000;
const LOOKBACK_DAYS = 14;
const RAIN_THRESHOLD_MM = 0.1;

// WMO weather codes as used by Open-Meteo's daily `weathercode` field.
const WEATHER_CODE_DESCRIPTIONS = {
  0: 'Clear sky',
  1: 'Mainly clear',
  2: 'Partly cloudy',
  3: 'Overcast',
  45: 'Fog',
  48: 'Depositing rime fog',
  51: 'Light drizzle',
  53: 'Moderate drizzle',
  55: 'Dense drizzle',
  56: 'Light freezing drizzle',
  57: 'Dense freezing drizzle',
  61: 'Slight rain',
  63: 'Moderate rain',
  65: 'Heavy rain',
  66: 'Light freezing rain',
  67: 'Heavy freezing rain',
  71: 'Slight snow fall',
  73: 'Moderate snow fall',
  75: 'Heavy snow fall',
  77: 'Snow grains',
  80: 'Slight rain showers',
  81: 'Moderate rain showers',
  82: 'Violent rain showers',
  85: 'Slight snow showers',
  86: 'Heavy snow showers',
  95: 'Thunderstorm',
  96: 'Thunderstorm with slight hail',
  99: 'Thunderstorm with heavy hail'
};

const EMPTY_RESULT = { weatherConditions: null, daysSinceRain: null, windSpeedKmh: null };

function describeWeatherCode(code) {
  if (code === null || code === undefined) return null;
  return WEATHER_CODE_DESCRIPTIONS[code] ?? `Weather code ${code}`;
}

function toDateString(date) {
  return date.toISOString().slice(0, 10);
}

/**
 * fetchWeatherContext — best-effort lookup of historical weather for a
 * cleanup activity, via Open-Meteo's free archive API (no key required).
 * Pulls the 14 days up to and including the activity date, then:
 *   - daysSinceRain: how many days back from the activity date the most
 *     recent day with measurable precipitation (>= 0.1mm) was
 *   - weatherConditions / windSpeedKmh: conditions on the activity date
 *     itself (the last day in the fetched range)
 * Never throws — any failure (network, timeout, malformed response, bad
 * coordinates) resolves to null fields so activity creation is never
 * blocked or failed by a flaky third-party weather API.
 */
export async function fetchWeatherContext(lat, lon, activityDate) {
  const numericLat = Number(lat);
  const numericLon = Number(lon);
  if (!Number.isFinite(numericLat) || !Number.isFinite(numericLon)) {
    return { ...EMPTY_RESULT };
  }

  const date = activityDate instanceof Date ? activityDate : new Date(activityDate);
  if (Number.isNaN(date.getTime())) {
    return { ...EMPTY_RESULT };
  }

  const endDate = new Date(date);
  const startDate = new Date(date);
  startDate.setUTCDate(startDate.getUTCDate() - LOOKBACK_DAYS);

  const params = new URLSearchParams({
    latitude: numericLat.toFixed(4),
    longitude: numericLon.toFixed(4),
    start_date: toDateString(startDate),
    end_date: toDateString(endDate),
    daily: 'precipitation_sum,windspeed_10m_max,weathercode',
    timezone: 'UTC'
  });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const res = await fetch(`${ARCHIVE_URL}?${params.toString()}`, { signal: controller.signal });
    if (!res.ok) {
      throw new Error(`Open-Meteo request failed with status ${res.status}`);
    }

    const data = await res.json();
    const days = data?.daily?.time || [];
    const precipitation = data?.daily?.precipitation_sum || [];
    const windSpeeds = data?.daily?.windspeed_10m_max || [];
    const weatherCodes = data?.daily?.weathercode || [];

    if (days.length === 0) {
      return { ...EMPTY_RESULT };
    }

    // The activity date is the last entry in the requested range (or the
    // most recent day the archive actually has data for, if it hasn't
    // caught up to very recent dates yet).
    const lastIndex = days.length - 1;
    const windSpeedKmh = Number.isFinite(windSpeeds[lastIndex]) ? windSpeeds[lastIndex] : null;
    const weatherConditions = describeWeatherCode(weatherCodes[lastIndex]);

    let daysSinceRain = null;
    for (let i = lastIndex; i >= 0; i -= 1) {
      const amount = precipitation[i];
      if (Number.isFinite(amount) && amount >= RAIN_THRESHOLD_MM) {
        daysSinceRain = lastIndex - i;
        break;
      }
    }

    return { weatherConditions, daysSinceRain, windSpeedKmh };
  } catch (err) {
    console.error('[weatherService] fetch failed:', err.message);
    return { ...EMPTY_RESULT };
  } finally {
    clearTimeout(timeout);
  }
}

export default { fetchWeatherContext };
