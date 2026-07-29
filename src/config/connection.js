import './loadEnv.js';
import { Pool } from 'pg';

let pool = null;

function getConnectionString() {
  return process.env.DATABASE_URL || null;
}

function shouldUseSsl(connectionString) {
  try {
    const url = new URL(connectionString);
    const host = url.hostname.toLowerCase();

    if (url.searchParams.get('sslmode') === 'disable') {
      return false;
    }

    if (url.searchParams.get('sslmode') === 'require') {
      return { rejectUnauthorized: false };
    }

    if (host === 'localhost' || host === '127.0.0.1' || host === '::1') {
      return false;
    }

    return { rejectUnauthorized: false };
  } catch {
    return false;
  }
}

function getPool() {
  const connectionString = getConnectionString();

  if (!connectionString) {
    throw new Error('DATABASE_URL is not set');
  }

  if (!pool) {
    pool = new Pool({
      connectionString,
      ssl: shouldUseSsl(connectionString)
    });
  }

  return pool;
}

export async function query(text, params = []) {
  return getPool().query(text, params);
}

export async function testConnection() {
  const client = await getPool().connect();
  try {
    const result = await client.query('SELECT NOW() AS now');
    return result.rows[0];
  } finally {
    client.release();
  }
}

export async function closeConnection() {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

export default {
  query,
  testConnection,
  closeConnection
};
