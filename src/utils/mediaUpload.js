import ipfsService from '../services/ipfsService.js';

// Convert a base64 data URI → { buffer, mimeType, filename }. Shared by
// every intake path that accepts images as base64 instead of multipart
// (JSON-only clients, the legacy single-image field, etc.).
export function parseBase64Image(dataUri) {
  const match = dataUri.match(/^data:([^;]+);base64,(.+)$/);
  if (!match) return null;
  const mimeType = match[1];
  const buffer = Buffer.from(match[2], 'base64');
  const ext = mimeType.split('/')[1] || 'bin';
  const filename = `upload-${Date.now()}.${ext}`;
  return { buffer, mimeType, filename };
}

// Upload an array of multer file objects to IPFS and return { cids, ipfsUrls, gatewayUrls }
export async function uploadMultipleFiles(files) {
  const results = await Promise.all(
    files.map((f) => ipfsService.uploadFile(f.buffer, f.originalname, f.mimetype))
  );
  return {
    cids: results.map((r) => r.cid),
    ipfsUrls: results.map((r) => r.ipfsUrl),
    gatewayUrls: results.map((r) => r.gatewayUrl)
  };
}

// Upload an array of base64 data URIs to IPFS and return { cids, ipfsUrls, gatewayUrls }
export async function uploadMultipleBase64(dataUris) {
  const parsed = dataUris.map(parseBase64Image).filter(Boolean);
  if (parsed.length === 0) return { cids: [], ipfsUrls: [], gatewayUrls: [] };
  const results = await Promise.all(
    parsed.map((p) => ipfsService.uploadFile(p.buffer, p.filename, p.mimeType))
  );
  return {
    cids: results.map((r) => r.cid),
    ipfsUrls: results.map((r) => r.ipfsUrl),
    gatewayUrls: results.map((r) => r.gatewayUrl)
  };
}
