import './loadEnv.js';

const configuredPoints = Number(process.env.POINTS_PER_APPROVED_ACTIVITY || 10);

export const pointsConfig = {
  perApprovedActivity: Number.isInteger(configuredPoints) && configuredPoints > 0
    ? configuredPoints
    : 10
};

export default pointsConfig;
