import './loadEnv.js';

/**
 * Wallet Configuration Module
 * Handles all wallet setup, validation, and initialization
 */

// Cardano address patterns
const CARDANO_MAINNET_PATTERN = /^addr1[a-z0-9]{58}$/;
const CARDANO_TESTNET_PATTERN = /^addr_test1[a-z0-9]{58}$/;
const CARDANO_ADDRESS_PATTERN = /^(addr1|addr_test1)[a-z0-9]+$/;

export const walletConfig = {
  // Minter wallet (used for minting rewards)
  minter: {
    seedPhrase: process.env.MINTER_SEED_PHRASE || null,
    rewardAssetName: process.env.REWARD_ASSET_NAME || 'OCEAN',
    policyCompiledCode: process.env.REWARD_POLICY_COMPILED_CODE || null
  },

  // Wallet validation settings
  validation: {
    addressPattern: CARDANO_ADDRESS_PATTERN,
    mainnetPattern: CARDANO_MAINNET_PATTERN,
    testnetPattern: CARDANO_TESTNET_PATTERN,
    minAddressLength: 50
  }
};

/**
 * Validates a Cardano wallet address format
 * @param {string} address - Bech32 Cardano address
 * @returns {boolean} - True if valid
 */
export function isValidCardanoAddress(address) {
  if (!address || typeof address !== 'string') {
    return false;
  }
  return walletConfig.validation.addressPattern.test(address);
}

/**
 * Determines if address is mainnet or testnet
 * @param {string} address - Bech32 Cardano address
 * @returns {string|null} - 'mainnet', 'testnet', or null
 */
export function detectAddressNetwork(address) {
  if (!isValidCardanoAddress(address)) {
    return null;
  }
  if (walletConfig.validation.mainnetPattern.test(address)) {
    return 'mainnet';
  }
  if (walletConfig.validation.testnetPattern.test(address)) {
    return 'testnet';
  }
  return null;
}

/**
 * Validates minter wallet configuration
 * @throws {Error} if minter wallet is not properly configured
 */
export function assertMinterWalletConfigured() {
  const missing = [];
  if (!walletConfig.minter.seedPhrase) {
    missing.push('MINTER_SEED_PHRASE');
  }
  if (!walletConfig.minter.policyCompiledCode) {
    missing.push('REWARD_POLICY_COMPILED_CODE');
  }

  if (missing.length > 0) {
    throw new Error(
      `Minter wallet is not configured. Missing env vars: ${missing.join(', ')}\n` +
      'Set these in your .env file or environment variables.'
    );
  }
}

/**
 * Validates all wallet configuration during startup
 * @throws {Error} if configuration is incomplete
 */
export function validateWalletSetup() {
  console.log('🔐 Validating wallet setup...');

  // Check minter wallet
  try {
    assertMinterWalletConfigured();
    console.log('✅ Minter wallet configured');
  } catch (error) {
    console.error('❌ Minter wallet setup failed:', error.message);
    throw error;
  }

  // Check reward asset name
  if (!walletConfig.minter.rewardAssetName) {
    throw new Error('REWARD_ASSET_NAME environment variable is required');
  }
  console.log(`✅ Reward asset name: ${walletConfig.minter.rewardAssetName}`);

  console.log('✅ All wallet configurations are valid\n');
}

/**
 * Gets formatted wallet info for logging/debugging
 * @returns {object} - Sanitized wallet config info
 */
export function getWalletInfo() {
  return {
    minterConfigured: !!walletConfig.minter.seedPhrase && !!walletConfig.minter.policyCompiledCode,
    rewardAssetName: walletConfig.minter.rewardAssetName,
    supportedNetworks: ['mainnet', 'testnet']
  };
}

export default walletConfig;
