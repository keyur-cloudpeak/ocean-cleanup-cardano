import './loadEnv.js';
export const env = {
  port: process.env.PORT || 3001,
  host: process.env.HOST || 'localhost',
  nodeEnv: process.env.NODE_ENV || 'development',
  jwtSecret: process.env.JWT_SECRET || 'fallback_secret_key_for_dev'
};
