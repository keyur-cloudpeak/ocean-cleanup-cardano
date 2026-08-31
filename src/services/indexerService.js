import { monitorPendingProofs, monitorPendingVerificationProofs } from './onchainProofService.js';

export class IndexerService {
  async sync() {
    const [activitySummary, verificationSummary] = await Promise.all([
      monitorPendingProofs(),
      monitorPendingVerificationProofs()
    ]);
    return {
      status: 'ok',
      ...activitySummary,
      verifications: verificationSummary
    };
  }
}

export default new IndexerService();
