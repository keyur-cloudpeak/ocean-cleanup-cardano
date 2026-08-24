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


COMMIT;
