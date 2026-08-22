// One-off backfill: populates weather_conditions / days_since_rain /
// wind_speed_kmh for existing activities that have lat/lon + submitted_at
// but were created before weather auto-fetch existed (or whose background
// fetch failed at submit time). Safe to re-run — only touches rows where
// all three weather columns are still null.
//
// Usage: node scripts/backfillWeather.js

import { query } from '../src/config/connection.js';
import { fetchWeatherContext } from '../src/services/weatherService.js';

async function main() {
  const { rows } = await query(
    `SELECT id, lat, lon, submitted_at
     FROM activities
     WHERE lat IS NOT NULL AND lon IS NOT NULL
       AND weather_conditions IS NULL
       AND days_since_rain IS NULL
       AND wind_speed_kmh IS NULL
     ORDER BY submitted_at ASC`
  );

  console.log(`Backfilling weather for ${rows.length} activit${rows.length === 1 ? 'y' : 'ies'}...`);

  let updated = 0;
  for (const row of rows) {
    const weather = await fetchWeatherContext(row.lat, row.lon, row.submitted_at);
    if (weather.weatherConditions === null && weather.daysSinceRain === null && weather.windSpeedKmh === null) {
      console.log(`  ${row.id}: no weather data available, skipping`);
      continue;
    }

    await query(
      `UPDATE activities
       SET weather_conditions = $2, days_since_rain = $3, wind_speed_kmh = $4
       WHERE id = $1`,
      [row.id, weather.weatherConditions, weather.daysSinceRain, weather.windSpeedKmh]
    );
    updated += 1;
    console.log(`  ${row.id}: ${weather.weatherConditions ?? 'unknown'} · ${weather.daysSinceRain ?? '—'}d since rain · ${weather.windSpeedKmh ?? '—'} km/h wind`);
  }

  console.log(`Done. Updated ${updated} of ${rows.length} activities.`);
  process.exit(0);
}

main().catch((err) => {
  console.error('Backfill failed:', err);
  process.exit(1);
});
