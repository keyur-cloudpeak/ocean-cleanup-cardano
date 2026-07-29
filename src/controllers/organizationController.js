import {
  listOrganizations,
  getOrganizationById,
  createOrganization,
  updateOrganization,
  deleteOrganization,
  setOrganizationActiveStatus,
} from '../services/organizationService.js';

// ─── GET /api/admin/organizations ─────────────────────────────────────────────
export async function list(req, res) {
  try {
    // ?active=true|false   (optional filter)
    let isActive;
    if (req.query.active === 'true')  isActive = true;
    if (req.query.active === 'false') isActive = false;

    const organizations = await listOrganizations(isActive);
    res.json({ ok: true, organizations });
  } catch (err) {
    console.error('list organizations error:', err);
    res.status(500).json({ ok: false, error: 'Failed to fetch organizations' });
  }
}

// ─── GET /api/admin/organizations/:id ─────────────────────────────────────────
export async function getById(req, res) {
  try {
    const org = await getOrganizationById(req.params.id);
    if (!org) return res.status(404).json({ ok: false, error: 'Organization not found' });
    res.json({ ok: true, organization: org });
  } catch (err) {
    console.error('getById organization error:', err);
    res.status(500).json({ ok: false, error: 'Failed to retrieve organization' });
  }
}

// ─── POST /api/admin/organizations ────────────────────────────────────────────
export async function create(req, res) {
  try {
    const { name, region, country, parentOrgId, contactEmail, isActive } = req.body;

    if (!name || !name.trim()) {
      return res.status(400).json({ ok: false, error: 'name is required' });
    }

    const org = await createOrganization({ name, region, country, parentOrgId, contactEmail, isActive });
    res.status(201).json({ ok: true, organization: org });
  } catch (err) {
    console.error('create organization error:', err);
    res.status(500).json({ ok: false, error: err.message || 'Failed to create organization' });
  }
}

// ─── PUT /api/admin/organizations/:id ─────────────────────────────────────────
export async function update(req, res) {
  try {
    const org = await updateOrganization(req.params.id, req.body);
    if (!org) return res.status(404).json({ ok: false, error: 'Organization not found' });
    res.json({ ok: true, organization: org });
  } catch (err) {
    console.error('update organization error:', err);
    res.status(500).json({ ok: false, error: 'Failed to update organization' });
  }
}

// ─── DELETE /api/admin/organizations/:id ──────────────────────────────────────
export async function remove(req, res) {
  try {
    const deleted = await deleteOrganization(req.params.id);
    if (!deleted) return res.status(404).json({ ok: false, error: 'Organization not found' });
    res.json({ ok: true, message: 'Organization deleted successfully' });
  } catch (err) {
    console.error('delete organization error:', err);
    res.status(500).json({ ok: false, error: 'Failed to delete organization' });
  }
}

// ─── PATCH /api/admin/organizations/:id/status ────────────────────────────────
export async function setStatus(req, res) {
  try {
    const { isActive } = req.body;
    if (typeof isActive !== 'boolean') {
      return res.status(400).json({ ok: false, error: 'isActive (boolean) is required' });
    }

    const org = await setOrganizationActiveStatus(req.params.id, isActive);
    if (!org) return res.status(404).json({ ok: false, error: 'Organization not found' });
    res.json({ ok: true, organization: org });
  } catch (err) {
    console.error('setStatus organization error:', err);
    res.status(500).json({ ok: false, error: 'Failed to update organization status' });
  }
}

export default { list, getById, create, update, remove, setStatus };
