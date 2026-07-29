# Ocean Cleanup Backend

Express.js backend API for the Ocean Cleanup tracking platform.

## Features

- PostgreSQL-backed authentication, activity tracking, and dashboard stats
- Activity submission, review, and reward minting APIs
- File uploads and IPFS upload support
- Modular routes, controllers, and services

## API Endpoints

- `GET /api/health` - Health check
- `GET /api/activities` - List activities (`?status=pending|approved|rejected`)
- `POST /api/activities` - Submit a new activity
- `GET /api/activities/:id` - Get activity details
- `POST /api/activities/:id/review` - Review an activity
- `POST /api/activities/:id/mint` - Mint reward tokens for an activity
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

# Cardano reward minting (see cardano/README.md for how to get these)
CARDANO_NETWORK=Preprod
BLOCKFROST_API_KEY=your_blockfrost_project_id
MINTER_SEED_PHRASE=your twelve or twenty-four word seed phrase
REWARD_POLICY_COMPILED_CODE=compiled_code_from_plutus_json
REWARD_ASSET_NAME=OCEAN
```

`JWT_SECRET` has an insecure default (`fallback_secret_key_for_dev`) if unset — always set it explicitly outside local dev.

## Database

Run the PostgreSQL schema in `db/schema.sql` before starting the server. This includes a `users.wallet_address` column contributors must set (via `POST /api/auth/wallet`) before a reward can be minted to them.

## Cardano Reward Minting

Reward tokens are minted as native Cardano assets under an Aiken minting
policy (`cardano/`) that only allows minting/burning in transactions signed
by the backend's own wallet. The flow:

1. A verifier/admin approves an activity (`POST /api/activities/:id/review`).
2. The contributor links a Cardano wallet address (`POST /api/auth/wallet`, `{ "walletAddress": "addr_test1..." }`).
3. A verifier/admin calls `POST /api/activities/:id/mint` — the backend builds, signs, and submits a real transaction via Blockfrost + Lucid Evolution, minting reward tokens straight to the contributor's wallet, and stores the resulting tx hash.

See `cardano/README.md` for building the validator and getting `REWARD_POLICY_COMPILED_CODE`.

## Getting Started

1. Install dependencies:

```bash
npm install
```

2. Start the server:

```bash
npm start
```
