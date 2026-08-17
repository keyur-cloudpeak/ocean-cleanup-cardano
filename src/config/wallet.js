import './loadEnv.js';

/**
 * Wallet Configuration Module
 * Holds the backend wallet used to sign on-chain proof transactions.
 */

export const walletConfig = {
  backend: {
    seedPhrase: process.env.MINTER_SEED_PHRASE || null
  }
};

export function assertProofWalletConfigured() {
  if (!walletConfig.backend.seedPhrase) {
    throw new Error('Backend proof wallet is not configured. Missing env var: MINTER_SEED_PHRASE');
  }
}

/**
 * Validates all wallet configuration during startup
 * @throws {Error} if configuration is incomplete
 */
export function validateWalletSetup() {
  console.log('🔐 Validating wallet setup...');

  // This is the sole wallet required by the application.
  try {
    assertProofWalletConfigured();
    console.log('✅ Backend proof wallet configured');
  } catch (error) {
    console.error('❌ Backend proof wallet setup failed:', error.message);
    throw error;
  }

  console.log('✅ All wallet configurations are valid\n');
}

/**
 * Gets formatted wallet info for logging/debugging
 * @returns {object} - Sanitized wallet config info
 */
export function getWalletInfo() {
  return {
    proofWalletConfigured: !!walletConfig.backend.seedPhrase
  };
}

export default walletConfig;
