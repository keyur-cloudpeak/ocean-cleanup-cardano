import ipfsService from '../services/ipfsService.js';
import {
  listActivities,
  createActivity,
  getActivityById,
  updateActivity,
  reviewActivity,
  mintReward,
  deleteActivity
} from '../services/activityService.js';
import { send as sendActivityNotification } from '../services/notificationService.js';
import { findUserById } from '../services/userService.js';
import contractService from '../contracts/contractService.js';

// Helper: convert a base64 data URI → { buffer, mimeType, filename }
function parseBase64Image(dataUri) {
  const match = dataUri.match(/^data:([^;]+);base64,(.+)$/);
  if (!match) return null;
  const mimeType = match[1];
  const buffer = Buffer.from(match[2], 'base64');
  const ext = mimeType.split('/')[1] || 'bin';
  const filename = `upload-${Date.now()}.${ext}`;
  return { buffer, mimeType, filename };
}

// Upload an array of multer file objects to IPFS and return { cids, ipfsUrls, gatewayUrls }
async function uploadMultipleFiles(files) {
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
async function uploadMultipleBase64(dataUris) {
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

async function list(req, res) {
  try {
    const { activities, filters } = await listActivities(req.query.status);

    res.json({
      ok: true,
      activities,
      filters
    });
  } catch (error) {
    res.status(500).json({ ok: false, error: 'Failed to read activities' });
  }
}

async function create(req, res) {
  try {
    const {
      category,
      location,
      quantity,
      evidenceHash,
      contributorId,
      organizationId,
      imageUrls,   // JSON-encoded array of base64 strings (fallback)
      imageUrl,    // legacy single base64 (fallback)
      lat,
      lon,
      gps,
      volunteers,
      notes
    } = req.body;

    if (!category || !location || !quantity) {
      return res.status(400).json({ ok: false, error: 'Missing required fields' });
    }

    let imageCids = [];
    let imageIpfsUrls = [];
    let imageGatewayUrls = [];

    // Priority 1: multer multipart files
    if (req.files && req.files.length > 0) {
      const uploaded = await uploadMultipleFiles(req.files);
      imageCids = uploaded.cids;
      imageIpfsUrls = uploaded.ipfsUrls;
      imageGatewayUrls = uploaded.gatewayUrls;
    } else if (imageUrls) {
      // Priority 2: JSON array of base64 data URIs
      const uris = typeof imageUrls === 'string' ? JSON.parse(imageUrls) : imageUrls;
      const uploaded = await uploadMultipleBase64(uris);
      imageCids = uploaded.cids;
      imageIpfsUrls = uploaded.ipfsUrls;
      imageGatewayUrls = uploaded.gatewayUrls;
    } else if (imageUrl && imageUrl.startsWith('data:')) {
      // Priority 3: legacy single base64
      const parsed = parseBase64Image(imageUrl);
      if (parsed) {
        const uploaded = await ipfsService.uploadFile(parsed.buffer, parsed.filename, parsed.mimeType);
        imageCids = [uploaded.cid];
        imageIpfsUrls = [uploaded.ipfsUrl];
        imageGatewayUrls = [uploaded.gatewayUrl];
      }
    }

    const activity = await createActivity({
      category,
      location,
      quantity,
      evidenceHash,
      contributorId,
      organizationId,
      imageCids,
      imageIpfsUrls,
      imageGatewayUrls,
      lat,
      lon,
      gps,
      volunteers,
      notes,
      timestamp: req.body.timestamp || new Date().toISOString()
    });

    try {
      await sendActivityNotification(activity);
    } catch (notificationError) {
      console.error('Failed to send admin notification for submitted activity:', notificationError);
    }

    res.status(201).json({ ok: true, activity });
  } catch (error) {
    console.error('Error creating activity:', error);
    res.status(500).json({ ok: false, error: error.message || 'Failed to create activity' });
  }
}

async function getById(req, res) {
  try {
    const activity = await getActivityById(req.params.id);
    if (!activity) {
      return res.status(404).json({ ok: false, error: 'Activity not found' });
    }

    res.json({ ok: true, activity });
  } catch (error) {
    res.status(500).json({ ok: false, error: 'Failed to retrieve activity' });
  }
}

async function update(req, res) {
  try {
    const existing = await getActivityById(req.params.id);
    if (!existing) {
      return res.status(404).json({ ok: false, error: 'Activity not found' });
    }

    if (req.user.role !== 'contributor' || req.user.id !== existing.contributorId) {
      return res.status(403).json({ ok: false, error: 'Forbidden' });
    }

    if (existing.status === 'approved') {
      return res.status(400).json({ ok: false, error: 'Approved activities cannot be edited' });
    }

    const {
      category,
      location,
      quantity,
      volunteers,
      evidenceHash,
      organizationId,
      imageUrls,  // JSON array of base64 data URIs
      imageUrl,   // legacy single base64
      lat,
      lon,
      gps,
      notes
    } = req.body;

    const updates = {
      category,
      location,
      quantity,
      volunteers,
      evidenceHash,
      organizationId,
      lat,
      lon,
      gps,
      notes
    };

    if (req.files && req.files.length > 0) {
      const uploaded = await uploadMultipleFiles(req.files);
      updates.imageCids = uploaded.cids;
      updates.imageIpfsUrls = uploaded.ipfsUrls;
      updates.imageGatewayUrls = uploaded.gatewayUrls;
    } else if (imageUrls) {
      const uris = typeof imageUrls === 'string' ? JSON.parse(imageUrls) : imageUrls;
      const uploaded = await uploadMultipleBase64(uris);
      updates.imageCids = uploaded.cids;
      updates.imageIpfsUrls = uploaded.ipfsUrls;
      updates.imageGatewayUrls = uploaded.gatewayUrls;
    } else if (imageUrl && imageUrl.startsWith('data:')) {
      const parsed = parseBase64Image(imageUrl);
      if (parsed) {
        const uploaded = await ipfsService.uploadFile(parsed.buffer, parsed.filename, parsed.mimeType);
        updates.imageCids = [uploaded.cid];
        updates.imageIpfsUrls = [uploaded.ipfsUrl];
        updates.imageGatewayUrls = [uploaded.gatewayUrl];
      }
    }

    const activity = await updateActivity(req.params.id, updates);
    if (!activity) {
      return res.status(400).json({ ok: false, error: 'Failed to update activity' });
    }

    res.json({ ok: true, activity });
  } catch (error) {
    console.error('Error updating activity:', error);
    res.status(500).json({ ok: false, error: error.message || 'Failed to update activity' });
  }
}

async function review(req, res) {
  try {
    const activity = await reviewActivity(req.params.id, req.body.status, req.body.reviewNote || '');
    if (!activity) {
      return res.status(404).json({ ok: false, error: 'Activity not found' });
    }

    // If approved, automatically mint the reward
    let mintResult = null;
    if (activity.status === 'approved') {
      try {
        if (!activity.contributorId) {
          return res.status(400).json({ ok: false, error: 'Activity has no contributor to reward' });
        }

        const contributor = await findUserById(activity.contributorId);
        if (!contributor?.walletAddress) {
          return res.status(400).json({
            ok: false,
            error: 'Contributor has not linked a Cardano wallet address yet (POST /api/auth/wallet)'
          });
        }

        const amount = req.body.amount || 10;
        const tokenType = req.body.tokenType || 'OCEAN';

        mintResult = await contractService.mintReward({
          recipientAddress: contributor.walletAddress,
          amount,
          assetName: tokenType,
          activity
        });

        const updatedActivity = await mintReward(req.params.id, amount, tokenType, mintResult.txHash);
        return res.json({ ok: true, activity: updatedActivity, mint: mintResult });
      } catch (mintError) {
        console.error('Auto-mint error during approval:', mintError);
        return res.status(500).json({ ok: false, error: mintError.message || 'Failed to mint reward automatically' });
      }
    }

    res.json({ ok: true, activity });
  } catch (error) {
    res.status(500).json({ ok: false, error: 'Failed to review activity' });
  }
}

async function mint(req, res) {
  try {
    const existing = await getActivityById(req.params.id);
    if (!existing) {
      return res.status(404).json({ ok: false, error: 'Activity not found' });
    }

    if (existing.status !== 'approved') {
      return res.status(400).json({ ok: false, error: 'Only approved activities can be minted' });
    }

    if (existing.reward?.txHash) {
      return res.status(400).json({ ok: false, error: 'A reward has already been minted for this activity' });
    }

    if (!existing.contributorId) {
      return res.status(400).json({ ok: false, error: 'Activity has no contributor to reward' });
    }

    const contributor = await findUserById(existing.contributorId);
    if (!contributor?.walletAddress) {
      return res.status(400).json({
        ok: false,
        error: 'Contributor has not linked a Cardano wallet address yet (POST /api/auth/wallet)'
      });
    }

    const amount = req.body.amount || 10;
    const tokenType = req.body.tokenType || 'OCEAN';

    const mintResult = await contractService.mintReward({
      recipientAddress: contributor.walletAddress,
      amount,
      assetName: tokenType,
      activity: existing
    });

    const activity = await mintReward(req.params.id, amount, tokenType, mintResult.txHash);
    if (!activity) {
      return res.status(404).json({ ok: false, error: 'Activity not found' });
    }

    res.json({ ok: true, activity, mint: mintResult });
  } catch (error) {
    console.error('Mint reward error:', error);
    res.status(500).json({ ok: false, error: error.message || 'Failed to mint reward' });
  }
}

async function remove(req, res) {
  try {
    const deleted = await deleteActivity(req.params.id);
    if (!deleted) {
      return res.status(404).json({ ok: false, error: 'Activity not found' });
    }

    res.json({ ok: true, message: 'Activity deleted successfully' });
  } catch (error) {
    console.error('Delete activity error:', error);
    res.status(500).json({ ok: false, error: 'Failed to delete activity' });
  }
}

export default { list, create, getById, update, review, mint, remove };
