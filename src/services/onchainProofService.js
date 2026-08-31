import crypto from 'crypto';
import { Lucid, Blockfrost } from '@lucid-evolution/lucid';
import { blockchainConfig, assertProofConfigured } from '../config/blockchain.js';
import { query } from '../config/connection.js';
import { recordActivityEvent } from './activityEventService.js';

/**
 * On-chain proof service.
 *
 * Every approved activity gets ONE real Cardano transaction, submitted by the
 * backend's own wallet, that carries the activity's data as transaction
 * metadata (label 8434 - unofficial/custom label, safe to reuse). No user
 * wallet is involved anywhere in this flow - the backend wallet pays its own
 * fee and is both sender and receiver (a self-payment), so the only purpose
 * of the transaction is to timestamp the metadata on-chain.
 *
 * This uses MINTER_SEED_PHRASE and Blockfrost only; no user wallet or reward
 * minting configuration is required.
 */

const PROOF_METADATA_LABEL = 8434;

let lucidPromise = null;

async function getLucid() {
  if (!lucidPromise) {
    lucidPromise = (async () => {
      const provider = new Blockfrost(
        blockchainConfig.blockfrostUrl,
        blockchainConfig.blockfrostApiKey
      );
      const lucid = await Lucid(provider, blockchainConfig.network);
      lucid.selectWallet.fromSeed(blockchainConfig.proofSeedPhrase);
      return lucid;
    })();
  }
  return lucidPromise;
}

/**
 * Truncates a value to a safe length for Cardano tx metadata
 * (each string field is capped at 64 bytes on-chain).
 */
function meta(value) {
  if (value === null || value === undefined) return '';
  const text = typeof value === 'string' ? value : String(value);
  return text.length > 64 ? text.slice(0, 64) : text;
}

/**
 * Reads the proof metadata from the submitted transaction, independently of
 * our database. Blockfrost returns one item per metadata label.
 */
async function fetchProofMetadataFromChain(txHash) {
  if (!blockchainConfig.blockfrostApiKey) {
    throw new Error('Blockfrost is not configured');
  }

  const baseUrl = blockchainConfig.blockfrostUrl.replace(/\/$/, '');
  const response = await fetch(
    `${baseUrl}/txs/${encodeURIComponent(txHash)}/metadata`,
    { headers: { project_id: blockchainConfig.blockfrostApiKey } }
  );

  if (!response.ok) {
    throw new Error(`Blockfrost metadata lookup failed with status ${response.status}`);
  }

  const entries = await response.json();
  if (!Array.isArray(entries)) {
    throw new Error('Blockfrost returned an invalid metadata response');
  }

  const proofEntry = entries.find((entry) => String(entry.label) === String(PROOF_METADATA_LABEL));
  if (!proofEntry?.json_metadata || typeof proofEntry.json_metadata !== 'object') {
    throw new Error(`Transaction does not contain proof metadata label ${PROOF_METADATA_LABEL}`);
  }

  return proofEntry.json_metadata;
}

function hasBrandsIdentified(value) {
  if (!value || typeof value !== 'object') return false;
  return Object.values(value).some((list) => Array.isArray(list) && list.length > 0);
}

/**
 * Builds a stable, deterministic hash of the activity record. Any later
 * tampering with the database row will produce a different hash than the
 * one committed on-chain, which is what makes the proof verifiable.
 */
export function hashActivity(activity) {
  const reviewedBy = activity.reviewed_by ?? activity.reviewedBy;
  const canonicalActivity = {
    id: activity.id,
    category: activity.category,
    location: activity.location,
    quantity: activity.quantity,
    volunteers: activity.volunteers,
    contributorId: activity.contributor_id ?? activity.contributorId,
    lat: activity.lat,
    lon: activity.lon,
    imageCid: activity.image_cid ?? activity.imageCid,
    status: activity.status,
    reviewedAt: activity.reviewed_at ?? activity.reviewedAt,
    debris: {
      cigaretteButts: activity.debris_cigarette_butts,
      foodWrappers: activity.debris_food_wrappers,
      bottleCaps: activity.debris_bottle_caps,
      fishingLine: activity.debris_fishing_line,
      straws: activity.debris_straws,
      bottles: activity.debris_bottles
    }
  };

  // Omit this field for proofs created before reviewer identity existed, so
  // old records with a NULL reviewed_by value remain verifiable.
  if (reviewedBy !== null && reviewedBy !== undefined) {
    canonicalActivity.reviewedBy = reviewedBy;
  }

  // Fold in the newer optional fields (brand attribution, debris source,
  // survey size/method) - but only when there's real signal to protect.
  // Every activity created before these columns existed (and any created
  // since where the contributor just left them blank) has brands_identified
  // = '{}' and null survey/debris-source columns; adding empty keys for
  // those would change hashActivity()'s output for rows that never actually
  // changed, permanently breaking verification of every proof already
  // committed on-chain. Only rows with actual data get the richer hash.
  //
  // Deliberately NOT included at all: weather_conditions / days_since_rain /
  // wind_speed_kmh. Those are fetched asynchronously after creation (and can
  // be populated later still by scripts/backfillWeather.js), so they aren't
  // guaranteed to be settled by the time a proof is submitted - and a later
  // backfill would retroactively change the hash for a non-tampering reason.
  const brandsIdentified = activity.brands_identified ?? activity.brandsIdentified;
  if (hasBrandsIdentified(brandsIdentified)) {
    canonicalActivity.brandsIdentified = brandsIdentified;
  }

  const debrisSource = activity.debris_source ?? activity.debrisSource;
  if (debrisSource) {
    canonicalActivity.debrisSource = debrisSource;
  }

  const surveyLengthM = activity.survey_length_m ?? activity.surveyLengthM;
  const surveyAreaSqm = activity.survey_area_sqm ?? activity.surveyAreaSqm;
  const surveyMethod = activity.survey_method ?? activity.surveyMethod;
  const hasSurveyMethod = surveyMethod && surveyMethod !== 'Not measured';
  if (surveyLengthM != null || surveyAreaSqm != null || hasSurveyMethod) {
    canonicalActivity.survey = {
      ...(surveyLengthM != null ? { lengthM: surveyLengthM } : {}),
      ...(surveyAreaSqm != null ? { areaSqm: surveyAreaSqm } : {}),
      ...(hasSurveyMethod ? { method: surveyMethod } : {})
    };
  }

  const canonical = JSON.stringify(canonicalActivity);

  return crypto.createHash('sha256').update(canonical).digest('hex');
}

/**
 * Serializes queued proof submissions so we never race two transactions
 * against the same backend-wallet UTXOs at once.
 */
let proofQueue = Promise.resolve();

function queueProof(fn) {
  return new Promise((resolve, reject) => {
    proofQueue = proofQueue.then(async () => {
      try {
        resolve(await fn());
      } catch (err) {
        reject(err);
      }
    });
  });
}

/**
 * Submits the on-chain proof transaction for one activity and persists the
 * result. Safe to call multiple times - if a proof already exists it is not
 * resubmitted.
 */
export async function recordActivityOnChain(activityId) {
  return queueProof(() => _recordActivityOnChainUnsafe(activityId));
}

async function _recordActivityOnChainUnsafe(activityId) {
  assertProofConfigured();

  const result = await query('SELECT * FROM activities WHERE id = $1', [activityId]);
  const existingActivity = result.rows[0] ?? null;

  if (!existingActivity) {
    throw new Error(`Activity ${activityId} not found`);
  }

  // A submitted proof is never rebuilt. Re-check its confirmation instead.
  if (existingActivity.onchain_tx_hash) {
    if (existingActivity.onchain_status !== 'confirmed') {
      const confirmed = await confirmProofTransaction(activityId);
      return {
        alreadyRecorded: true,
        txHash: existingActivity.onchain_tx_hash,
        hash: existingActivity.onchain_hash,
        status: confirmed?.onchain_status || existingActivity.onchain_status
      };
    }
    return {
      alreadyRecorded: true,
      txHash: existingActivity.onchain_tx_hash,
      hash: existingActivity.onchain_hash,
      status: existingActivity.onchain_status
    };
  }

  // Claim this activity before constructing a transaction. This protects
  // against duplicate submissions across concurrent server instances. A
  // stale claim can be recovered by the monitor after ten minutes.
  const claim = await query(
    `UPDATE activities
     SET onchain_status = 'submitting', onchain_submission_started_at = NOW()
     WHERE id = $1
       AND onchain_tx_hash IS NULL
       AND (
         onchain_status IS NULL
         OR onchain_status <> 'submitting'
         OR onchain_submission_started_at < NOW() - INTERVAL '10 minutes'
       )
     RETURNING *`,
    [activityId]
  );
  const activity = claim.rows[0] ?? null;
  if (!activity) {
    return {
      alreadyRecorded: false,
      pendingSubmission: true,
      status: 'submitting'
    };
  }

  const hash = hashActivity(activity);

  const metadataPayload = {
    activity_id: meta(activity.id),
    category: meta(activity.category),
    location: meta(activity.location),
    quantity_kg: meta(activity.quantity),
    contributor_id: meta(activity.contributor_id),
    reviewer_id: meta(activity.reviewed_by),
    status: meta(activity.status),
    hash: meta(hash)
  };

  const lucid = await getLucid();
  const ownAddress = await lucid.wallet().address();

  // Self-payment of the minimum UTXO amount - the transaction exists purely
  // to carry the metadata on-chain, not to move funds anywhere.
  const tx = await lucid
    .newTx()
    .pay.ToAddress(ownAddress, { lovelace: 1_500_000n })
    .attachMetadata(PROOF_METADATA_LABEL, metadataPayload)
    .complete();

  const signedTx = await tx.sign.withWallet().complete();
  const txHash = await signedTx.submit();

  // Persist the transaction hash immediately after submission. Confirmation
  // happens separately, so a restart cannot submit the same proof again.
  await query(
    `UPDATE activities
     SET onchain_tx_hash = $1, onchain_hash = $2, onchain_recorded_at = NOW(), onchain_status = 'submitted'
     WHERE id = $3`,
    [txHash, hash, activityId]
  );
  await recordActivityEvent({
    activityId,
    eventType: 'proof_submitted',
    payload: { txHash, hash }
  });

  console.log(`[onchainProofService] proof submitted for activity ${activityId} → txHash: ${txHash}`);
  return { alreadyRecorded: false, txHash, hash };
}

/**
 * Polls Blockfrost for confirmation of a previously-submitted proof
 * transaction and flips onchain_status to 'confirmed'. Intended to be called
 * by a periodic job (see monitorPendingProofs) rather than inline in a
 * request handler, since confirmation can take ~20s or longer.
 */
export async function confirmProofTransaction(activityId) {
  const result = await query(
    'SELECT id, onchain_tx_hash, onchain_status FROM activities WHERE id = $1',
    [activityId]
  );
  const activity = result.rows[0] ?? null;

  if (!activity?.onchain_tx_hash || activity.onchain_status === 'confirmed') {
    return activity;
  }

  const lucid = await getLucid();

  try {
    await lucid.awaitTx(activity.onchain_tx_hash);
    await query(
      `UPDATE activities SET onchain_status = 'confirmed' WHERE id = $1`,
      [activityId]
    );
    await recordActivityEvent({
      activityId,
      eventType: 'proof_confirmed',
      payload: { txHash: activity.onchain_tx_hash }
    });
    console.log(`[onchainProofService] confirmed on-chain: activity ${activityId}`);
    return { ...activity, onchain_status: 'confirmed' };
  } catch (err) {
    console.warn(
      `[onchainProofService] tx ${activity.onchain_tx_hash} still not confirmed:`,
      err.message
    );
    return activity;
  }
}

/**
 * Background sweep - call this from a cron/interval. Finds activities whose
 * proof was submitted but never confirmed, and checks them again. Also
 * retries activities that were approved but never got a proof submitted at
 * all (e.g. the backend crashed mid-request).
 */
export async function monitorPendingProofs() {
  const pendingResult = await query(
    `SELECT id
     FROM activities
     WHERE onchain_tx_hash IS NOT NULL
       AND COALESCE(onchain_status, 'submitted') <> 'confirmed'`
  );
  for (const row of pendingResult.rows) {
    await confirmProofTransaction(row.id);
  }

  const missingResult = await query(
    `SELECT id
     FROM activities
     WHERE status = 'approved'
       AND onchain_tx_hash IS NULL
       AND (
         onchain_status IS NULL
         OR onchain_status <> 'submitting'
         OR onchain_submission_started_at < NOW() - INTERVAL '10 minutes'
       )`
  );
  for (const row of missingResult.rows) {
    try {
      await recordActivityOnChain(row.id);
    } catch (err) {
      console.error(
        `[onchainProofService] retry failed for activity ${row.id}:`,
        err.message
      );
    }
  }

  return {
    checkedConfirmations: pendingResult.rows.length,
    retriedMissing: missingResult.rows.length
  };
}

/**
 * Public verification: recomputes the hash from the CURRENT database row and
 * compares it to what was committed on-chain. If they differ, the record was
 * altered after being proven - this is the check a partner/NGO/auditor cares
 * about, not just "does a tx hash exist".
 */
export async function getActivityProof(activityId) {
  const result = await query('SELECT * FROM activities WHERE id = $1', [activityId]);
  const activity = result.rows[0] ?? null;

  if (!activity) {
    throw new Error(`Activity ${activityId} not found`);
  }

  if (!activity.onchain_tx_hash) {
    return { recorded: false };
  }

  const currentHash = hashActivity(activity);
  let chainVerification;

  try {
    const metadata = await fetchProofMetadataFromChain(activity.onchain_tx_hash);
    const metadataHash = typeof metadata.hash === 'string' ? metadata.hash : null;
    const metadataActivityId = metadata.activity_id == null ? null : String(metadata.activity_id);
    const databaseHashMatches = currentHash === activity.onchain_hash;
    const metadataMatchesStoredHash = metadataHash === activity.onchain_hash;
    const metadataMatchesCurrentHash = metadataHash === currentHash;
    const metadataMatchesActivity = metadataActivityId === String(activity.id);

    chainVerification = {
      available: true,
      verified: databaseHashMatches && metadataMatchesStoredHash && metadataMatchesCurrentHash && metadataMatchesActivity,
      metadataHash,
      metadataActivityId,
      databaseHashMatches,
      metadataMatchesStoredHash,
      metadataMatchesCurrentHash,
      metadataMatchesActivity
    };
  } catch (error) {
    console.warn(`[onchainProofService] could not verify metadata for tx ${activity.onchain_tx_hash}:`, error.message);
    chainVerification = {
      available: false,
      verified: false,
      reason: 'On-chain metadata is not currently available for verification'
    };
  }

  const explorerBase =
    blockchainConfig.network === 'Mainnet'
      ? 'https://cexplorer.io/tx/'
      : 'https://preprod.cexplorer.io/tx/';

  return {
    recorded: true,
    status: activity.onchain_status,
    txHash: activity.onchain_tx_hash,
    explorerUrl: explorerBase + activity.onchain_tx_hash,
    recordedAt: activity.onchain_recorded_at,
    // Backwards-compatible summary: true only if both the database and the
    // independently-read transaction metadata agree with the current record.
    hashMatches: chainVerification.verified,
    onchainHash: activity.onchain_hash,
    currentHash,
    chainVerification
  };
}

/**
 * Verification proofs (spec §21) — the same tamper-evident mechanism as
 * activity proofs above, applied to a verifier's attestation instead of
 * the original submission. This is what actually gives an action-event
 * (created via Plan Action, spec §27) a proof at all: it has no
 * legacy_activity_id, so recordActivityOnChain never runs for it — its
 * verification is the only point in its lifecycle a proof can hang off.
 * Proved regardless of outcome ('verified', 'disputed', or
 * 'unable_to_verify') — a verifier's dispute is as much an attestation
 * worth protecting from later tampering as an approval is.
 *
 * Shares the same wallet and the same `queueProof` serialization as
 * activity proofs (both submit transactions from one backend wallet
 * against the same UTXO set, so they must not race each other), but
 * keeps its own submit/confirm/read functions rather than parameterizing
 * the activity ones — the two entities live in different tables with
 * different column sets, and duplicating this much smaller function is
 * safer than reshaping the already-in-production activity path to share it.
 */

/**
 * Builds a stable, deterministic hash of a verification record. Unlike
 * hashActivity, there's no evolving optional-field history to account for
 * here — this table has always had exactly these columns — so the
 * canonical shape is just "all of them".
 */
export function hashVerification(verification) {
  const canonical = JSON.stringify({
    verificationId: verification.verification_id,
    eventId: verification.event_id,
    verifierId: verification.verifier_id,
    outcome: verification.outcome,
    notes: verification.notes,
    createdAt: verification.created_at
  });
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

export async function recordVerificationOnChain(verificationId) {
  return queueProof(() => _recordVerificationOnChainUnsafe(verificationId));
}

async function _recordVerificationOnChainUnsafe(verificationId) {
  assertProofConfigured();

  const result = await query('SELECT * FROM verifications WHERE verification_id = $1', [verificationId]);
  const existing = result.rows[0] ?? null;
  if (!existing) {
    throw new Error(`Verification ${verificationId} not found`);
  }

  if (existing.onchain_tx_hash) {
    if (existing.onchain_status !== 'confirmed') {
      const confirmed = await confirmVerificationProofTransaction(verificationId);
      return {
        alreadyRecorded: true,
        txHash: existing.onchain_tx_hash,
        hash: existing.onchain_hash,
        status: confirmed?.onchain_status || existing.onchain_status
      };
    }
    return {
      alreadyRecorded: true,
      txHash: existing.onchain_tx_hash,
      hash: existing.onchain_hash,
      status: existing.onchain_status
    };
  }

  const claim = await query(
    `UPDATE verifications
     SET onchain_status = 'submitting', onchain_submission_started_at = NOW()
     WHERE verification_id = $1
       AND onchain_tx_hash IS NULL
       AND (
         onchain_status IS NULL
         OR onchain_status <> 'submitting'
         OR onchain_submission_started_at < NOW() - INTERVAL '10 minutes'
       )
     RETURNING *`,
    [verificationId]
  );
  const verification = claim.rows[0] ?? null;
  if (!verification) {
    return { alreadyRecorded: false, pendingSubmission: true, status: 'submitting' };
  }

  const hash = hashVerification(verification);

  const metadataPayload = {
    verification_id: meta(verification.verification_id),
    event_id: meta(verification.event_id),
    verifier_id: meta(verification.verifier_id),
    outcome: meta(verification.outcome),
    hash: meta(hash)
  };

  const lucid = await getLucid();
  const ownAddress = await lucid.wallet().address();

  const tx = await lucid
    .newTx()
    .pay.ToAddress(ownAddress, { lovelace: 1_500_000n })
    .attachMetadata(PROOF_METADATA_LABEL, metadataPayload)
    .complete();

  const signedTx = await tx.sign.withWallet().complete();
  const txHash = await signedTx.submit();

  await query(
    `UPDATE verifications
     SET onchain_tx_hash = $1, onchain_hash = $2, onchain_recorded_at = NOW(), onchain_status = 'submitted'
     WHERE verification_id = $3`,
    [txHash, hash, verificationId]
  );

  console.log(`[onchainProofService] proof submitted for verification ${verificationId} → txHash: ${txHash}`);
  return { alreadyRecorded: false, txHash, hash };
}

export async function confirmVerificationProofTransaction(verificationId) {
  const result = await query(
    'SELECT verification_id, onchain_tx_hash, onchain_status FROM verifications WHERE verification_id = $1',
    [verificationId]
  );
  const verification = result.rows[0] ?? null;

  if (!verification?.onchain_tx_hash || verification.onchain_status === 'confirmed') {
    return verification;
  }

  const lucid = await getLucid();

  try {
    await lucid.awaitTx(verification.onchain_tx_hash);
    await query(
      `UPDATE verifications SET onchain_status = 'confirmed' WHERE verification_id = $1`,
      [verificationId]
    );
    console.log(`[onchainProofService] confirmed on-chain: verification ${verificationId}`);
    return { ...verification, onchain_status: 'confirmed' };
  } catch (err) {
    console.warn(
      `[onchainProofService] tx ${verification.onchain_tx_hash} still not confirmed:`,
      err.message
    );
    return verification;
  }
}

export async function getVerificationProof(verificationId) {
  const result = await query('SELECT * FROM verifications WHERE verification_id = $1', [verificationId]);
  const verification = result.rows[0] ?? null;

  if (!verification) {
    throw new Error(`Verification ${verificationId} not found`);
  }

  if (!verification.onchain_tx_hash) {
    return { recorded: false };
  }

  const currentHash = hashVerification(verification);
  let chainVerification;

  try {
    const metadata = await fetchProofMetadataFromChain(verification.onchain_tx_hash);
    const metadataHash = typeof metadata.hash === 'string' ? metadata.hash : null;
    const metadataVerificationId = metadata.verification_id == null ? null : String(metadata.verification_id);
    const databaseHashMatches = currentHash === verification.onchain_hash;
    const metadataMatchesStoredHash = metadataHash === verification.onchain_hash;
    const metadataMatchesCurrentHash = metadataHash === currentHash;
    const metadataMatchesVerification = metadataVerificationId === String(verification.verification_id);

    chainVerification = {
      available: true,
      verified: databaseHashMatches && metadataMatchesStoredHash && metadataMatchesCurrentHash && metadataMatchesVerification,
      metadataHash,
      metadataVerificationId,
      databaseHashMatches,
      metadataMatchesStoredHash,
      metadataMatchesCurrentHash,
      metadataMatchesVerification
    };
  } catch (error) {
    console.warn(`[onchainProofService] could not verify metadata for tx ${verification.onchain_tx_hash}:`, error.message);
    chainVerification = {
      available: false,
      verified: false,
      reason: 'On-chain metadata is not currently available for verification'
    };
  }

  const explorerBase =
    blockchainConfig.network === 'Mainnet'
      ? 'https://cexplorer.io/tx/'
      : 'https://preprod.cexplorer.io/tx/';

  return {
    recorded: true,
    status: verification.onchain_status,
    txHash: verification.onchain_tx_hash,
    explorerUrl: explorerBase + verification.onchain_tx_hash,
    recordedAt: verification.onchain_recorded_at,
    hashMatches: chainVerification.verified,
    onchainHash: verification.onchain_hash,
    currentHash,
    chainVerification
  };
}

/**
 * Background sweep for verification proofs — same shape as
 * monitorPendingProofs above, called from the same cron/interval (see its
 * caller) so both entity types get checked on one schedule.
 */
export async function monitorPendingVerificationProofs() {
  const pendingResult = await query(
    `SELECT verification_id
     FROM verifications
     WHERE onchain_tx_hash IS NOT NULL
       AND COALESCE(onchain_status, 'submitted') <> 'confirmed'`
  );
  for (const row of pendingResult.rows) {
    await confirmVerificationProofTransaction(row.verification_id);
  }

  const missingResult = await query(
    `SELECT verification_id
     FROM verifications
     WHERE onchain_tx_hash IS NULL
       AND (
         onchain_status IS NULL
         OR onchain_status <> 'submitting'
         OR onchain_submission_started_at < NOW() - INTERVAL '10 minutes'
       )`
  );
  for (const row of missingResult.rows) {
    try {
      await recordVerificationOnChain(row.verification_id);
    } catch (err) {
      console.error(
        '[onchainProofService] retry failed for verification', row.verification_id, ':', err.message
      );
    }
  }

  return {
    checkedConfirmations: pendingResult.rows.length,
    retriedMissing: missingResult.rows.length
  };
}

export default {
  hashActivity,
  fetchProofMetadataFromChain,
  recordActivityOnChain,
  confirmProofTransaction,
  monitorPendingProofs,
  getActivityProof,
  hashVerification,
  recordVerificationOnChain,
  confirmVerificationProofTransaction,
  getVerificationProof,
  monitorPendingVerificationProofs
};
