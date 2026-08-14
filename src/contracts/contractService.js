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
    return '';
  }

  if (typeof value === 'boolean') {
    return value ? 'true' : 'false';
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }

  if (typeof value === 'bigint') {
    return String(value);
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

function resolveVerifiedValue(activity) {
  if (activity?.verified !== undefined && activity?.verified !== null) {
    return activity.verified;
  }

  if (activity?.status === 'approved') {
    return true;
  }

  return false;
}

export function buildRewardMetadata({ activity, label }) {
  const metadata = {
    label: normalizeMetadataValue(label),
    category: normalizeMetadataValue(activity?.category),
    location: normalizeMetadataValue(activity?.location),
    quantity: normalizeMetadataValue(activity?.quantity),
    activityId: normalizeMetadataValue(activity?.id),
    volunteers: normalizeMetadataValue(activity?.volunteers),
    contributorId: normalizeMetadataValue(activity?.contributorId),
    verified: normalizeMetadataValue(resolveVerifiedValue(activity))
  };

  return metadata;
}

/** Ensures a hex string has even length (pads with a leading zero if needed). */
function padHex(hex) {
  return typeof hex === 'string' && hex.length % 2 !== 0 ? '0' + hex : hex;
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

      const script = applyParamsToScript(padHex(blockchainConfig.rewardPolicyCompiledCode), [
        padHex(paymentCredential.hash)
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

  // A simple queue to serialize minting operations and prevent UTXO contention
  mintQueue = Promise.resolve();

  async mintReward(params) {
    return new Promise((resolve, reject) => {
      this.mintQueue = this.mintQueue.then(async () => {
        try {
          const result = await this._mintRewardUnsafe(params);
          resolve(result);
        } catch (err) {
          reject(err);
        }
      });
    });
  }

  /**
   * Internal unsafe mint. Callers should use mintReward() to queue calls safely.
   */
  async _mintRewardUnsafe({ recipientAddress, amount, assetName, activity }) {
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

    // Wait for the transaction to hit the chain to avoid spending the same UTXO again
    try {
      if (typeof lucid.awaitTx === 'function') {
        await lucid.awaitTx(txHash);
      } else {
        await new Promise(r => setTimeout(r, 20000));
      }
    } catch (err) {
      console.warn(`[ContractService] wait for tx ${txHash} failed, continuing anyway:`, err.message);
    }

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
