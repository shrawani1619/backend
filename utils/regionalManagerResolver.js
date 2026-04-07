import User from '../models/user.model.js';
import Franchise from '../models/franchise.model.js';
import RelationshipManager from '../models/relationship.model.js';

/** Associated doc id from lead (ObjectId or populated subdoc). */
function associatedObjectId(lead) {
  const a = lead.associated;
  if (!a) return null;
  return a._id != null ? a._id : a;
}

const uniqIds = (ids) => [...new Set(ids.filter(Boolean).map((id) => id.toString()))];

/** regionalManager User → else owner User → else ownerName (same as Owner column on Franchise / RM screens). */
function recordFranchiseRow(f, map) {
  if (!f?._id) return;
  const id = f._id.toString();
  const uid = f.regionalManager || f.owner;
  if (uid) map[id] = { userId: uid };
  else if (f.ownerName && String(f.ownerName).trim()) map[id] = { nameOnly: String(f.ownerName).trim() };
}

function recordRmRow(r, map) {
  if (!r?._id) return;
  const id = r._id.toString();
  const uid = r.regionalManager || r.owner;
  if (uid) map[id] = { userId: uid };
  else if (r.ownerName && String(r.ownerName).trim()) map[id] = { nameOnly: String(r.ownerName).trim() };
}

/** ownerName on populated associated (no nested User populate needed). */
function regionalManagerFromAssociatedDocFields(lead) {
  const a = lead.associated;
  if (!a || typeof a !== 'object') return null;
  if (a.ownerName && String(a.ownerName).trim()) {
    return { name: String(a.ownerName).trim(), email: undefined };
  }
  return null;
}

/**
 * Set `regionalManager: { name, email } | null` from the lead's **associated** Franchise or RelationshipManager only.
 * Loads both collections by `associated` _id (ignores wrong/missing associatedModel).
 */
export async function attachRegionalManagersToLeads(leads) {
  if (!leads?.length) return leads;

  const assocIds = uniqIds(leads.map((l) => associatedObjectId(l)).filter(Boolean));

  const assocIdToSource = {};

  if (assocIds.length) {
    const selectProfile = 'regionalManager owner ownerName';
    const [frRows, rmRows] = await Promise.all([
      Franchise.find({ _id: { $in: assocIds } }).select(selectProfile).lean(),
      RelationshipManager.find({ _id: { $in: assocIds } }).select(selectProfile).lean(),
    ]);
    for (const f of frRows) recordFranchiseRow(f, assocIdToSource);
    for (const r of rmRows) {
      const id = r._id.toString();
      if (!assocIdToSource[id]) recordRmRow(r, assocIdToSource);
    }
  }

  const userIds = new Set();
  for (const id of assocIds) {
    const src = assocIdToSource[id];
    if (src?.userId) userIds.add(src.userId.toString());
  }

  const users = userIds.size
    ? await User.find({ _id: { $in: [...userIds] } }).select('name email').lean()
    : [];
  const userById = Object.fromEntries(
    users.map((u) => [u._id.toString(), { name: u.name, email: u.email }])
  );

  for (const lead of leads) {
    let value = null;
    const aid = associatedObjectId(lead);
    if (aid) {
      const src = assocIdToSource[aid.toString()];
      if (src?.userId) value = userById[src.userId.toString()] || null;
      else if (src?.nameOnly) value = { name: src.nameOnly, email: undefined };
    }
    if (value == null) {
      const fromPop = regionalManagerFromAssociatedDocFields(lead);
      if (fromPop) value = fromPop;
    }

    if (typeof lead.set === 'function') {
      lead.set('regionalManager', value, { strict: false });
    } else {
      lead.regionalManager = value;
    }
  }

  return leads;
}
