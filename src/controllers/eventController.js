import {
  listEvents, getEventDetail, listSubjects, planActionForEvent, completeAction, linkEvents
} from '../services/environmentalEventService.js';
import asyncHandler from '../middleware/asyncHandler.js';

async function list(req, res) {
  const events = await listEvents({
    eventState: req.query.eventState,
    verificationState: req.query.verificationState,
    subjectFamily: req.query.subjectFamily,
    contributorId: req.query.contributorId,
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
 * out every observation it responds to.
 */
async function complete(req, res) {
  const { kgRemoved, note } = req.body;

  let closedEventIds;
  try {
    closedEventIds = await completeAction(req.params.id, { actorId: req.user.id, kgRemoved, note });
  } catch (err) {
    return res.status(400).json({ ok: false, error: err.message });
  }

  const event = await getEventDetail(req.params.id);
  res.json({ ok: true, event, closedEventIds });
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
  relate: asyncHandler(relate)
};
