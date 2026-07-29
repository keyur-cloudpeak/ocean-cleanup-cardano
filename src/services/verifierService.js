export class VerifierService {
  async approve(activity) {
    return { approved: true, activityId: activity.id };
  }
}

export default new VerifierService();
