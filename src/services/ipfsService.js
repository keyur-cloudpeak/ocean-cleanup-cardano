import { ipfsConfig } from '../config/ipfs.js';

export class IpfsService {
  // Upload JSON metadata to Pinata
  async upload(payload) {
    try {
      const response = await fetch('https://api.pinata.cloud/pinning/pinJSONToIPFS', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'pinata_api_key': ipfsConfig.pinataApiKey,
          'pinata_secret_api_key': ipfsConfig.pinataSecretKey
        },
        body: JSON.stringify({
          pinataContent: payload,
          pinataMetadata: {
            name: 'ocean-cleanup-data'
          }
        })
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Failed to upload to Pinata: ${response.status} - ${errorText}`);
      }

      const data = await response.json();
      return { cid: data.IpfsHash, payload };
    } catch (error) {
      console.error('Error uploading JSON to IPFS:', error);
      throw error;
    }
  }

  // Upload an image/file buffer to Pinata
  // Uses native FormData + Blob (Node.js 18+) — do NOT set Content-Type manually
  async uploadFile(fileBuffer, originalName, mimeType) {
    try {
      const blob = new Blob([fileBuffer], { type: mimeType });

      const formData = new FormData();
      formData.append('file', blob, originalName);
      formData.append('pinataMetadata', JSON.stringify({
        name: `ocean-cleanup-image-${Date.now()}-${originalName}`
      }));

      const response = await fetch('https://api.pinata.cloud/pinning/pinFileToIPFS', {
        method: 'POST',
        headers: {
          // ⚠️ Do NOT set Content-Type here — native fetch sets it automatically
          // with the correct multipart boundary
          'pinata_api_key': ipfsConfig.pinataApiKey,
          'pinata_secret_api_key': ipfsConfig.pinataSecretKey
        },
        body: formData
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Failed to upload file to Pinata: ${response.status} - ${errorText}`);
      }

      const data = await response.json();
      const cid = data.IpfsHash;
      return {
        cid,
        ipfsUrl: `ipfs://${cid}`,
        gatewayUrl: `https://gateway.pinata.cloud/ipfs/${cid}`
      };
    } catch (error) {
      console.error('Error uploading file to IPFS:', error);
      throw error;
    }
  }
}

export default new IpfsService();

