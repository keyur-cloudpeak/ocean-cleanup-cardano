/**
 * The complete set of KPIs a contributor dashboard can show (spec §8).
 *
 * This is deliberately a closed catalogue rather than free-form: the AI
 * chooses WHICH of these to surface for a given contributor, but it can
 * only choose from here, so every chosen KPI is guaranteed to be something
 * the backend can actually compute. The same constraint the subject
 * classifier works under — pick from the taxonomy, never invent.
 *
 * Every `sql` takes exactly one parameter ($1 = contributor_id) and returns
 * a single numeric column named `value`. Values are never cached: they're
 * recomputed on each read so the numbers move the moment the data does.
 */

// Events belonging to this contributor, reused by nearly every metric.
const MY_EVENTS = `
  SELECT e.* FROM environmental_events e
  JOIN contributions c ON c.contribution_id = e.contribution_id
  WHERE c.contributor_id = $1`;

const subjectFamilyCount = (family, extraWhere = '') => `
  SELECT COUNT(DISTINCT e.event_id)::float8 AS value
  FROM (${MY_EVENTS}) e
  JOIN event_subjects es ON es.event_id = e.event_id
  JOIN subjects s ON s.subject_id = es.subject_id
  WHERE s.family = '${family}' ${extraWhere}`;

export const KPI_CATALOGUE = {
  /* ── universal ─────────────────────────────────────────────────────── */
  contributions_total: {
    label: 'Contributions', sub: 'Everything you have sent in', unit: '',
    describe: 'total contributions of any kind',
    sql: `SELECT COUNT(*)::float8 AS value FROM contributions WHERE contributor_id = $1`,
  },
  verified_events: {
    label: 'Verified', sub: 'Confirmed by a reviewer', unit: '',
    describe: 'contributions a verifier has confirmed',
    sql: `SELECT COUNT(*)::float8 AS value FROM (${MY_EVENTS}) e WHERE e.verification_state = 'verified'`,
  },
  locations_affected: {
    label: 'Locations', sub: 'Places you have reported from', unit: '',
    describe: 'distinct places this person has contributed from',
    sql: `SELECT COUNT(DISTINCT e.location_label)::float8 AS value FROM (${MY_EVENTS}) e WHERE e.location_label IS NOT NULL`,
  },
  observations_corroborated: {
    label: 'Corroborated', sub: 'Others saw the same thing', unit: '',
    describe: 'observations independently confirmed by other people',
    sql: `
      SELECT COUNT(DISTINCT e.event_id)::float8 AS value FROM (${MY_EVENTS}) e
      WHERE EXISTS (SELECT 1 FROM event_relationships r
                    WHERE r.relationship_type = 'corroborates'
                      AND (r.from_event_id = e.event_id OR r.to_event_id = e.event_id))`,
  },
  records_connected: {
    label: 'Records Connected', sub: 'Linked to other events', unit: '',
    describe: 'contributions linked to another environmental event',
    sql: `
      SELECT COUNT(DISTINCT e.event_id)::float8 AS value FROM (${MY_EVENTS}) e
      WHERE EXISTS (SELECT 1 FROM event_relationships r
                    WHERE r.from_event_id = e.event_id OR r.to_event_id = e.event_id)`,
  },

  /* ── cleanup / pollution ───────────────────────────────────────────── */
  kg_removed: {
    label: 'Waste Removed', sub: 'Total recorded weight', unit: 'kg',
    describe: 'kilograms of waste removed',
    sql: `
      SELECT COALESCE(SUM(ei.value), 0)::float8 AS value
      FROM (${MY_EVENTS}) e JOIN event_impact ei ON ei.event_id = e.event_id
      WHERE ei.metric = 'debris_removed_kg'`,
  },
  actions_completed: {
    label: 'Actions Completed', sub: 'Cleanups and other actions closed out', unit: '',
    describe: 'cleanup or response actions completed',
    sql: subjectFamilyCount('human_action', `AND e.event_state = 'addressed'`),
  },
  places_recurring: {
    label: 'Recurring Sites', sub: 'Places the problem keeps returning', unit: '',
    describe: 'places where the same problem keeps coming back',
    sql: `SELECT COUNT(DISTINCT e.location_label)::float8 AS value FROM (${MY_EVENTS}) e WHERE e.event_state = 'recurring'`,
  },

  /* ── wildlife / life ───────────────────────────────────────────────── */
  wildlife_observations: {
    label: 'Wildlife Observations', sub: 'Living things you have recorded', unit: '',
    describe: 'wildlife and other life observations recorded',
    sql: subjectFamilyCount('life'),
  },
  rescues: {
    label: 'Rescues', sub: 'Animals rescued or released', unit: '',
    describe: 'wildlife rescues resolved',
    sql: subjectFamilyCount('life', `AND e.event_state = 'addressed'`),
  },
  confirmed_species: {
    label: 'Confirmed Observations', sub: 'Species sightings verified', unit: '',
    describe: 'species observations confirmed by a verifier',
    sql: subjectFamilyCount('life', `AND e.verification_state = 'verified'`),
  },

  /* ── water quality ─────────────────────────────────────────────────── */
  measurements_submitted: {
    label: 'Measurements Submitted', sub: 'Individual readings logged', unit: '',
    describe: 'individual water-quality or sensor readings submitted',
    sql: `
      SELECT COUNT(*)::float8 AS value FROM measurements m
      WHERE m.event_id IN (SELECT e.event_id FROM (${MY_EVENTS}) e)`,
  },
  anomalies_flagged: {
    label: 'Anomalies Flagged', sub: 'Readings that needed a look', unit: '',
    describe: 'water readings that came back outside the expected range',
    sql: subjectFamilyCount('water', `AND e.event_state = 'needs_attention'`),
  },
  recurring_changes: {
    label: 'Recurring Changes', sub: 'Changes that keep coming back', unit: '',
    describe: 'conditions that keep recurring at the same place',
    sql: `SELECT COUNT(*)::float8 AS value FROM (${MY_EVENTS}) e WHERE e.event_state = 'recurring'`,
  },

  /* ── habitat / restoration ─────────────────────────────────────────── */
  sites_monitored: {
    label: 'Sites Monitored', sub: 'Habitat sites you follow', unit: '',
    describe: 'habitat sites being monitored',
    sql: `
      SELECT COUNT(DISTINCT e.location_label)::float8 AS value
      FROM (${MY_EVENTS}) e
      JOIN event_subjects es ON es.event_id = e.event_id
      JOIN subjects s ON s.subject_id = es.subject_id
      WHERE s.family = 'habitat' AND e.location_label IS NOT NULL`,
  },
  restoration_actions: {
    label: 'Restoration Actions', sub: 'Replanting and recovery work', unit: '',
    describe: 'restoration actions carried out',
    sql: `
      SELECT COUNT(DISTINCT e.event_id)::float8 AS value
      FROM (${MY_EVENTS}) e
      JOIN event_subjects es ON es.event_id = e.event_id
      JOIN subjects s ON s.subject_id = es.subject_id
      WHERE s.family = 'human_action' AND s.code = 'restoration'`,
  },
  condition_changes: {
    label: 'Condition Changes', sub: 'Habitat condition recorded as changed', unit: '',
    describe: 'recorded changes in habitat condition',
    sql: subjectFamilyCount('habitat', `AND e.event_state = 'addressed'`),
  },
  area_restored: {
    label: 'Area Restored', sub: 'Total area brought back', unit: 'm²',
    describe: 'area of habitat restored',
    sql: `
      SELECT COALESCE(SUM(ei.value), 0)::float8 AS value
      FROM (${MY_EVENTS}) e JOIN event_impact ei ON ei.event_id = e.event_id
      WHERE ei.metric = 'area_restored_m2'`,
  },

  /* ── research ──────────────────────────────────────────────────────── */
  datasets_contributed: {
    label: 'Datasets Contributed', sub: 'Reports and datasets uploaded', unit: '',
    describe: 'datasets or documents uploaded rather than field reports',
    sql: `SELECT COUNT(*)::float8 AS value FROM contributions WHERE contributor_id = $1 AND intake_method = 'upload'`,
  },
  surveys_logged: {
    label: 'Surveys Logged', sub: 'Monitoring and survey work', unit: '',
    describe: 'monitoring or survey activities logged',
    sql: `
      SELECT COUNT(DISTINCT e.event_id)::float8 AS value
      FROM (${MY_EVENTS}) e
      JOIN event_subjects es ON es.event_id = e.event_id
      JOIN subjects s ON s.subject_id = es.subject_id
      WHERE s.family = 'human_action' AND s.code IN ('monitoring_survey', 'research_sampling')`,
  },
};

export const KPI_KEYS = Object.keys(KPI_CATALOGUE);

// How many a dashboard shows. Five matches the existing card row.
export const KPI_COUNT = 5;

// Used when the AI is unavailable or returns nothing usable. Ordered so the
// first five are meaningful for almost anyone.
export const FALLBACK_KPIS = [
  'contributions_total', 'verified_events', 'actions_completed', 'kg_removed', 'locations_affected',
];

export default KPI_CATALOGUE;
