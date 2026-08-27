import {
  listEvents, getEventDetail, listSubjects, planActionForEvent, completeAction, linkEvents, verifyEvent
} from '../services/environmentalEventService.js';
import { uploadMultipleFiles, uploadMultipleBase64 } from '../utils/mediaUpload.js';
import asyncHandler from '../middleware/asyncHandler.js';

async function list(req, res) {
  const events = await listEvents({
    eventState: req.query.eventState,
    verificationState: req.query.verificationState,
    subjectFamily: req.query.subjectFamily,
    contributorId: req.query.contributorId,
    organizationId: req.query.organizationId,
    limit: req.query.limit,
    offset: req.query.offset
  });

  res.json({ ok: true, events });
}

async function getSubjects(req, res) {
  const subjects = await listSubjects(req.query.family);
  res.json({ ok: true, subjects });
}

async function getById(req, res) {
  const event = await getEventDetail(req.params.id);
  if (!event) {
    return res.status(404).json({ ok: false, error: 'Event not found' });
  }

  res.json({ ok: true, event });
}

/**
 * POST /api/events/:id/actions
 * Plans an action responding to the observation event at :id (spec §27).
 */
async function planAction(req, res) {
  const { subjectCode, title, description } = req.body;
  if (!subjectCode) {
    return res.status(400).json({ ok: false, error: 'subjectCode is required' });
  }

  let actionEventId;
  try {
    actionEventId = await planActionForEvent(req.params.id, {
      actorId: req.user.id, subjectCode, title, description
    });
  } catch (err) {
    return res.status(400).json({ ok: false, error: err.message });
  }

  const event = await getEventDetail(actionEventId);
  res.status(201).json({ ok: true, event });
}

/**
 * POST /api/events/:id/complete
 * Marks the action event at :id complete, recording impact and closing
 * out every observation it responds to. Accepts completion photos (spec
 * §27: "They upload photos and weight") the same two ways activity intake
 * does — multer multipart files or a JSON array of base64 data URIs —
 * so the same "team removed the net, here's proof" evidence has somewhere
 * to go instead of only the kg number being recorded.
 */
async function complete(req, res) {
  const { kgRemoved, note, imageUrls } = req.body;

  let images = [];
  try {
    if (req.files && req.files.length > 0) {
      const uploaded = await uploadMultipleFiles(req.files);
      images = uploaded.cids.map((cid, i) => ({ cid, storageUrl: uploaded.ipfsUrls[i], gatewayUrl: uploaded.gatewayUrls[i] }));
    } else if (imageUrls) {
      const uris = typeof imageUrls === 'string' ? JSON.parse(imageUrls) : imageUrls;
      const uploaded = await uploadMultipleBase64(uris);
      images = uploaded.cids.map((cid, i) => ({ cid, storageUrl: uploaded.ipfsUrls[i], gatewayUrl: uploaded.gatewayUrls[i] }));
    }
  } catch (err) {
    return res.status(400).json({ ok: false, error: `Failed to upload completion evidence: ${err.message}` });
  }

  let closedEventIds;
  try {
    closedEventIds = await completeAction(req.params.id, { actorId: req.user.id, kgRemoved, note, images });
  } catch (err) {
    return res.status(400).json({ ok: false, error: err.message });
  }

  const event = await getEventDetail(req.params.id);
  res.json({ ok: true, event, closedEventIds });
}

/**
 * POST /api/events/:id/verify
 * Spec §20/§27: a verifier (never the contributor/org who submitted or
 * completed the work — see the route's role gate) reviews the evidence on
 * event :id and records an outcome. A 'verified' outcome on a completed
 * action is what actually closes out the observation(s) it responds to;
 * completion alone (POST .../complete) only gets the action itself to
 * 'addressed' and the observation to 'action_underway'.
 */
async function verify(req, res) {
  const { outcome, notes } = req.body;
  if (!outcome) {
    return res.status(400).json({ ok: false, error: 'outcome is required' });
  }

  let result;
  try {
    result = await verifyEvent(req.params.id, { verifierId: req.user.id, outcome, notes });
  } catch (err) {
    return res.status(400).json({ ok: false, error: err.message });
  }

  const event = await getEventDetail(req.params.id);
  res.json({ ok: true, event, closedEventIds: result.closedEventIds });
}

/**
 * POST /api/events/:id/relate
 * Creates a typed relationship from the event at :id to another event
 * (spec §9) — the general-purpose complement to the automatic
 * corroborates/responds_to/removed relationships created elsewhere.
 */
async function relate(req, res) {
  const { toEventId, relationshipType } = req.body;
  if (!toEventId || !relationshipType) {
    return res.status(400).json({ ok: false, error: 'toEventId and relationshipType are required' });
  }

  let relationshipId;
  try {
    relationshipId = await linkEvents(req.params.id, toEventId, relationshipType, req.user.id);
  } catch (err) {
    return res.status(400).json({ ok: false, error: err.message });
  }

  const event = await getEventDetail(req.params.id);
  res.status(201).json({ ok: true, relationshipId, event });
}

export default {
  list: asyncHandler(list),
  getSubjects: asyncHandler(getSubjects),
  getById: asyncHandler(getById),
  planAction: asyncHandler(planAction),
  complete: asyncHandler(complete),
  verify: asyncHandler(verify),
  relate: asyncHandler(relate)
};
