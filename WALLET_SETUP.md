# Backend Proof Wallet Setup

The application uses one Cardano wallet only: the server-side wallet that signs and funds activity-proof transactions. User accounts never provide, store, or validate a wallet address.

## Required environment

```env
# Keep this BIP-39 phrase secret and out of version control.
MINTER_SEED_PHRASE="your twelve or twenty-four word seed phrase"

# Cardano access for proof submission and verification.
BLOCKFROST_API_KEY=your_blockfrost_project_id
CARDANO_NETWORK=Preprod

# Optional: overrides the URL selected from CARDANO_NETWORK.
BLOCKFROST_URL=https://cardano-preprod.blockfrost.io/api/v0
```

The backend wallet makes a self-payment and attaches the approved activity's metadata and deterministic hash. It needs ADA for fees and the minimum UTxO, but no value is sent to a contributor.

## Flow

1. A contributor creates an account and submits an activity without a wallet.
2. A verifier or admin approves it.
3. The backend records the proof asynchronously on Cardano.
4. Any partner, NGO, or contributor reads `GET /api/activities/:id/proof` without authentication or a wallet.

At startup, `validateWalletSetup()` verifies only that `MINTER_SEED_PHRASE` is available. Proof submission also requires a valid Blockfrost configuration.

## Security

- Keep `MINTER_SEED_PHRASE` in a secret manager or protected environment variable.
- Fund the dedicated backend wallet with only the ADA needed for proof transaction fees and minimum UTxOs.
- Never commit `.env` files or seed phrases.
