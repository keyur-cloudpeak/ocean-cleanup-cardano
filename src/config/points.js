import './loadEnv.js';

function envInt(name, fallback) {
  const value = Number(process.env[name] || fallback);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

// Trust-weighted, not volume-weighted (spec §14): a contribution earns most
// of its points from being corroborated/verified by others, not from how
// much quantity it reports. perApprovedActivity is a small base amount for
// showing up with a usable submission at all.
export const pointsConfig = {
  perApprovedActivity: envInt('POINTS_PER_APPROVED_ACTIVITY', 10),
  perCorroboration: envInt('POINTS_PER_CORROBORATION', 5),
  perVerification: envInt('POINTS_PER_VERIFICATION', 15)
};

export default pointsConfig;
