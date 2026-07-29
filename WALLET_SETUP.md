# Wallet Setup Configuration

This guide explains how to set up and configure wallets for the Ocean Cleanup Backend with Cardano.

## Overview

The backend supports two wallet scenarios:
1. **Minter Wallet** - The wallet that mints reward tokens to contributors
2. **User Wallets** - Individual contributor wallets that receive rewards

## Environment Variables

All wallet configuration is managed through environment variables in the `.env` file.

### Minter Wallet Configuration

The minter wallet is responsible for minting OCEAN tokens as rewards for approved activities.

#### Required Variables:

```env
# BIP-39 seed phrase for the wallet that mints rewards
# Keep this secure and out of version control
MINTER_SEED_PHRASE="vault story loyal weasel insect memory mixture turkey rate kitten shoe service super mad jewel yellow any hold camp rubber involve skirt pen horn"

# Blockfrost API key for Cardano network access
BLOCKFROST_API_KEY=preproddONCHuQphxv9EWJ10mitxSkYc5G7BNId

# Cardano network: Mainnet, Preprod, or Preview
CARDANO_NETWORK=Preprod

# URL for Blockfrost API (optional - auto-configured based on network)
BLOCKFROST_URL=https://cardano-preprod.blockfrost.io/api/v0

# Compiled minting policy from aiken build
# See cardano/README.md for how to generate this
REWARD_POLICY_COMPILED_CODE=5897010100229800aba2aba1aab9faab9eaab9dab9a9bae002488888896600264646644b30013370e900018039baa00189991198008009bac300c300d300d300d300d300d300d300d300d300a3754601800c6eb8c028c020dd5000912cc00400629422b30013371e6eb8c03000401e2946266004004601a002804100b459006180400098041804800980400098021baa0088a4d13656400801

# Asset name for minting (default: OCEAN)
REWARD_ASSET_NAME=OCEAN
```

### User Wallet Configuration

Users set their wallet addresses via the API:

```
POST /api/auth/wallet
Authorization: Bearer <user-token>
Content-Type: application/json

{
  "walletAddress": "addr_test1qzrva6a3r69aqtmkx39ayuw2jdsgp0hqhz3njv3hd9z2yg6hf7jqqy0r4mmxyhxw7cmn5g0yp3gtvutfvq2mv0x9sq33vgwu"
}
```

## Wallet Address Formats

The backend supports both mainnet and testnet Cardano addresses:

| Network | Prefix | Example Length | Status |
|---------|--------|----------------|--------|
| Mainnet | `addr1` | 58+ chars | Production |
| Testnet | `addr_test1` | 58+ chars | Development |

**Validation Rules:**
- Must start with `addr1` (mainnet) or `addr_test1` (testnet)
- Minimum 50 characters
- Valid Bech32 encoded address

## Setup Steps

### 1. Generate Minter Wallet (First Time Setup)

```bash
# Install cardano-cli or use lucid-evolution to generate a wallet
# Example using a tool like cardano-cli:
cardano-cli address key-gen \
  --verification-key-file minter.vkey \
  --signing-key-file minter.skey

# Extract the seed phrase and store it securely
```

### 2. Compile Minting Policy

See `cardano/README.md` for instructions to:
1. Run `aiken build` in the cardano directory
2. Extract the CBOR hex from `cardano/plutus.json`
3. Set `REWARD_POLICY_COMPILED_CODE` in `.env`

### 3. Verify Blockfrost Configuration

```bash
# Test Blockfrost connection:
curl -H "project_id: YOUR_BLOCKFROST_API_KEY" \
  https://cardano-preprod.blockfrost.io/api/v0/health
```

### 4. Start the Server

The server will validate all wallet configuration on startup:

```bash
npm start
```

You should see:
```
🔐 Validating wallet setup...
✅ Minter wallet configured
✅ Reward asset name: OCEAN
✅ All wallet configurations are valid
```

## Wallet Validation

The backend provides automatic wallet validation at:

1. **Startup** - Full wallet config validation in `validateWalletSetup()`
2. **User Registration** - Address format validation via `isValidCardanoAddress()`
3. **Activity Approval** - Minting wallet verification before minting

### Available Validation Functions

```javascript
// src/config/wallet.js

// Validate Cardano address format
isValidCardanoAddress(address) -> boolean

// Detect if address is mainnet or testnet
detectAddressNetwork(address) -> 'mainnet' | 'testnet' | null

// Assert minter wallet is configured
assertMinterWalletConfigured() -> throws Error

// Full startup validation
validateWalletSetup() -> throws Error

// Get wallet info for logging
getWalletInfo() -> object
```

## Common Issues

### Missing MINTER_SEED_PHRASE
```
Error: Minter wallet is not configured. Missing env vars: MINTER_SEED_PHRASE
```
**Solution:** Add `MINTER_SEED_PHRASE` to `.env`

### Invalid Blockfrost API Key
```
Error: Request failed with status code 401
```
**Solution:** Verify `BLOCKFROST_API_KEY` is correct for the network

### Contributor Has No Wallet
```
Error: Contributor has not linked a Cardano wallet address yet (POST /api/auth/wallet)
```
**Solution:** User must call `POST /api/auth/wallet` with their address

### Invalid Cardano Address
```
Error: A valid Cardano address is required (addr1 for mainnet or addr_test1 for testnet)
```
**Solution:** Ensure address starts with `addr1` or `addr_test1` and is properly formatted

## Network Compatibility

The minting wallet and contributor wallets must be on the **same network**:

- ✅ Minter on Preprod + Contributors on Preprod = Works
- ❌ Minter on Mainnet + Contributors on Testnet = Fails

Set `CARDANO_NETWORK=Preprod` to use testnet for development.

## Security Best Practices

1. **Never commit `.env` to version control** - Add `.env` to `.gitignore`
2. **Use environment variables in production** - Don't hardcode sensitive values
3. **Rotate seed phrases regularly** - Update `MINTER_SEED_PHRASE` periodically
4. **Audit wallet transactions** - Monitor minting activity on Blockfrost
5. **Limit wallet permissions** - Use a dedicated minting wallet, not your main wallet

## Testing Wallet Configuration

```bash
# Test wallet validation
npm test -- --testPathPattern="wallet"

# Check current configuration (sanitized)
curl http://localhost:3000/api/health
```

## Additional Resources

- [Blockfrost Documentation](https://docs.blockfrost.io/)
- [Lucid Evolution](https://github.com/spacebudz/lucid)
- [Cardano Addresses](https://cips.cardano.org/cips/cip19/)
- [Aiken Documentation](https://aiken-lang.org/)
