import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const envPath = path.resolve(__dirname, '../../.env');

function parseEnvLine(line) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) {
    return null;
  }

  const separatorIndex = trimmed.indexOf('=');
  if (separatorIndex === -1) {
    return null;
  }

  const key = trimmed.slice(0, separatorIndex).trim();
  const rawValue = trimmed.slice(separatorIndex + 1).trim();
  const value = rawValue.replace(/^['"]|['"]$/g, '');

  if (!key) {
    return null;
  }

  return [key, value];
}

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return;
  }

  const contents = fs.readFileSync(filePath, 'utf-8');
  for (const line of contents.split(/\r?\n/)) {
    const entry = parseEnvLine(line);
    if (!entry) continue;

    const [key, value] = entry;
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

loadEnvFile(envPath);

export {};
