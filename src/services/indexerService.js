export class IndexerService {
  sync() {
    return { status: 'ready' };
  }
}

export default new IndexerService();
