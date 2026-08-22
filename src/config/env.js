import './loadEnv.js';
export const env = {
  port: process.env.PORT || 3001,
  host: process.env.HOST || 'localhost',
  nodeEnv: process.env.NODE_ENV || 'development',
  jwtSecret: process.env.JWT_SECRET || 'fallback_secret_key_for_dev',
  apiBaseUrl: process.env.API_BASE_URL || `https://ocean-cleanup-cardano.vercel.app`,
  emailProvider: process.env.EMAIL_PROVIDER || 'console',
  emailFrom: process.env.EMAIL_FROM || process.env.GMAIL_USER || 'no-reply@localhost',
  gmailUser: process.env.GMAIL_USER || '',
  gmailAppPassword: process.env.GMAIL_APP_PASSWORD || ''
};
