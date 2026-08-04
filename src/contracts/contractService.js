import {
  Lucid,
  Blockfrost,
  Data,
  fromText,
  applyParamsToScript,
  mintingPolicyToId,
  getAddressDetails
} from '@lucid-evolution/lucid';
import { blockchainConfig, assertMintingConfigured } from '../config/blockchain.js';

function normalizeMetadataValue(value) {
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === 'bigint') {
    return Number(value);
  }

  if (typeof value === 'string') {
    const text = value.trim();
    if (!text) {
      return '';
    }

    return text.length > 64 ? text.slice(0, 64) : text;
  }

  return String(value).slice(0, 64);
}

export function buildRewardMetadata({ activity, label }) {
  const metadata = {
    label: normalizeMetadataValue(label),
    category: normalizeMetadataValue(activity?.category),
    location: normalizeMetadataValue(activity?.location),
    quantity: normalizeMetadataValue(activity?.quantity),
    activityId: normalizeMetadataValue(activity?.id),
    volunteers: normalizeMetadataValue(activity?.volunteers),
    contributorId: normalizeMetadataValue(activity?.contributorId)
  };

  return metadata;
}

let lucidPromise = null;
let mintingPolicyPromise = null;

async function getLucid() {
  if (!lucidPromise) {
    lucidPromise = (async () => {
      const provider = new Blockfrost(blockchainConfig.blockfrostUrl, blockchainConfig.blockfrostApiKey);
      const lucid = await Lucid(provider, blockchainConfig.network);
      lucid.selectWallet.fromSeed(blockchainConfig.minterSeedPhrase);
      return lucid;
    })();
  }
  return lucidPromise;
}

// Parameterizes the compiled validator with the minter wallet's own
// verification key hash, so the on-chain script matches whatever wallet
// MINTER_SEED_PHRASE actually resolves to.
async function getMintingPolicy() {
  if (!mintingPolicyPromise) {
    mintingPolicyPromise = (async () => {
      const lucid = await getLucid();
      const ownAddress = await lucid.wallet().address();
      const { paymentCredential } = getAddressDetails(ownAddress);

      if (!paymentCredential) {
        throw new Error('Could not resolve a payment credential for the minter wallet');
      }

      const script = applyParamsToScript(blockchainConfig.rewardPolicyCompiledCode, [
        paymentCredential.hash
      ]);

      return {
        mintingPolicy: { type: 'PlutusV3', script },
        minterKeyHash: paymentCredential.hash
      };
    })();
  }
  return mintingPolicyPromise;
}

export class ContractService {
  // Kept for API compatibility with earlier callers of this service.
  async submitActivity(payload) {
    return { ok: true, payload };
  }

  async verifyActivity(id) {
    return { ok: true, id };
  }

  /**
   * Mints `amount` units of `assetName` under the reward policy and sends
   * them to `recipientAddress`.
   *
   * @param {object} params
   * @param {string} params.recipientAddress - bech32 Cardano address (the contributor's wallet)
   * @param {number|string} params.amount - whole-unit token amount (no decimals here)
   * @param {string} [params.assetName] - defaults to blockchainConfig.rewardAssetName
   * @returns {Promise<{ txHash: string, policyId: string, unit: string, amount: string }>}
   */
  async mintReward({ recipientAddress, amount, assetName, activity }) {
    assertMintingConfigured();

    if (!recipientAddress) {
      throw new Error('recipientAddress is required to mint a reward');
    }

    const quantity = BigInt(Math.trunc(Number(amount)));
    if (!(quantity > 0n)) {
      throw new Error('amount must be a positive integer');
    }

    const lucid = await getLucid();
    const { mintingPolicy, minterKeyHash } = await getMintingPolicy();
    const policyId = mintingPolicyToId(mintingPolicy);
    const unit = policyId + fromText(assetName || blockchainConfig.rewardAssetName);
    const rewardMetadata = buildRewardMetadata({
      activity,
      label: `Ocean Cleanup Reward - ${assetName || blockchainConfig.rewardAssetName}`.toLowerCase()
    });

    const tx = await lucid
      .newTx()
      .mintAssets({ [unit]: quantity }, Data.void())
      .attach.MintingPolicy(mintingPolicy)
      .attachMetadata(721, rewardMetadata)
      .pay.ToAddress(recipientAddress, { [unit]: quantity })
      .addSigner(await lucid.wallet().address())
      .complete();

    const signedTx = await tx.sign.withWallet().complete();
    const txHash = await signedTx.submit();

    return {
      txHash,
      policyId,
      unit,
      minterKeyHash,
      amount: quantity.toString()
    };
  }
}

export default new ContractService();
