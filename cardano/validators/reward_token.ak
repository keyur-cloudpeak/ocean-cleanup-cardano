use aiken/collection/list
use aiken/crypto.{VerificationKeyHash}
use cardano/assets.{PolicyId}
use cardano/transaction.{Transaction}

/// Reward token minting policy.
///
/// `minter` is baked into the compiled script at build time (see the
/// blueprint's `applyParamsToScript` step on the backend). It is the
/// verification key hash of the wallet the Ocean Cleanup backend controls.
///
/// Minting (or burning) tokens under this policy is only allowed inside a
/// transaction explicitly signed by that key. All of the "who is allowed to
/// mint, how much, to whom" logic stays in the backend/database (an activity
/// must be reviewed + approved before `/api/activities/:id/mint` ever builds
/// a transaction) — this validator's only job is to make sure nobody else
/// can forge reward tokens under this policy ID.
validator reward_token(minter: VerificationKeyHash) {
  mint(_redeemer: Data, _policy_id: PolicyId, self: Transaction) {
    list.has(self.extra_signatories, minter)
  }

  else(_) {
    fail
  }
}
