import mongoose from 'mongoose';
import Accountant from '../models/accountant.model.js';
import User from '../models/user.model.js';
import Franchise from '../models/franchise.model.js';
import RelationshipManager from '../models/relationship.model.js';

/**
 * Regional Manager User IDs assigned to this accountant (Accountant.assignedRegionalManagers),
 * validated so only existing users with role `regional_manager` are used — nothing else is in scope.
 * @param {Object} req - Express request with req.user
 * @returns {Promise<string[] | null>} RM user id strings; `null` if caller is not accounts_manager
 */
export async function getAccountantAssignedRegionalManagerIds(req) {
  if (!req.user || req.user.role !== 'accounts_manager') return null;

  try {
    const accountant = await Accountant.findOne({ user: req.user._id }).select('assignedRegionalManagers');
    if (!accountant?.assignedRegionalManagers?.length) {
      return [];
    }

    const assigned = accountant.assignedRegionalManagers;
    const valid = await User.find({
      _id: { $in: assigned },
      role: 'regional_manager',
    })
      .select('_id')
      .lean();

    return valid.map((u) => u._id.toString());
  } catch (error) {
    console.error('Error getting assigned RMs for accountant:', error);
    return [];
  }
}

/**
 * Mongo match for invoices visible to this accounts_manager (same rules as GET /invoices).
 * @returns {Promise<{ empty: boolean, match: object }>}
 */
export async function buildAccountsManagerInvoiceMatch(req) {
  const assignedRMIds = await getAccountantAssignedRegionalManagerIds(req);
  if (!assignedRMIds?.length) {
    return { empty: true, match: { _id: { $in: [] } } };
  }

  const rmObjectIds = assignedRMIds
    .filter((id) => mongoose.Types.ObjectId.isValid(id))
    .map((id) => new mongoose.Types.ObjectId(id));

  const franchiseDocIds = await Franchise.find({
    regionalManager: { $in: rmObjectIds },
  })
    .distinct('_id');

  const { agentIds: accessibleAgentIdStrings } = await getAccountantAccessibleUserIds(req);
  const scopedAgentIds = (accessibleAgentIdStrings || [])
    .filter((id) => id && mongoose.Types.ObjectId.isValid(id))
    .map((id) => new mongoose.Types.ObjectId(id));

  const orConditions = [];
  if (franchiseDocIds?.length) {
    orConditions.push({ franchise: { $in: franchiseDocIds } });
  }
  if (scopedAgentIds.length) {
    orConditions.push({ agent: { $in: scopedAgentIds } });
    orConditions.push({ subAgent: { $in: scopedAgentIds } });
  }

  if (!orConditions.length) {
    return { empty: true, match: { _id: { $in: [] } } };
  }

  return { empty: false, match: { $or: orConditions } };
}

/**
 * Precomputed filters for accounts_manager dashboard (scoped to assigned RMs only).
 * @returns {Promise<null | { isEmpty: true } | { isEmpty: false, leadMatch: object, invoiceMatch: object, franchiseMatch: object, payoutMatch: object, activeAgentsMatch: object, recentAgentsMatch: object, rmUserCountMatch: object }>}
 */
export async function getAccountsManagerDashboardScopes(req) {
  if (!req.user || req.user.role !== 'accounts_manager') return null;

  const assignedRMIds = await getAccountantAssignedRegionalManagerIds(req);
  if (!assignedRMIds?.length) {
    return { isEmpty: true };
  }

  const rmObjectIds = assignedRMIds
    .filter((id) => mongoose.Types.ObjectId.isValid(id))
    .map((id) => new mongoose.Types.ObjectId(id));

  const { agentIds } = await getAccountantAccessibleUserIds(req);
  const agentObjectIds = (agentIds || [])
    .filter((id) => id && mongoose.Types.ObjectId.isValid(id))
    .map((id) => new mongoose.Types.ObjectId(id));

  const inv = await buildAccountsManagerInvoiceMatch(req);
  const invoiceMatch = inv.empty ? { _id: { $in: [] } } : inv.match;

  const leadMatch =
    agentObjectIds.length > 0 ? { agent: { $in: agentObjectIds } } : { _id: { $in: [] } };

  const franchiseMatch = { regionalManager: { $in: rmObjectIds }, status: 'active' };

  const payoutMatch =
    agentObjectIds.length > 0 ? { agent: { $in: agentObjectIds } } : { _id: { $in: [] } };

  const activeAgentsMatch =
    agentObjectIds.length > 0
      ? { role: 'agent', status: 'active', _id: { $in: agentObjectIds } }
      : { _id: { $in: [] } };

  const recentAgentsMatch =
    agentObjectIds.length > 0 ? { role: 'agent', _id: { $in: agentObjectIds } } : { _id: { $in: [] } };

  const rmDocIds = await RelationshipManager.find({ regionalManager: { $in: rmObjectIds } }).distinct('_id');
  const rmUserCountMatch =
    rmDocIds?.length > 0
      ? {
          role: 'relationship_manager',
          status: 'active',
          relationshipManagerOwned: { $in: rmDocIds },
        }
      : { _id: { $in: [] } };

  return {
    isEmpty: false,
    leadMatch,
    invoiceMatch,
    franchiseMatch,
    payoutMatch,
    activeAgentsMatch,
    recentAgentsMatch,
    rmUserCountMatch,
  };
}

/**
 * Get all user IDs (agents, relationship managers, franchise) under assigned Regional Managers
 * @param {Object} req - Express request with req.user
 * @returns {Promise<{agentIds: string[], relationshipManagerIds: string[], franchiseIds: string[], regionalManagerIds: string[]}>}
 */
export async function getAccountantAccessibleUserIds(req) {
  if (!req.user || req.user.role !== 'accounts_manager') {
    return {
      agentIds: [],
      relationshipManagerIds: [],
      franchiseIds: [],
      regionalManagerIds: []
    };
  }

  try {
    const rmIds = await getAccountantAssignedRegionalManagerIds(req);
    
    if (!rmIds || rmIds.length === 0) {
      return {
        agentIds: [],
        relationshipManagerIds: [],
        franchiseIds: [],
        regionalManagerIds: []
      };
    }

    // Get franchises under these RMs
    const franchiseIds = await Franchise.find({ 
      regionalManager: { $in: rmIds } 
    }).distinct('_id');
    const franchiseIdStrings = franchiseIds.map(id => id.toString());

    // Get Relationship Managers under these RMs
    const relationshipManagers = await RelationshipManager.find({ 
      regionalManager: { $in: rmIds } 
    }).select('_id owner');
    const relationshipManagerIds = relationshipManagers.map(rm => rm._id.toString());
    const relationshipManagerOwnerIds = relationshipManagers
      .filter(rm => rm.owner)
      .map(rm => rm.owner.toString());

    // Get agents under these RMs (through franchises and relationship managers)
    const agentQuery = {
      role: 'agent',
      $or: [
        { managedByModel: 'Franchise', managedBy: { $in: franchiseIds } },
        { managedByModel: 'RelationshipManager', managedBy: { $in: relationshipManagerIds } }
      ]
    };
    const agents = await User.find(agentQuery).select('_id');
    const agentIds = agents.map(agent => agent._id.toString());

    // Get franchise owner user IDs
    const franchiseOwners = await User.find({
      role: 'franchise',
      franchiseOwned: { $in: franchiseIds }
    }).select('_id');
    const franchiseOwnerIds = franchiseOwners.map(owner => owner._id.toString());

    return {
      agentIds,
      relationshipManagerIds: relationshipManagerOwnerIds,
      franchiseIds: franchiseOwnerIds,
      regionalManagerIds: rmIds
    };
  } catch (error) {
    console.error('Error getting accessible user IDs for accountant:', error);
    return {
      agentIds: [],
      relationshipManagerIds: [],
      franchiseIds: [],
      regionalManagerIds: []
    };
  }
}

/**
 * Get all agent IDs under assigned Regional Managers
 * @param {Object} req - Express request with req.user
 * @returns {Promise<string[]>}
 */
export async function getAccountantAccessibleAgentIds(req) {
  const { agentIds } = await getAccountantAccessibleUserIds(req);
  return agentIds;
}

/**
 * Get all Relationship Manager user IDs under assigned Regional Managers
 * @param {Object} req - Express request with req.user
 * @returns {Promise<string[]>}
 */
export async function getAccountantAccessibleRelationshipManagerIds(req) {
  const { relationshipManagerIds } = await getAccountantAccessibleUserIds(req);
  return relationshipManagerIds;
}

/**
 * Get all Franchise user IDs under assigned Regional Managers
 * @param {Object} req - Express request with req.user
 * @returns {Promise<string[]>}
 */
export async function getAccountantAccessibleFranchiseIds(req) {
  const { franchiseIds } = await getAccountantAccessibleUserIds(req);
  return franchiseIds;
}

/**
 * Check if accountant can access a lead (by checking if lead's agent is in accessible users)
 * @param {Object} req - Express request
 * @param {Object} lead - Lead document
 * @returns {Promise<boolean>}
 */
export async function accountantCanAccessLead(req, lead) {
  if (!req.user || req.user.role !== 'accounts_manager') return true;
  
  const { agentIds } = await getAccountantAccessibleUserIds(req);
  if (agentIds.length === 0) return false;
  
  const leadAgentId = lead.agent?.toString() || lead.agent;
  return agentIds.includes(leadAgentId);
}

