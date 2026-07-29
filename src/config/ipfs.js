import './loadEnv.js';

export const ipfsConfig = {
  pinataApiKey: process.env.PINATA_API_KEY || '',
  pinataSecretKey: process.env.PINATA_SECRET_KEY || ''
};
