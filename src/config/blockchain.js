import './loadEnv.js';

const BLOCKFROST_URLS = {
  Mainnet: 'https://cardano-mainnet.blockfrost.io/api/v0',
  Preprod: 'https://cardano-preprod.blockfrost.io/api/v0',
  Preview: 'https://cardano-preview.blockfrost.io/api/v0'
};

function normalizeNetwork(value) {
  const network = String(value || 'Preprod').trim();
  const match = ['Mainnet', 'Preprod', 'Preview'].find(
    (n) => n.toLowerCase() === network.toLowerCase()
  );
  return match || 'Preprod';
}

const network = normalizeNetwork(process.env.CARDANO_NETWORK);

export const blockchainConfig = {
  // 'Mainnet' | 'Preprod' | 'Preview'
  network,
  blockfrostApiKey: process.env.BLOCKFROST_API_KEY || null,
  blockfrostUrl: process.env.BLOCKFROST_URL || BLOCKFROST_URLS[network],

  // BIP-39 seed phrase for the wallet that pays fees and is authorized to
  // mint reward tokens (its verification key hash is baked into the
  // parameterized minting policy). Keep this out of source control.
  minterSeedPhrase: process.env.MINTER_SEED_PHRASE || null,

  // Compiled (unparameterized) validator CBOR hex, copied from
  // cardano/plutus.json after `aiken build`. See cardano/README.md.
  rewardPolicyCompiledCode: process.env.REWARD_POLICY_COMPILED_CODE || null,

  // Default asset name minted for activity rewards. Cardano asset names are
  // raw bytes (hex on-chain); the backend converts this text for you.
  rewardAssetName: process.env.REWARD_ASSET_NAME || 'OCEAN'
};

export function assertMintingConfigured() {
  const missing = [];
  if (!blockchainConfig.blockfrostApiKey) missing.push('BLOCKFROST_API_KEY');
  if (!blockchainConfig.minterSeedPhrase) missing.push('MINTER_SEED_PHRASE');
  if (!blockchainConfig.rewardPolicyCompiledCode) missing.push('REWARD_POLICY_COMPILED_CODE');

  if (missing.length > 0) {
    throw new Error(`Cardano minting is not configured. Missing env vars: ${missing.join(', ')}`);
  }
}

export default blockchainConfig;
