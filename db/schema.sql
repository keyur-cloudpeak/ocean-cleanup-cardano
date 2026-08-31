-- Ocean Cleanup Backend
-- PostgreSQL schema for the current JSON-backed API

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'user_role') THEN
        CREATE TYPE user_role AS ENUM ('admin', 'contributor', 'verifier', 'citizen');
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'activity_status') THEN
        CREATE TYPE activity_status AS ENUM ('pending', 'rejected', 'approved');
    END IF;
END
$$;

CREATE TABLE IF NOT EXISTS organizations (
    org_id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name            TEXT NOT NULL,
    region          TEXT,
    country         TEXT,
    parent_org_id   UUID REFERENCES organizations(org_id),
    contact_email   TEXT,
    joined_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    is_active       BOOLEAN NOT NULL DEFAULT true
);

CREATE INDEX IF NOT EXISTS idx_organizations_is_active  ON organizations (is_active);
CREATE INDEX IF NOT EXISTS idx_organizations_parent_org ON organizations (parent_org_id);
CREATE INDEX IF NOT EXISTS idx_organizations_joined_at  ON organizations (joined_at DESC);

CREATE TABLE IF NOT EXISTS users (
    id              TEXT PRIMARY KEY,
    first_name      TEXT NOT NULL,
    last_name       TEXT NOT NULL,
    email           TEXT NOT NULL,
    username        TEXT NOT NULL,
    password_hash   TEXT NOT NULL,
    role            user_role NOT NULL,
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    email_verified_at TIMESTAMPTZ,
    email_verification_token_hash TEXT,
    email_verification_token_expires_at TIMESTAMPTZ,
    password_reset_token_hash TEXT,
    password_reset_token_expires_at TIMESTAMPTZ,
    organization_id UUID REFERENCES organizations(org_id),
    job_title       TEXT,
    years_experience TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT users_email_unique UNIQUE (email),
    CONSTRAINT users_username_unique UNIQUE (username)
);

-- User wallets are not part of the proof flow. Existing installations can
-- safely remove the obsolete column when this schema is re-run.
ALTER TABLE users DROP COLUMN IF EXISTS wallet_address;
ALTER TABLE users ADD COLUMN IF NOT EXISTS job_title TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS years_experience TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS profile_image_url TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verification_token_hash TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verification_token_expires_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_reset_token_hash TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_reset_token_expires_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_users_email_verification_token_hash
    ON users (email_verification_token_hash);

CREATE INDEX IF NOT EXISTS idx_users_password_reset_token_hash
    ON users (password_reset_token_hash);

UPDATE users
SET email_verified_at = COALESCE(email_verified_at, created_at)
WHERE role IN ('citizen', 'contributor')
  AND email_verified_at IS NULL;

-- Admins are managed separately from the users table: they are invited by
-- email (no self-signup, no username) and only exist once someone with
-- admin access sends an invite. Login for an invited email always resolves
-- against this table, never against users.
CREATE TABLE IF NOT EXISTS admins (
    id                          TEXT PRIMARY KEY,
    first_name                  TEXT,
    last_name                   TEXT,
    email                       TEXT NOT NULL,
    password_hash               TEXT,
    is_active                   BOOLEAN NOT NULL DEFAULT TRUE,
    -- Not FK-constrained: the inviter may be a legacy admin whose account
    -- still lives in `users` (from before this table existed), not just
    -- another row in `admins`. This column is audit-only.
    invited_by                  TEXT,
    invite_token_hash           TEXT,
    invite_token_expires_at     TIMESTAMPTZ,
    password_set_at             TIMESTAMPTZ,
    created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT admins_email_unique UNIQUE (email)
);

ALTER TABLE admins DROP CONSTRAINT IF EXISTS admins_invited_by_fkey;
ALTER TABLE admins ADD COLUMN IF NOT EXISTS profile_image_url TEXT;

CREATE INDEX IF NOT EXISTS idx_admins_invite_token_hash ON admins (invite_token_hash);

CREATE TABLE IF NOT EXISTS activities (
    id                  TEXT PRIMARY KEY,
    category            TEXT NOT NULL,
    location            TEXT NOT NULL,
    quantity            NUMERIC(12, 2) NOT NULL CHECK (quantity >= 0),
    volunteers          INTEGER NOT NULL DEFAULT 0 CHECK (volunteers >= 0),
    evidence_hash       TEXT,
    contributor_id      TEXT,
    organization_id     TEXT,
    image_cid           TEXT[],
    image_ipfs_url      TEXT[],
    image_gateway_url   TEXT[],
    lat                 NUMERIC(9, 6),
    lon                 NUMERIC(9, 6),
    gps                 TEXT,
    notes               TEXT NOT NULL DEFAULT '',
    submitted_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    status              activity_status NOT NULL DEFAULT 'pending',
    review_note         TEXT NOT NULL DEFAULT '',
    reviewed_at         TIMESTAMPTZ,
    -- Not FK-constrained: a reviewer can be a verifier (in `users`) or an
    -- admin (in the separate `admins` table). This column is audit-only.
    reviewed_by         TEXT,
    reward_id           TEXT,
    reward_tx_hash      TEXT,
    reward_amount       NUMERIC(18, 2),
    reward_token_type   TEXT,
    reward_minted_at    TIMESTAMPTZ,
    shoreline_type      TEXT,
    tide_state          TEXT,
    cleaned_before      BOOLEAN DEFAULT FALSE,
    debris_cigarette_butts NUMERIC(12, 2) DEFAULT 0,
    debris_food_wrappers   NUMERIC(12, 2) DEFAULT 0,
    debris_bottle_caps     NUMERIC(12, 2) DEFAULT 0,
    debris_fishing_line    NUMERIC(12, 2) DEFAULT 0,
    debris_straws          NUMERIC(12, 2) DEFAULT 0,
    debris_bottles         NUMERIC(12, 2) DEFAULT 0,
    microplastics       TEXT,
    bulk_items          TEXT,
    species_sighted     TEXT,
    condition           TEXT,
    habitat_stress      TEXT,
    hazards_medical     BOOLEAN DEFAULT FALSE,
    hazards_chemical    BOOLEAN DEFAULT FALSE,
    hazards_unstable    BOOLEAN DEFAULT FALSE,
    instrument          TEXT,
    time_spent          NUMERIC,
    second_verifier     TEXT,
    disposal_method     TEXT,
    follow_up           BOOLEAN DEFAULT FALSE
);

CREATE INDEX IF NOT EXISTS idx_activities_status ON activities (status);
CREATE INDEX IF NOT EXISTS idx_activities_submitted_at ON activities (submitted_at DESC);
CREATE INDEX IF NOT EXISTS idx_activities_contributor_id ON activities (contributor_id);
CREATE INDEX IF NOT EXISTS idx_activities_organization_id ON activities (organization_id);

-- Migrate existing single-value TEXT columns to TEXT[] arrays (safe to re-run)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'activities'
      AND column_name = 'image_cid'
      AND data_type = 'text'
      AND udt_name != '_text'
  ) THEN
    ALTER TABLE activities
      ALTER COLUMN image_cid       TYPE TEXT[] USING CASE WHEN image_cid IS NULL THEN NULL ELSE ARRAY[image_cid] END,
      ALTER COLUMN image_ipfs_url  TYPE TEXT[] USING CASE WHEN image_ipfs_url IS NULL THEN NULL ELSE ARRAY[image_ipfs_url] END,
      ALTER COLUMN image_gateway_url TYPE TEXT[] USING CASE WHEN image_gateway_url IS NULL THEN NULL ELSE ARRAY[image_gateway_url] END;
  END IF;
END
$$;

ALTER TABLE activities ADD COLUMN IF NOT EXISTS shoreline_type TEXT;
ALTER TABLE activities ADD COLUMN IF NOT EXISTS tide_state TEXT;
ALTER TABLE activities ADD COLUMN IF NOT EXISTS cleaned_before BOOLEAN DEFAULT FALSE;
ALTER TABLE activities ADD COLUMN IF NOT EXISTS debris_cigarette_butts NUMERIC(12, 2) DEFAULT 0;
ALTER TABLE activities ADD COLUMN IF NOT EXISTS debris_food_wrappers NUMERIC(12, 2) DEFAULT 0;
ALTER TABLE activities ADD COLUMN IF NOT EXISTS debris_bottle_caps NUMERIC(12, 2) DEFAULT 0;
ALTER TABLE activities ADD COLUMN IF NOT EXISTS debris_fishing_line NUMERIC(12, 2) DEFAULT 0;
ALTER TABLE activities ADD COLUMN IF NOT EXISTS debris_straws NUMERIC(12, 2) DEFAULT 0;
ALTER TABLE activities ADD COLUMN IF NOT EXISTS debris_bottles NUMERIC(12, 2) DEFAULT 0;
ALTER TABLE activities ADD COLUMN IF NOT EXISTS microplastics TEXT;
ALTER TABLE activities ADD COLUMN IF NOT EXISTS bulk_items TEXT;
ALTER TABLE activities ADD COLUMN IF NOT EXISTS species_sighted TEXT;
ALTER TABLE activities ADD COLUMN IF NOT EXISTS condition TEXT;
ALTER TABLE activities ADD COLUMN IF NOT EXISTS habitat_stress TEXT;
ALTER TABLE activities ADD COLUMN IF NOT EXISTS hazards_medical BOOLEAN DEFAULT FALSE;
ALTER TABLE activities ADD COLUMN IF NOT EXISTS hazards_chemical BOOLEAN DEFAULT FALSE;
ALTER TABLE activities ADD COLUMN IF NOT EXISTS hazards_unstable BOOLEAN DEFAULT FALSE;
ALTER TABLE activities ADD COLUMN IF NOT EXISTS instrument TEXT;
ALTER TABLE activities ADD COLUMN IF NOT EXISTS time_spent NUMERIC;
ALTER TABLE activities ADD COLUMN IF NOT EXISTS second_verifier TEXT;
ALTER TABLE activities ADD COLUMN IF NOT EXISTS disposal_method TEXT;
ALTER TABLE activities ADD COLUMN IF NOT EXISTS follow_up BOOLEAN DEFAULT FALSE;
ALTER TABLE activities ADD COLUMN IF NOT EXISTS reviewed_by TEXT;
ALTER TABLE activities DROP CONSTRAINT IF EXISTS activities_reviewed_by_fkey;
ALTER TABLE activities ADD COLUMN IF NOT EXISTS brands_identified JSONB DEFAULT '{}'::jsonb;
ALTER TABLE activities ADD COLUMN IF NOT EXISTS survey_length_m NUMERIC(10, 2);
ALTER TABLE activities ADD COLUMN IF NOT EXISTS survey_area_sqm NUMERIC(10, 2);
ALTER TABLE activities ADD COLUMN IF NOT EXISTS survey_method TEXT;
ALTER TABLE activities ADD COLUMN IF NOT EXISTS weather_conditions TEXT;
ALTER TABLE activities ADD COLUMN IF NOT EXISTS days_since_rain INTEGER;
ALTER TABLE activities ADD COLUMN IF NOT EXISTS wind_speed_kmh NUMERIC(6, 2);
ALTER TABLE activities ADD COLUMN IF NOT EXISTS debris_source TEXT;

-- On-chain proof columns (safe to re-run)
ALTER TABLE activities ADD COLUMN IF NOT EXISTS onchain_tx_hash     TEXT;
ALTER TABLE activities ADD COLUMN IF NOT EXISTS onchain_hash         TEXT;
ALTER TABLE activities ADD COLUMN IF NOT EXISTS onchain_recorded_at  TIMESTAMPTZ;
ALTER TABLE activities ADD COLUMN IF NOT EXISTS onchain_status       TEXT;
ALTER TABLE activities ADD COLUMN IF NOT EXISTS onchain_submission_started_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_activities_onchain_status ON activities (onchain_status);

-- Append-only source of truth for user points. An idempotency key ensures an
-- approval can be retried safely without awarding points twice.
CREATE TABLE IF NOT EXISTS reward_ledger (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    activity_id     TEXT NOT NULL REFERENCES activities(id) ON DELETE RESTRICT,
    user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    reason          TEXT NOT NULL,
    amount          INTEGER NOT NULL CHECK (amount <> 0),
    idempotency_key TEXT NOT NULL UNIQUE,
    metadata        JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT reward_ledger_activity_reason_unique UNIQUE (activity_id, reason)
);

CREATE INDEX IF NOT EXISTS idx_reward_ledger_user_created_at ON reward_ledger (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_reward_ledger_activity_id ON reward_ledger (activity_id);

CREATE TABLE IF NOT EXISTS activity_events (
    id              BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    activity_id     TEXT NOT NULL REFERENCES activities(id) ON DELETE CASCADE,
    event_type      TEXT NOT NULL,
    payload         JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_activity_events_activity_id ON activity_events (activity_id);
CREATE INDEX IF NOT EXISTS idx_activity_events_created_at ON activity_events (created_at DESC);

CREATE TABLE IF NOT EXISTS notifications (
    id              BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    recipient_role  user_role NOT NULL,
    recipient_id    TEXT,
    activity_id     TEXT REFERENCES activities(id) ON DELETE SET NULL,
    title           TEXT NOT NULL,
    message         TEXT NOT NULL,
    link            TEXT,
    payload         JSONB NOT NULL DEFAULT '{}'::jsonb,
    is_read         BOOLEAN NOT NULL DEFAULT FALSE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_notifications_recipient_role ON notifications (recipient_role);
CREATE INDEX IF NOT EXISTS idx_notifications_recipient_id ON notifications (recipient_id);
CREATE INDEX IF NOT EXISTS idx_notifications_created_at ON notifications (created_at DESC);

CREATE TABLE IF NOT EXISTS user_login (
    id              BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    username        TEXT NOT NULL,
    role            user_role NOT NULL,
    ip_address      TEXT,
    socket_id       TEXT,
    user_agent      TEXT,
    login_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_user_login_user_id ON user_login (user_id);
CREATE INDEX IF NOT EXISTS idx_user_login_login_at ON user_login (login_at DESC);


-- =====================================================================
-- Environmental Event model
--
-- `activities` remains the system of record for the existing submit /
-- review / on-chain-proof flow — nothing above this line changes
-- behavior. The tables below are additive: they let a contribution carry
-- several subjects, relate to other events, and track verification state
-- separately from event state, without touching the code paths that
-- already depend on `activities`. `activities.environmental_event_id` is
-- the bridge between the two models during migration.
-- =====================================================================

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'provenance_source') THEN
        CREATE TYPE provenance_source AS ENUM (
            'user_provided', 'system_captured', 'ai_inferred',
            'external_enrichment', 'verifier_confirmed'
        );
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'subject_family') THEN
        CREATE TYPE subject_family AS ENUM (
            'pollution_waste', 'water', 'life', 'habitat', 'conditions', 'human_action'
        );
    END IF;

    -- Environmental state: where the underlying issue/action currently stands.
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'event_state') THEN
        CREATE TYPE event_state AS ENUM (
            'observed', 'corroborated', 'needs_attention', 'action_planned',
            'action_underway', 'addressed', 'reassessed', 'recurring',
            'disputed', 'unable_to_verify'
        );
    END IF;

    -- Verification state: how much confidence Blue Mind has in the claim.
    -- Deliberately a separate axis from event_state (spec §12) — an
    -- addressed event and an unverified event are independent facts.
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'verification_state') THEN
        CREATE TYPE verification_state AS ENUM (
            'unverified', 'supported', 'corroborated', 'verified'
        );
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'event_relationship_type') THEN
        CREATE TYPE event_relationship_type AS ENUM (
            'observed_at', 'affects', 'affected_by', 'caused_by', 'possibly_caused_by',
            'corroborates', 'duplicate_of', 'follow_up_to', 'responds_to',
            'removed', 'restored', 'rescued', 'verifies', 'disputes',
            'predicted_to_affect', 'supersedes'
        );
    END IF;
END
$$;

-- Taxonomy: the six subject families from the ontology, each with a fixed
-- set of subjects. Replaces free-text category columns going forward —
-- new code should reference subjects.subject_id, not a category string.
CREATE TABLE IF NOT EXISTS subjects (
    subject_id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    family              subject_family NOT NULL,
    code                TEXT NOT NULL,
    label               TEXT NOT NULL,
    parent_subject_id   UUID REFERENCES subjects(subject_id),
    is_active           BOOLEAN NOT NULL DEFAULT TRUE,
    CONSTRAINT subjects_family_code_unique UNIQUE (family, code)
);

CREATE INDEX IF NOT EXISTS idx_subjects_family ON subjects (family);

-- The raw human submission — what the contributor actually sent, before
-- Blue Mind interprets it into an event. One contribution normally
-- produces one event, but is kept separate so evidence and inference
-- never overwrite what was originally submitted (spec §13).
CREATE TABLE IF NOT EXISTS contributions (
    contribution_id     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    contributor_id      TEXT REFERENCES users(id),
    organization_id     UUID REFERENCES organizations(org_id),
    intake_method       TEXT NOT NULL DEFAULT 'upload'
                         CHECK (intake_method IN ('photo_video', 'tell_blue_mind', 'measurement', 'upload')),
    raw_text            TEXT,
    client_metadata     JSONB NOT NULL DEFAULT '{}'::jsonb,
    submitted_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_contributions_contributor_id ON contributions (contributor_id);
CREATE INDEX IF NOT EXISTS idx_contributions_submitted_at ON contributions (submitted_at DESC);

-- What Blue Mind determines happened. The central entity of the new
-- model (spec §3-4): one event, multiple subjects, one state, one
-- verification track, evidence and relationships hung off it.
CREATE TABLE IF NOT EXISTS environmental_events (
    event_id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    contribution_id      UUID REFERENCES contributions(contribution_id),
    legacy_activity_id   TEXT REFERENCES activities(id),
    title                TEXT,
    description          TEXT,
    event_state          event_state NOT NULL DEFAULT 'observed',
    verification_state   verification_state NOT NULL DEFAULT 'unverified',
    occurred_at          TIMESTAMPTZ,
    lat                  NUMERIC(9, 6),
    lon                  NUMERIC(9, 6),
    location_label       TEXT,
    location_source      provenance_source,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Location architecture (spec §18) — lat/lon/label/source above already
-- existed; these fill in the rest of the spec's component list.
-- location_accuracy_m/location_capture_method can only ever come from the
-- client (only the device knows its own GPS accuracy, or whether the
-- contributor dragged the pin away from wherever geolocation put it) —
-- 'manual_pin' is NOT a lesser source, just a different one, matching
-- spec §18's own point that a deliberately-placed pin is still legitimate,
-- it just isn't an automatic in-field GPS fix. admin_area/country/
-- water_body are never client-supplied — they're filled in by
-- locationEnrichmentService's background reverse-geocode lookup after the
-- event is created (spec §7.5/§17: EXTERNAL_ENRICHMENT), so a NULL here
-- means "not yet enriched" or "lookup found nothing", not "known empty".
-- coastal_region is NOT added — no reliable free gazetteer resolves an
-- informal region name like "Gulf Coast" from a lat/lon, and inventing one
-- would violate spec §17 ("AI/enrichment must not silently invent facts").
-- Field-level provenance for location (spec §17). `location_source` was a
-- single value covering the whole location, which stopped being true once
-- admin_area/country/water_body started arriving from a reverse-geocode:
-- those are EXTERNAL_ENRICHMENT while lat/lon are user_provided or
-- system_captured. Same { field: provenance_source } shape as
-- event_subjects.attribute_provenance; keys absent from the map fall back
-- to `location_source` at read time, so older rows keep their old meaning.
ALTER TABLE environmental_events ADD COLUMN IF NOT EXISTS location_provenance JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE environmental_events ADD COLUMN IF NOT EXISTS location_accuracy_m NUMERIC(10, 2);
ALTER TABLE environmental_events ADD COLUMN IF NOT EXISTS location_capture_method TEXT
    CHECK (location_capture_method IS NULL OR location_capture_method IN ('gps', 'manual_pin', 'unknown'));
ALTER TABLE environmental_events ADD COLUMN IF NOT EXISTS admin_area TEXT;
ALTER TABLE environmental_events ADD COLUMN IF NOT EXISTS country TEXT;
ALTER TABLE environmental_events ADD COLUMN IF NOT EXISTS water_body TEXT;

CREATE INDEX IF NOT EXISTS idx_environmental_events_event_state ON environmental_events (event_state);
CREATE INDEX IF NOT EXISTS idx_environmental_events_verification_state ON environmental_events (verification_state);
CREATE INDEX IF NOT EXISTS idx_environmental_events_legacy_activity_id ON environmental_events (legacy_activity_id);
CREATE INDEX IF NOT EXISTS idx_environmental_events_lat_lon ON environmental_events (lat, lon);

-- Bridge column so existing `activities` code paths (review, on-chain
-- proof, reward ledger) keep working untouched while new code can walk
-- from an activity to its event. Nullable, excluded from the on-chain
-- hash payload just like the weather columns.
ALTER TABLE activities ADD COLUMN IF NOT EXISTS environmental_event_id UUID REFERENCES environmental_events(event_id);
CREATE INDEX IF NOT EXISTS idx_activities_environmental_event_id ON activities (environmental_event_id);

-- Multi-subject support (spec §7-8): an event can carry several subjects
-- at once (e.g. Pollution → ghost net, Life → sea turtle, Habitat →
-- coral reef, Human Action → rescue), each with its own attributes and
-- its own provenance/confidence rather than one shared category field.
CREATE TABLE IF NOT EXISTS event_subjects (
    event_subject_id    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    event_id            UUID NOT NULL REFERENCES environmental_events(event_id) ON DELETE CASCADE,
    subject_id          UUID NOT NULL REFERENCES subjects(subject_id),
    attributes           JSONB NOT NULL DEFAULT '{}'::jsonb,
    attribute_provenance JSONB NOT NULL DEFAULT '{}'::jsonb,
    source               provenance_source NOT NULL DEFAULT 'user_provided',
    confidence           NUMERIC(4, 3) CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
    created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Additive: `source` above is the subject-level default (spec §17 fallback);
-- `attribute_provenance` is a { attributeKey: provenance_source } map so an
-- individual field — e.g. a contributor-corrected `quantity_kg` on an
-- otherwise AI-inferred subject — can carry its own provenance instead of
-- inheriting the subject's. Keys absent from the map (older rows, or
-- attributes nobody overrode) fall back to `source` at read time.
ALTER TABLE event_subjects ADD COLUMN IF NOT EXISTS attribute_provenance JSONB NOT NULL DEFAULT '{}'::jsonb;

CREATE INDEX IF NOT EXISTS idx_event_subjects_event_id ON event_subjects (event_id);
CREATE INDEX IF NOT EXISTS idx_event_subjects_subject_id ON event_subjects (subject_id);

-- Evidence as its own entity, separate from the event it supports, so
-- provenance survives independently of any later AI enrichment
-- (spec §13, §17). `capture_source` is what distinguishes an in-field
-- camera photo from a gallery upload (spec §18).
CREATE TABLE IF NOT EXISTS evidence (
    evidence_id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    event_id          UUID REFERENCES environmental_events(event_id) ON DELETE CASCADE,
    contribution_id   UUID REFERENCES contributions(contribution_id),
    evidence_type     TEXT NOT NULL
                       CHECK (evidence_type IN (
                           'photo', 'video', 'audio', 'document', 'measurement',
                           'dataset', 'gps', 'sensor_output', 'contributor_statement',
                           'organization_record', 'external_reference', 'verification_record'
                       )),
    storage_url       TEXT,
    gateway_url       TEXT,
    cid               TEXT,
    capture_source    TEXT CHECK (capture_source IN ('camera', 'gallery', 'upload', 'api', 'unknown')),
    captured_at       TIMESTAMPTZ,
    exif_lat          NUMERIC(9, 6),
    exif_lon          NUMERIC(9, 6),
    file_hash         TEXT,
    metadata          JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_evidence_event_id ON evidence (event_id);
CREATE INDEX IF NOT EXISTS idx_evidence_contribution_id ON evidence (contribution_id);

-- Typed relationships between events (spec §9-10) — corroboration,
-- duplicates, an action responding to an observation, and so on. Kept as
-- a single generic edge table rather than one table per relationship
-- type so the vocabulary can grow without schema changes.
CREATE TABLE IF NOT EXISTS event_relationships (
    relationship_id     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    from_event_id        UUID NOT NULL REFERENCES environmental_events(event_id) ON DELETE CASCADE,
    to_event_id          UUID NOT NULL REFERENCES environmental_events(event_id) ON DELETE CASCADE,
    relationship_type    event_relationship_type NOT NULL,
    created_by           TEXT,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT event_relationships_no_self_reference CHECK (from_event_id <> to_event_id),
    CONSTRAINT event_relationships_unique UNIQUE (from_event_id, to_event_id, relationship_type)
);

CREATE INDEX IF NOT EXISTS idx_event_relationships_from ON event_relationships (from_event_id);
CREATE INDEX IF NOT EXISTS idx_event_relationships_to ON event_relationships (to_event_id);

-- Every state transition, not just the current value — required so an
-- event's history is never lost the way a single `status` column loses
-- it today (spec §11, §26).
CREATE TABLE IF NOT EXISTS event_state_history (
    history_id      BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    event_id        UUID NOT NULL REFERENCES environmental_events(event_id) ON DELETE CASCADE,
    field           TEXT NOT NULL CHECK (field IN ('event_state', 'verification_state')),
    old_value       TEXT,
    new_value       TEXT NOT NULL,
    changed_by      TEXT,
    note            TEXT,
    changed_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_event_state_history_event_id ON event_state_history (event_id, changed_at DESC);

-- A verification pass against an event — distinct from the event's
-- current verification_state, which is the latest rollup of these.
CREATE TABLE IF NOT EXISTS verifications (
    verification_id   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    event_id          UUID NOT NULL REFERENCES environmental_events(event_id) ON DELETE CASCADE,
    verifier_id       TEXT REFERENCES users(id),
    outcome           TEXT NOT NULL CHECK (outcome IN ('verified', 'disputed', 'unable_to_verify')),
    notes             TEXT,
    onchain_tx_hash   TEXT,
    onchain_hash      TEXT,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_verifications_event_id ON verifications (event_id, created_at DESC);

-- Proof lifecycle columns to match `activities` (spec §21) — a verifier
-- attestation gets the same tamper-evident on-chain proof an approved
-- activity does. This is what actually closes the gap for action-events
-- (created via Plan Action) that have no legacy_activity_id at all and so,
-- until now, could never get a proof of any kind — a verification is the
-- only event through their lifecycle that reliably exists to hang one off.
ALTER TABLE verifications ADD COLUMN IF NOT EXISTS onchain_recorded_at TIMESTAMPTZ;
ALTER TABLE verifications ADD COLUMN IF NOT EXISTS onchain_status TEXT;
ALTER TABLE verifications ADD COLUMN IF NOT EXISTS onchain_submission_started_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_verifications_onchain_status ON verifications (onchain_status);

-- What changed as a consequence of an event (spec §4, §23) — e.g. kg of
-- debris removed, animals rescued. Kept as a metric ledger rather than
-- fixed columns so new metrics don't require schema changes.
CREATE TABLE IF NOT EXISTS event_impact (
    impact_id     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    event_id      UUID NOT NULL REFERENCES environmental_events(event_id) ON DELETE CASCADE,
    metric        TEXT NOT NULL,
    value         NUMERIC(14, 2) NOT NULL,
    unit          TEXT,
    recorded_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_event_impact_event_id ON event_impact (event_id);

-- The detailed internal signals behind an event's verification_state
-- (spec §14). The spec is explicit that the *exposed* levels stay coarse
-- (unverified/supported/corroborated/verified) and that we must not
-- "make a fake scientifically precise score" — so this deliberately
-- stores no weights and no composite number. Each signal only records
-- which way it leans, plus a human-readable reason, so a verifier can see
-- WHY an event sits where it does and judge for themselves.
--
-- Kept as a signal ledger rather than fixed columns, the same way
-- event_impact is, so new signals don't require a schema change.
CREATE TABLE IF NOT EXISTS confidence_signals (
    signal_id    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    event_id     UUID NOT NULL REFERENCES environmental_events(event_id) ON DELETE CASCADE,
    signal       TEXT NOT NULL,
    stance       TEXT NOT NULL CHECK (stance IN ('supports', 'weakens', 'neutral')),
    detail       TEXT,
    computed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT confidence_signals_event_signal_unique UNIQUE (event_id, signal)
);

CREATE INDEX IF NOT EXISTS idx_confidence_signals_event_id ON confidence_signals (event_id);

-- MEASUREMENT as its own entity (spec §26) — a structured environmental
-- reading (water quality, conditions), distinct from event_subjects'
-- generic {value, unit} JSONB attributes (which stay as-is for backward
-- compatibility and simple display). One row per parameter reading, so
-- each carries its own instrument/method/notes rather than one shared
-- value for an entire submission with several readings in it.
CREATE TABLE IF NOT EXISTS measurements (
    measurement_id    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    event_id          UUID NOT NULL REFERENCES environmental_events(event_id) ON DELETE CASCADE,
    event_subject_id  UUID REFERENCES event_subjects(event_subject_id) ON DELETE CASCADE,
    parameter         TEXT NOT NULL,
    value             NUMERIC(14, 4) NOT NULL,
    unit              TEXT,
    instrument        TEXT,
    method            TEXT CHECK (method IS NULL OR method IN ('instrument', 'informal')),
    notes             TEXT,
    source            provenance_source NOT NULL DEFAULT 'user_provided',
    recorded_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_measurements_event_id ON measurements (event_id);

-- EXTERNAL_ENRICHMENT as its own entity (spec §26) — an audit trail of
-- what an external lookup (reverse-geocode, weather archive) actually
-- returned, mirroring how ai_inferences already logs what the AI
-- classifier returned regardless of whether the contributor ever
-- confirmed it. event_id/activity_id are both nullable and either may be
-- set: location enrichment always has an event_id in scope; weather
-- backfill runs before the event is created, so it logs against
-- activity_id instead.
CREATE TABLE IF NOT EXISTS external_enrichments (
    enrichment_id  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    event_id       UUID REFERENCES environmental_events(event_id) ON DELETE CASCADE,
    activity_id    TEXT REFERENCES activities(id) ON DELETE CASCADE,
    source_system  TEXT NOT NULL,
    input          JSONB NOT NULL DEFAULT '{}'::jsonb,
    result         JSONB NOT NULL DEFAULT '{}'::jsonb,
    fetched_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_external_enrichments_event_id ON external_enrichments (event_id);
CREATE INDEX IF NOT EXISTS idx_external_enrichments_activity_id ON external_enrichments (activity_id);

-- Seed the taxonomy. ON CONFLICT DO NOTHING makes this safe to re-run as
-- the schema evolves and new subjects are added to the lists below.
INSERT INTO subjects (family, code, label) VALUES
    ('pollution_waste', 'plastic', 'Plastic'),
    ('pollution_waste', 'fishing_gear', 'Fishing gear / ghost gear'),
    ('pollution_waste', 'glass', 'Glass'),
    ('pollution_waste', 'metal', 'Metal'),
    ('pollution_waste', 'rubber', 'Rubber'),
    ('pollution_waste', 'textiles', 'Textiles'),
    ('pollution_waste', 'paper_cardboard', 'Paper / cardboard'),
    ('pollution_waste', 'wood', 'Wood'),
    ('pollution_waste', 'mixed_waste', 'Mixed waste'),
    ('pollution_waste', 'abandoned_object', 'Abandoned object'),
    ('pollution_waste', 'oil_petroleum', 'Oil / petroleum'),
    ('pollution_waste', 'chemical_discharge', 'Chemical discharge'),
    ('pollution_waste', 'sewage', 'Sewage'),
    ('pollution_waste', 'runoff', 'Runoff'),
    ('pollution_waste', 'foam', 'Foam'),
    ('pollution_waste', 'unknown_substance', 'Unknown substance'),
    ('pollution_waste', 'microplastics', 'Microplastics'),
    ('pollution_waste', 'pellets_nurdles', 'Pellets / nurdles'),
    ('pollution_waste', 'particulate_other', 'Other particulate material'),
    ('pollution_waste', 'noise_pollution', 'Noise pollution'),
    ('pollution_waste', 'light_pollution', 'Light pollution'),
    ('pollution_waste', 'thermal_pollution', 'Thermal pollution'),
    ('pollution_waste', 'air_odor_pollution', 'Air / odor pollution'),
    ('pollution_waste', 'pollution_other', 'Other pollution'),

    ('water', 'temperature', 'Temperature'),
    ('water', 'turbidity_clarity', 'Turbidity / clarity'),
    ('water', 'color', 'Color'),
    ('water', 'salinity', 'Salinity'),
    ('water', 'ph', 'pH'),
    ('water', 'dissolved_oxygen', 'Dissolved oxygen'),
    ('water', 'nutrients', 'Nutrients'),
    ('water', 'contaminants', 'Contaminants'),
    ('water', 'conductivity', 'Conductivity'),
    ('water', 'depth', 'Depth'),
    ('water', 'suspended_material', 'Suspended material'),
    ('water', 'microbial_indicators', 'Bacteria / microbial indicators'),
    ('water', 'chlorophyll', 'Chlorophyll'),
    ('water', 'water_other', 'Other water measurement'),

    ('life', 'fish', 'Fish'),
    ('life', 'marine_mammal', 'Marine mammal'),
    ('life', 'sea_turtle', 'Sea turtle'),
    ('life', 'shark_ray', 'Shark / ray'),
    ('life', 'crustacean', 'Crustacean'),
    ('life', 'mollusk', 'Mollusk'),
    ('life', 'invertebrate', 'Invertebrate'),
    ('life', 'bird', 'Bird'),
    ('life', 'coral', 'Coral'),
    ('life', 'seagrass', 'Seagrass'),
    ('life', 'algae_seaweed', 'Algae / seaweed'),
    ('life', 'mangrove_organism', 'Mangrove'),
    ('life', 'organism_other', 'Other organism'),

    ('habitat', 'coral_reef', 'Coral reef'),
    ('habitat', 'mangrove_habitat', 'Mangrove'),
    ('habitat', 'seagrass_bed', 'Seagrass bed'),
    ('habitat', 'beach_shoreline', 'Beach / shoreline'),
    ('habitat', 'estuary', 'Estuary'),
    ('habitat', 'wetland', 'Wetland'),
    ('habitat', 'river_stream', 'River / stream'),
    ('habitat', 'harbor_marina', 'Harbor / marina'),
    ('habitat', 'open_water', 'Open water'),
    ('habitat', 'dune', 'Dune'),
    ('habitat', 'rocky_shore', 'Rocky shore'),

    ('conditions', 'waves', 'Waves'),
    ('conditions', 'currents', 'Currents'),
    ('conditions', 'tide', 'Tide'),
    ('conditions', 'sea_state', 'Sea state'),
    ('conditions', 'water_level', 'Water level'),
    ('conditions', 'wind', 'Wind'),
    ('conditions', 'rain', 'Rain'),
    ('conditions', 'air_temperature', 'Air temperature'),
    ('conditions', 'storm_conditions', 'Storm conditions'),
    ('conditions', 'flooding', 'Flooding'),
    ('conditions', 'erosion', 'Erosion'),
    ('conditions', 'sediment_movement', 'Sediment movement'),
    ('conditions', 'storm_surge', 'Storm surge'),
    ('conditions', 'hurricane_cyclone', 'Hurricane / cyclone'),
    ('conditions', 'extreme_tide', 'Extreme tide'),
    ('conditions', 'heat_event', 'Heat event'),
    ('conditions', 'condition_anomaly_other', 'Other anomaly'),

    ('human_action', 'cleanup_removal', 'Cleanup / removal'),
    ('human_action', 'restoration', 'Restoration'),
    ('human_action', 'wildlife_rescue', 'Wildlife rescue'),
    ('human_action', 'monitoring_survey', 'Monitoring / survey'),
    ('human_action', 'research_sampling', 'Research / sampling'),
    ('human_action', 'education_outreach', 'Education / outreach'),
    ('human_action', 'prevention_interception', 'Prevention / interception'),
    ('human_action', 'infrastructure_intervention', 'Infrastructure intervention'),
    ('human_action', 'community_event', 'Community event'),
    ('human_action', 'policy_enforcement', 'Policy / enforcement activity')
ON CONFLICT (family, code) DO NOTHING;

-- Habitat "associated phenomena" (spec §7.4) — named explicitly in the
-- spec text (bleaching is literally spec §3's "Coral bleaching documented"
-- example event) but missing from the original seed above, which only
-- covered habitat *types*, not the phenomena that can happen to them.
INSERT INTO subjects (family, code, label) VALUES
    ('habitat', 'bleaching', 'Bleaching'),
    ('habitat', 'sedimentation', 'Sedimentation'),
    ('habitat', 'habitat_destruction', 'Habitat destruction'),
    ('habitat', 'vegetation_loss', 'Vegetation loss')
ON CONFLICT (family, code) DO NOTHING;


-- =====================================================================
-- Provenance completeness, missing conceptual entities, and relationship
-- flexibility (spec §9, §17, §26)
-- =====================================================================

-- Evidence provenance (spec §17): capture_source already distinguishes
-- camera vs. gallery, but says nothing about *who/what produced this
-- evidence record* — a contributor's upload vs. something an external
-- dataset later attaches. Reuses the same provenance_source enum
-- event_subjects already uses, for one consistent vocabulary.
ALTER TABLE evidence ADD COLUMN IF NOT EXISTS source provenance_source NOT NULL DEFAULT 'user_provided';

-- ORGANIZATION_MEMBERSHIP (spec §26): users.organization_id stays the
-- primary-org shortcut everything already reads — this is additive,
-- letting a person eventually belong to more than one org with a role,
-- without a breaking change to the column every existing query uses.
CREATE TABLE IF NOT EXISTS organization_memberships (
    membership_id     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id           TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    organization_id   UUID NOT NULL REFERENCES organizations(org_id) ON DELETE CASCADE,
    role              TEXT NOT NULL DEFAULT 'member',
    joined_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT organization_memberships_unique UNIQUE (user_id, organization_id)
);

CREATE INDEX IF NOT EXISTS idx_org_memberships_user ON organization_memberships (user_id);
CREATE INDEX IF NOT EXISTS idx_org_memberships_org ON organization_memberships (organization_id);

-- Backfill one membership per user who already has a primary org set.
INSERT INTO organization_memberships (user_id, organization_id, role)
SELECT id, organization_id, 'member' FROM users
WHERE organization_id IS NOT NULL
ON CONFLICT (user_id, organization_id) DO NOTHING;

-- AI_INFERENCE (spec §26): an audit trail of what the model actually
-- returned — without this there's no way to replay or debug a
-- classification after the fact. Deliberately not FK'd to an event: the
-- inference happens at draft time, before a contributor confirms
-- anything, so most rows will have event_id null forever (rejected
-- drafts, or drafts a contributor abandoned).
CREATE TABLE IF NOT EXISTS ai_inferences (
    inference_id    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    event_id        UUID REFERENCES environmental_events(event_id) ON DELETE SET NULL,
    requested_by    TEXT REFERENCES users(id),
    input_type      TEXT NOT NULL CHECK (input_type IN ('image', 'audio', 'document', 'text')),
    model           TEXT NOT NULL,
    raw_response    JSONB NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ai_inferences_event_id ON ai_inferences (event_id);
CREATE INDEX IF NOT EXISTS idx_ai_inferences_requested_by ON ai_inferences (requested_by);
CREATE INDEX IF NOT EXISTS idx_ai_inferences_created_at ON ai_inferences (created_at DESC);

-- VERIFIER (spec §26): supplementary profile info for a verifier —
-- credentials, specialty — kept separate from users.role='verifier'
-- rather than replacing it, so nothing that already reads role breaks.
CREATE TABLE IF NOT EXISTS verifiers (
    verifier_id     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
    credentials     TEXT,
    specialty       TEXT,
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Backfill a verifier profile for every existing verifier-role user.
INSERT INTO verifiers (user_id)
SELECT id FROM users WHERE role = 'verifier'
ON CONFLICT (user_id) DO NOTHING;


COMMIT;
