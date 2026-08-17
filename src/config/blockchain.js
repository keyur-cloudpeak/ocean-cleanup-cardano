import './loadEnv.js';
import { walletConfig, assertProofWalletConfigured } from './wallet.js';

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

  // BIP-39 seed phrase for the backend wallet that pays transaction fees and
  // signs the self-payment which records activity metadata.
  proofSeedPhrase: walletConfig.backend.seedPhrase
};

export function assertProofConfigured() {
  assertProofWalletConfigured();
}

export default blockchainConfig;
