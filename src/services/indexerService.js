import { monitorPendingProofs } from './onchainProofService.js';

export class IndexerService {
  async sync() {
    const summary = await monitorPendingProofs();
    return { status: 'ok', ...summary };
  }
}

export default new IndexerService();
