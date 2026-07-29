# Reward Token Minting Policy (Aiken)

A minimal, signature-gated minting policy: tokens under this policy can only
be minted or burned in a transaction signed by the backend's Cardano wallet
(`minter`, a verification key hash). All business logic (has this activity
been reviewed? is it approved? how many tokens does it earn?) stays off-chain
in the Node backend — this contract's only job is to stop anyone else from
forging reward tokens under this policy ID.

## Prerequisites

Install the Aiken toolchain: https://aiken-lang.org/installation-instructions

```bash
aiken --version   # developed against 1.1.x
```

## Build

```bash
cd cardano
aiken check        # run the test suite (add tests under validators/ as you extend this)
aiken build         # produces plutus.json (the CIP-57 blueprint)
```

`plutus.json` contains the *unparameterized* compiled script. Since the
validator takes `minter: VerificationKeyHash` as a compile-time parameter,
the backend applies that parameter at runtime with Lucid Evolution
(`applyParamsToScript`) rather than you hardcoding it and rebuilding every
time you rotate keys — see `src/contracts/contractService.js`.

## Getting the pieces the backend needs

1. **Compiled script (CBOR hex, pre-parameterization)**
   In `plutus.json`, find the validator named `reward_token.reward_token.mint`
   (or similar — `aiken build` prints the exact title) and copy its
   `compiledCode` field. That's `REWARD_POLICY_COMPILED_CODE` in the
   backend's `.env`.

2. **Minter verification key hash**
   This is the payment key hash of the Cardano wallet the backend controls
   (derived from `MINTER_SEED_PHRASE`). The backend computes this itself at
   startup via Lucid — you don't need to paste it anywhere, but if you want
   to sanity-check it against `cardano-cli` or a wallet tool, it's the
   `VerificationKeyHash` your seed phrase's first payment address hashes to.

3. **Policy ID**
   Derived automatically by the backend (`mintingPolicyToId`) once the
   script is parameterized with your minter key hash — this is what
   `REWARD_POLICY_ID` will show up as in logs the first time you mint. You
   don't need to compute it by hand.

## Testing on a testnet

Use **Preprod** or **Preview** while developing:

- Get a Blockfrost project ID for the network you pick: https://blockfrost.io
- Fund the backend's wallet with test ADA from a faucet:
  https://docs.cardano.org/cardano-testnets/tools/faucet
- The wallet needs a small amount of ADA to cover fees + min-UTxO for every
  mint transaction (a few ADA is plenty to start).

## Extending this later

If you outgrow "backend signs off on every mint" (e.g. you want on-chain
verification of activity data, multi-sig approval, or a DAO-style review
process), that logic belongs in this validator as additional `mint`
conditions, or in a companion `spend` validator that gates a review/approval
UTxO. That's a bigger lift — happy to help design it when you're ready.
