import {
  listOrganizations,
  getOrganizationById,
  createOrganization,
  updateOrganization,
  deleteOrganization,
  setOrganizationActiveStatus,
} from '../services/organizationService.js';
import asyncHandler from '../middleware/asyncHandler.js';

// ─── GET /api/admin/organizations ─────────────────────────────────────────────
async function listImpl(req, res) {
  // ?active=true|false   (optional filter)
  let isActive;
  if (req.query.active === 'true')  isActive = true;
  if (req.query.active === 'false') isActive = false;

  const organizations = await listOrganizations(isActive);
  res.json({ ok: true, organizations });
}

// ─── GET /api/admin/organizations/:id ─────────────────────────────────────────
async function getByIdImpl(req, res) {
  const org = await getOrganizationById(req.params.id);
  if (!org) return res.status(404).json({ ok: false, error: 'Organization not found' });
  res.json({ ok: true, organization: org });
}

// ─── POST /api/admin/organizations ────────────────────────────────────────────
async function createImpl(req, res) {
  const { name, region, country, parentOrgId, contactEmail, isActive } = req.body;

  if (!name || !name.trim()) {
    return res.status(400).json({ ok: false, error: 'name is required' });
  }

  const org = await createOrganization({ name, region, country, parentOrgId, contactEmail, isActive });
  res.status(201).json({ ok: true, organization: org });
}

// ─── PUT /api/admin/organizations/:id ─────────────────────────────────────────
async function updateImpl(req, res) {
  const org = await updateOrganization(req.params.id, req.body);
  if (!org) return res.status(404).json({ ok: false, error: 'Organization not found' });
  res.json({ ok: true, organization: org });
}

// ─── DELETE /api/admin/organizations/:id ──────────────────────────────────────
async function removeImpl(req, res) {
  const deleted = await deleteOrganization(req.params.id);
  if (!deleted) return res.status(404).json({ ok: false, error: 'Organization not found' });
  res.json({ ok: true, message: 'Organization deleted successfully' });
}

// ─── PATCH /api/admin/organizations/:id/status ────────────────────────────────
async function setStatusImpl(req, res) {
  const { isActive } = req.body;
  if (typeof isActive !== 'boolean') {
    return res.status(400).json({ ok: false, error: 'isActive (boolean) is required' });
  }

  const org = await setOrganizationActiveStatus(req.params.id, isActive);
  if (!org) return res.status(404).json({ ok: false, error: 'Organization not found' });
  res.json({ ok: true, organization: org });
}

export const list = asyncHandler(listImpl);
export const getById = asyncHandler(getByIdImpl);
export const create = asyncHandler(createImpl);
export const update = asyncHandler(updateImpl);
export const remove = asyncHandler(removeImpl);
export const setStatus = asyncHandler(setStatusImpl);

export default { list, getById, create, update, remove, setStatus };
