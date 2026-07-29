import './loadEnv.js';
import { walletConfig, assertMinterWalletConfigured } from './wallet.js';

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
  minterSeedPhrase: walletConfig.minter.seedPhrase,

  // Compiled (unparameterized) validator CBOR hex, copied from
  // cardano/plutus.json after `aiken build`. See cardano/README.md.
  rewardPolicyCompiledCode: walletConfig.minter.policyCompiledCode,

  // Default asset name minted for activity rewards. Cardano asset names are
  // raw bytes (hex on-chain); the backend converts this text for you.
  rewardAssetName: walletConfig.minter.rewardAssetName
};

export function assertMintingConfigured() {
  assertMinterWalletConfigured();
}

export default blockchainConfig;
