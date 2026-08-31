import ipfsService from '../services/ipfsService.js';
import {
  listActivities,
  createActivity,
  getActivityById,
  updateActivity,
  reviewActivity,
  deleteActivity
} from '../services/activityService.js';
import { send as sendActivityNotification } from '../services/notificationService.js';
import { recordActivityOnChain, getActivityProof } from '../services/onchainProofService.js';
import { recordActivityEvent } from '../services/activityEventService.js';
import { createEventForActivity, recordReviewOnEvent } from '../services/environmentalEventService.js';
import { runIntakePipeline } from '../services/verifierService.js';
import { awardApprovalPoints } from '../services/rewardLedgerService.js';
import { fetchWeatherContext } from '../services/weatherService.js';
import { logExternalEnrichment } from '../services/externalEnrichmentService.js';
import { parseBase64Image, uploadMultipleFiles, uploadMultipleBase64 } from '../utils/mediaUpload.js';

// Evidence types the intake UI can tag a submission's attached media as —
// anything else (including the default, absent field) falls back to 'photo'.
const SUPPORTED_MEDIA_TYPES = new Set(['video', 'document', 'dataset', 'audio']);

// Mirrors the `provenance_source` Postgres enum (db/schema.sql) — validated
// here since attribute_provenance is a JSONB map, not a typed column, so
// nothing else stops a bad client value from being stored.
const PROVENANCE_SOURCES = new Set([
  'user_provided', 'system_captured', 'ai_inferred', 'external_enrichment', 'verifier_confirmed'
]);
import asyncHandler from '../middleware/asyncHandler.js';

// Fire-and-forget: looks up historical weather for the activity's site/date
// and patches it onto the row once it resolves. Never awaited by the
// request handler — a slow or failing weather API must never delay or
// break activity creation (see weatherService.js for its own internal
// timeout/error handling, which always resolves rather than rejecting).
function backfillWeatherInBackground(activity) {
  if (activity.lat == null || activity.lon == null) return;
  fetchWeatherContext(activity.lat, activity.lon, activity.timestamp)
    .then((weather) => {
      // EXTERNAL_ENRICHMENT audit trail (spec §26) — logged against
      // activity_id, not event_id: this runs before createEventForActivity
      // does, so there's no event row yet to reference.
      logExternalEnrichment({
        activityId: activity.id, sourceSystem: 'open-meteo',
        input: { lat: activity.lat, lon: activity.lon, date: activity.timestamp },
        result: weather
      });
      return updateActivity(activity.id, {
        weatherConditions: weather.weatherConditions,
        daysSinceRain: weather.daysSinceRain,
        windSpeedKmh: weather.windSpeedKmh
      });
    })
    .catch((err) =>
      console.error('[weatherService] background update failed for activity', activity.id, ':', err.message)
    );
}

async function list(req, res) {
  const { activities, filters } = await listActivities(req.query.status);

  res.json({
    ok: true,
    activities,
    filters
  });
}

async function create(req, res) {
  const {
      category,
      location,
      quantity,
      evidenceHash,
      organizationId,
      imageUrls,   // JSON-encoded array of base64 strings (fallback)
      imageUrl,    // legacy single base64 (fallback)
      lat,
      lon,
      gps,
      volunteers,
      notes,
      shorelineType, tideState, cleanedBefore,
      debrisCigaretteButts, debrisFoodWrappers, debrisBottleCaps, debrisFishingLine, debrisStraws, debrisBottles,
      microplastics, bulkItems, speciesSighted, condition, habitatStress,
      hazardsMedical, hazardsChemical, hazardsUnstable,
      instrument, timeSpent, secondVerifier, disposalMethod, followUp,
      brands_identified,
      surveyLengthM, surveyAreaSqm, surveyMethod, debrisSource,
      // AI-assisted quick-report intake (spec §16-17): a JSON-encoded array
      // of {family, code, confidence} from POST /api/ai/infer, the raw text
      // the contributor typed (if the "Tell Blue Mind" tile was used), how
      // the intake happened, and where the photo actually came from.
      aiSubjects: aiSubjectsRaw,
      rawText,
      intakeMethod,
      captureSource,
      // Set when the contributor edited an AI-estimated quantity by hand
      // before submitting (spec §17) — lets the resulting event_subjects
      // row record `quantity_kg` as user_provided instead of inheriting
      // the ai_inferred subject source it would otherwise default to.
      quantityProvenance,
      // Location architecture (spec §18) — only the client's Geolocation
      // API knows either of these; the server can't reconstruct them.
      locationAccuracy,
      locationCaptureMethod,
      // 'video' | 'document' | 'dataset' | 'audio' when the attachment
      // isn't a still photo — tags the resulting evidence row correctly
      // instead of defaulting to 'photo'. These always arrive via
      // req.files (multipart), never base64-in-JSON, since a video clip
      // or a real document routinely exceeds the JSON body size limit.
      mediaType
    } = req.body;

    // `!quantity` would wrongly reject 0 — a legitimate value for, e.g.,
    // a water-quality measurement with no debris weight to report, not a
    // missing one.
    if (!category || !location || quantity === undefined || quantity === null || quantity === '') {
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
      contributorId: req.user.id,
      organizationId,
      imageCids,
      imageIpfsUrls,
      imageGatewayUrls,
      lat,
      lon,
      gps,
      volunteers,
      notes,
      shorelineType, tideState, cleanedBefore,
      debrisCigaretteButts, debrisFoodWrappers, debrisBottleCaps, debrisFishingLine, debrisStraws, debrisBottles,
      microplastics, bulkItems, speciesSighted, condition, habitatStress,
      hazardsMedical, hazardsChemical, hazardsUnstable,
      instrument, timeSpent, secondVerifier, disposalMethod, followUp,
      brandsIdentified: brands_identified,
      surveyLengthM, surveyAreaSqm, surveyMethod, debrisSource,
      timestamp: req.body.timestamp || new Date().toISOString()
    });

    backfillWeatherInBackground(activity);

    await recordActivityEvent({
      activityId: activity.id,
      eventType: 'submitted',
      actorId: req.user.id,
      payload: { contributorId: activity.contributorId, organizationId: activity.organizationId }
    });

    let aiSubjects;
    try {
      aiSubjects = aiSubjectsRaw ? (typeof aiSubjectsRaw === 'string' ? JSON.parse(aiSubjectsRaw) : aiSubjectsRaw) : undefined;
    } catch {
      aiSubjects = undefined;
    }

    let createdEventId = null;
    try {
      createdEventId = await createEventForActivity(activity, {
        aiSubjects, rawText, intakeMethod, captureSource,
        evidenceType: SUPPORTED_MEDIA_TYPES.has(mediaType) ? mediaType : 'photo',
        quantityProvenance: PROVENANCE_SOURCES.has(quantityProvenance) ? quantityProvenance : undefined,
        locationAccuracy, locationCaptureMethod
      });
    } catch (eventError) {
      console.error('[environmentalEventService] failed to create event for activity', activity.id, ':', eventError.message);
    }

    if (createdEventId) {
      try {
        const pipelineResult = await runIntakePipeline(createdEventId);
        if (pipelineResult.corroboration.matchCount > 0) {
          console.log(
            `[verifierService] activity ${activity.id} corroborated by ${pipelineResult.corroboration.matchCount} nearby event(s)`
          );
        }
      } catch (pipelineError) {
        console.error('[verifierService] intake pipeline failed for activity', activity.id, ':', pipelineError.message);
      }
    }

    try {
      await sendActivityNotification(activity);
    } catch (notificationError) {
      console.error('Failed to send admin notification for submitted activity:', notificationError);
    }

    res.status(201).json({ ok: true, activity });
}

async function getById(req, res) {
  const activity = await getActivityById(req.params.id);
  if (!activity) {
    return res.status(404).json({ ok: false, error: 'Activity not found' });
  }

  res.json({ ok: true, activity });
}

async function update(req, res) {
  const existing = await getActivityById(req.params.id);
    if (!existing) {
      return res.status(404).json({ ok: false, error: 'Activity not found' });
    }

    const isOwner = req.user.id === existing.contributorId;
    const isAllowedRole = req.user.role === 'contributor' || req.user.role === 'citizen';
    if (!isOwner || !isAllowedRole) {
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
      notes,
      shorelineType, tideState, cleanedBefore,
      debrisCigaretteButts, debrisFoodWrappers, debrisBottleCaps, debrisFishingLine, debrisStraws, debrisBottles,
      microplastics, bulkItems, speciesSighted, condition, habitatStress,
      hazardsMedical, hazardsChemical, hazardsUnstable,
      instrument, timeSpent, secondVerifier, disposalMethod, followUp,
      brands_identified,
      surveyLengthM, surveyAreaSqm, surveyMethod, debrisSource
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
      notes,
      shorelineType, tideState, cleanedBefore,
      debrisCigaretteButts, debrisFoodWrappers, debrisBottleCaps, debrisFishingLine, debrisStraws, debrisBottles,
      microplastics, bulkItems, speciesSighted, condition, habitatStress,
      hazardsMedical, hazardsChemical, hazardsUnstable,
      instrument, timeSpent, secondVerifier, disposalMethod, followUp,
      brandsIdentified: brands_identified,
      surveyLengthM, surveyAreaSqm, surveyMethod, debrisSource
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
}

async function review(req, res) {
  const existing = await getActivityById(req.params.id);
    if (!existing) {
      return res.status(404).json({ ok: false, error: 'Activity not found' });
    }
    if (existing.status === 'approved') {
      return res.status(409).json({ ok: false, error: 'Approved activities cannot be reviewed again' });
    }

    const activity = await reviewActivity(
      req.params.id,
      req.body.status,
      req.body.reviewNote || '',
      req.user.id
    );
    if (!activity) {
      return res.status(404).json({ ok: false, error: 'Activity not found' });
    }

    await recordActivityEvent({
      activityId: activity.id,
      eventType: `reviewed_${activity.status}`,
      actorId: req.user.id,
      payload: { reviewNote: activity.reviewNote }
    });

    try {
      await recordReviewOnEvent(activity, req.user.id);
    } catch (eventError) {
      console.error('[environmentalEventService] failed to record review for activity', activity.id, ':', eventError.message);
    }

    // A proof is recorded by the backend wallet only; the contributor never
    // needs to supply or own a Cardano wallet.
    if (activity.status === 'approved') {
      if (activity.contributorId) {
        await awardApprovalPoints({
          activityId: activity.id,
          userId: activity.contributorId,
          reviewerId: req.user.id
        });
      }

      recordActivityOnChain(req.params.id).catch((proofErr) =>
        console.error('[onchainProof] background submission failed for activity', req.params.id, ':', proofErr.message)
      );
    }

    res.json({ ok: true, activity });
}

async function remove(req, res) {
  const deleted = await deleteActivity(req.params.id);
  if (!deleted) {
    return res.status(404).json({ ok: false, error: 'Activity not found' });
  }

  res.json({ ok: true, message: 'Activity deleted successfully' });
}

// Not routed through asyncHandler's throw path: the catch block does
// meaningful business-logic dispatch (distinguishing a "not found" error
// into a 404) alongside the generic 500 fallback, so it stays as-is.
async function proof(req, res) {
  try {
    const proofData = await getActivityProof(req.params.id);
    res.json({ ok: true, proof: proofData });
  } catch (error) {
    if (error.message?.includes('not found')) {
      return res.status(404).json({ ok: false, error: error.message });
    }
    console.error('Get proof error:', error);
    res.status(500).json({ ok: false, error: 'Failed to retrieve on-chain proof' });
  }
}

export default {
  list: asyncHandler(list),
  create: asyncHandler(create),
  getById: asyncHandler(getById),
  update: asyncHandler(update),
  review: asyncHandler(review),
  remove: asyncHandler(remove),
  proof: asyncHandler(proof)
};
