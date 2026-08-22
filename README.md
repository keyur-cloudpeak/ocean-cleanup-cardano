# Ocean Cleanup Backend

Express.js backend API for the Ocean Cleanup tracking platform.

## Features

- PostgreSQL-backed authentication, activity tracking, and dashboard stats
- Activity submission, review, and on-chain proof APIs
- File uploads and IPFS upload support
- Modular routes, controllers, and services

## API Endpoints

- `GET /api/health` - Health check
- `GET /api/activities` - List activities (`?status=pending|approved|rejected`)
- `POST /api/activities` - Submit a new activity
- `GET /api/activities/:id` - Get activity details
- `POST /api/activities/:id/review` - Review an activity
- `GET /api/activities/:id/proof` - Read an activity's public on-chain proof
- `GET /api/dashboard/stats` - Dashboard statistics
- `POST /api/uploads` - Handle file uploads
- `POST /api/auth/signup` - Register a user
- `POST /api/auth/login` - Login
- `GET /api/auth/verify` - Verify JWT

## Environment Variables

Create a `.env` file with at least:

```env
PORT=3000
HOST=localhost
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/ocean_db
JWT_SECRET=your_secret_here

# Email verification (required for Citizen/Contributor signup)
EMAIL_PROVIDER=gmail
GMAIL_USER=your-gmail-address@gmail.com
GMAIL_APP_PASSWORD=your-16-character-gmail-app-password
API_BASE_URL=http://localhost:3000

# Cardano on-chain proofs
CARDANO_NETWORK=Preprod
BLOCKFROST_API_KEY=your_blockfrost_project_id
MINTER_SEED_PHRASE=your twelve or twenty-four word seed phrase

# Optional: points awarded once when a contributor's activity is approved.
POINTS_PER_APPROVED_ACTIVITY=10
```

`JWT_SECRET` has an insecure default (`fallback_secret_key_for_dev`) if unset — always set it explicitly outside local dev.

Email verification uses Gmail through Nodemailer. Enable 2-Step Verification
for the Gmail account, create a 16-character Google App Password, and set
`GMAIL_USER` and `GMAIL_APP_PASSWORD` in `.env`. Use the app password without
spaces. `EMAIL_PROVIDER=console` is only a local development mode; it prints
the verification URL in the server terminal and does not send an email.

## Database

Run the PostgreSQL schema in `db/schema.sql` before starting the server. User accounts do not store Cardano wallet addresses.

## Cardano On-chain Proofs

An approved activity is timestamped on Cardano by a transaction signed and
funded by the backend's configured wallet. The transaction pays that same
wallet and records a deterministic activity hash in its metadata.

1. A verifier/admin approves an activity (`POST /api/activities/:id/review`).
2. The backend submits the proof asynchronously using `MINTER_SEED_PHRASE`.
3. Anyone can call `GET /api/activities/:id/proof` to retrieve the transaction and verify that the current activity row still matches the recorded hash.

No contributor, citizen, verifier, or partner wallet is collected or required.

## Points and audit trail

When an activity is approved, the backend adds one idempotent entry to
`reward_ledger`. The contributor's points are available through contributor
stats, and the amount can be configured with `POINTS_PER_APPROVED_ACTIVITY`
(default: `10`). Activity submission, review, proof submission, and proof
confirmation are also recorded in `activity_events`.

## Getting Started

1. Install dependencies:

```bash
npm install
```

2. Start the server:

```bash
npm start
```
