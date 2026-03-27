import User from '../models/user.model.js';
import { getRegionalManagerFranchiseIds, regionalManagerCanAccessFranchise, getRegionalManagerRelationshipManagerIds, regionalManagerCanAccessRelationshipManager } from '../utils/regionalScope.js';

/**
 * Create Agent
 */
export const createAgent = async (req, res, next) => {
  try {
    const agentData = {
      ...req.body,
      role: 'agent',
    };

    // If creating as a franchise owner, assign ownership to that franchise
    if (req.user.role === 'franchise' && req.user.franchiseOwned) {
      agentData.managedBy = agentData.managedBy || req.user.franchiseOwned;
      agentData.managedByModel = agentData.managedByModel || 'Franchise';
    } else if (req.user.role === 'relationship_manager') {
      // Relationship Manager can create partner only under self (not under franchise).
      const RM = await import('../models/relationship.model.js').then(m => m.default).catch(() => null);
      let rmId = req.user.relationshipManagerOwned;
      if (!rmId && RM) {
        const rmDoc = await RM.findOne({ owner: req.user._id }).select('_id');
        if (rmDoc) rmId = rmDoc._id;
      }
      if (!rmId) {
        return res.status(400).json({
          success: false,
          message: 'Relationship Manager profile not found. Please contact admin.',
        });
      }
      agentData.managedByModel = 'RelationshipManager';
      agentData.managedBy = rmId;
    } else if (req.user.role === 'regional_manager') {
      const franchiseIds = await getRegionalManagerFranchiseIds(req);
      if (!franchiseIds?.length) {
        return res.status(400).json({
          success: false,
          message: 'You have no franchises assigned. Create or get a franchise first.',
        });
      }

      const requestedId = agentData.managedBy?.toString?.() || agentData.managedBy;
      const requestedModel = agentData.managedByModel || 'Franchise';
      if (!requestedId) {
        return res.status(400).json({
          success: false,
          message: `${requestedModel === 'Franchise' ? 'Franchise' : 'Relationship Manager'} is required. Select from the list.`,
        });
      }

      if (requestedModel === 'Franchise') {
        const allowed = franchiseIds.some((id) => id.toString() === requestedId);
        if (!allowed) {
          return res.status(403).json({
            success: false,
            message: 'You can only create partners under franchises assigned to you. Select a franchise from the list.',
          });
        }
      } else if (requestedModel === 'RelationshipManager') {
        // If assigning under a RelationshipManager, ensure that RM is within this regional manager's scope
        const RM = await import('../models/relationship.model.js').then(m => m.default).catch(() => null);
        if (RM) {
          const rmDoc = await RM.findById(requestedId).select('regionalManager');
          if (rmDoc && rmDoc.regionalManager && rmDoc.regionalManager.toString() !== req.user._id.toString()) {
            return res.status(403).json({
              success: false,
              message: 'You can only assign partners to relationship managers in your region.',
            });
          }
        }
      }
    }

    const agent = await User.create(agentData);

    const agentWithManagedBy = await User.findById(agent._id)
      .select('-password')
      .populate('managedBy', 'name')
      .populate('franchise', 'name');
    console.log('[Agent Created]', {
      id: agent._id,
      name: agent.name,
      email: agent.email,
      managedById: agent.managedBy,
      managedByName: agentWithManagedBy?.managedBy?.name ?? 'NA',
      createdBy: req.user.role,
    });

    res.status(201).json({
      success: true,
      data: agentWithManagedBy,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Get All Agents
 */
export const getAgents = async (req, res, next) => {
  try {
    const query = { role: 'agent' };

    // Role-based filtering
    if (req.user.role === 'accounts_manager') {
      // Accountant can only see agents under assigned Regional Managers
      const { getAccountantAccessibleAgentIds } = await import('../utils/accountantScope.js');
      const accessibleAgentIds = await getAccountantAccessibleAgentIds(req);
      if (accessibleAgentIds.length === 0) {
        return res.status(200).json({ success: true, data: [] });
      }
      query._id = { $in: accessibleAgentIds };
    } else if (req.user.role === 'franchise') {
      if (!req.user.franchiseOwned) {
        return res.status(400).json({
          success: false,
          message: 'Franchise owner does not have an associated franchise',
        });
      }
      query.managedBy = req.user.franchiseOwned;
      query.managedByModel = 'Franchise';
    } else if (req.user.role === 'agent') {
      query._id = req.user._id;
    } else if (req.user.role === 'relationship_manager') {
      // Relationship managers can only see agents managed by their RelationshipManager profile
      const RM = await import('../models/relationship.model.js').then(m => m.default).catch(() => null);
      let rmId = req.user.relationshipManagerOwned;
      if (!rmId && RM) {
        const rmDoc = await RM.findOne({ owner: req.user._id }).select('_id');
        if (rmDoc) rmId = rmDoc._id;
      }
      if (!rmId) {
        // No associated RM profile -> no agents
        return res.status(200).json({ success: true, data: [] });
      }
      query.managedByModel = 'RelationshipManager';
      query.managedBy = rmId;
    } else if (req.user.role === 'regional_manager') {
      const franchiseIds = await getRegionalManagerFranchiseIds(req);
      if (franchiseIds === null || franchiseIds.length === 0) {
        // no franchises assigned to this regional manager -> still allow agents assigned
        // to relationship managers that belong to this regional manager below
      }

      // Include agents directly under franchises assigned to this regional manager
      // and agents assigned to RelationshipManagers that belong to this regional manager.
      const RM = await import('../models/relationship.model.js').then(m => m.default).catch(() => null);
      let rmIds = [];
      if (RM) {
        rmIds = await RM.find({ regionalManager: req.user._id }).distinct('_id');
      }

      const orClauses = [];
      if (franchiseIds && franchiseIds.length) {
        orClauses.push({ managedByModel: 'Franchise', managedBy: { $in: franchiseIds } });
      }
      if (rmIds && rmIds.length) {
        orClauses.push({ managedByModel: 'RelationshipManager', managedBy: { $in: rmIds } });
      }

      // If no clauses, return empty result set
      if (orClauses.length === 0) {
        return res.status(200).json({ success: true, data: [] });
      }

      query.$or = orClauses;
    }

    // Exclude sub-agents (those with parentAgent) from the agents list
    // Sub-agents should only appear in the SubAgents page
    query.parentAgent = { $exists: false };

    const agents = await User.find(query)
      .select('-password')
      .populate('managedBy', 'name')
      .populate('franchise', 'name');

    res.status(200).json({
      success: true,
      data: agents,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Get Agent By ID
 */
export const getAgentById = async (req, res, next) => {
  try {
    const agent = await User.findOne({ _id: req.params.id, role: 'agent' })
      .select('-password')
      .populate('managedBy', 'name')
      .populate('franchise', 'name');

    if (!agent) {
      return res.status(404).json({
        success: false,
        error: 'Partner not found',
      });
    }

    // Role-based access control
    if (req.user.role === 'agent' && agent._id.toString() !== req.user._id.toString()) {
      return res.status(403).json({
        success: false,
        error: 'Access denied. You can only view your own profile.',
      });
    }

    if (req.user.role === 'franchise') {
      if (!req.user.franchiseOwned) {
        return res.status(400).json({
          success: false,
          message: 'Franchise owner does not have an associated franchise',
        });
      }
      const managedById = agent.managedBy?._id || agent.managedBy;
      if (!managedById || managedById.toString() !== req.user.franchiseOwned.toString()) {
        return res.status(403).json({
          success: false,
          error: 'Access denied. You can only view partners from your franchise.',
        });
      }
    }
    if (req.user.role === 'relationship_manager') {
      // Ensure agent is managed by this relationship manager
      const RM = await import('../models/relationship.model.js').then(m => m.default).catch(() => null);
      let rmId = req.user.relationshipManagerOwned;
      if (!rmId && RM) {
        const rmDoc = await RM.findOne({ owner: req.user._id }).select('_id');
        if (rmDoc) rmId = rmDoc._id;
      }
      const managedById = agent.managedBy?._id || agent.managedBy;
      if (!rmId || !managedById || managedById.toString() !== rmId.toString()) {
        return res.status(403).json({
          success: false,
          error: 'Access denied. You can only view partners associated with you.',
        });
      }
    }
    if (req.user.role === 'regional_manager') {
      // Check if agent is under a franchise or relationship manager that belongs to this regional manager
      let canAccess = false;
      if (agent.managedByModel === 'Franchise') {
        canAccess = await regionalManagerCanAccessFranchise(req, agent.managedBy);
      } else if (agent.managedByModel === 'RelationshipManager') {
        canAccess = await regionalManagerCanAccessRelationshipManager(req, agent.managedBy);
      }
      if (!canAccess) {
        return res.status(403).json({
          success: false,
          error: 'Access denied. You can only view partners from your hierarchy.',
        });
      }
    }

    res.status(200).json({
      success: true,
      data: agent,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Update Agent
 */
export const updateAgent = async (req, res, next) => {
  try {
    // Check access before updating
    const existingAgent = await User.findOne({ _id: req.params.id, role: 'agent' });
    if (!existingAgent) {
      return res.status(404).json({
        success: false,
        error: 'Partner not found',
      });
    }

    // Role-based access control
    if (req.user.role === 'franchise') {
      if (!req.user.franchiseOwned) {
        return res.status(400).json({
          success: false,
          message: 'Franchise owner does not have an associated franchise',
        });
      }
      if (existingAgent.managedBy?.toString() !== req.user.franchiseOwned.toString()) {
        return res.status(403).json({
          success: false,
          error: 'Access denied. You can only update partners from your franchise.',
        });
      }
    }
    if (req.user.role === 'relationship_manager') {
      // Ensure agent is managed by this relationship manager
      const RM = await import('../models/relationship.model.js').then(m => m.default).catch(() => null);
      let rmId = req.user.relationshipManagerOwned;
      if (!rmId && RM) {
        const rmDoc = await RM.findOne({ owner: req.user._id }).select('_id');
        if (rmDoc) rmId = rmDoc._id;
      }
      if (!rmId || existingAgent.managedBy?.toString() !== rmId.toString()) {
        return res.status(403).json({
          success: false,
          error: 'Access denied. You can only update partners associated with you.',
        });
      }
    }
    if (req.user.role === 'regional_manager') {
      // Check if agent is under a franchise or relationship manager that belongs to this regional manager
      if (existingAgent.managedByModel === 'Franchise') {
        const canAccess = await regionalManagerCanAccessFranchise(req, existingAgent.managedBy);
        if (!canAccess) {
          return res.status(403).json({
            success: false,
            error: 'Access denied. You can only update agents from franchises associated with you.',
          });
        }
      } else if (existingAgent.managedByModel === 'RelationshipManager') {
        const canAccess = await regionalManagerCanAccessRelationshipManager(req, existingAgent.managedBy);
        if (!canAccess) {
          return res.status(403).json({
            success: false,
            error: 'Access denied. You can only update agents from relationship managers associated with you.',
          });
        }
      } else {
        return res.status(403).json({
          success: false,
          error: 'Access denied. Agent must be associated with a franchise or relationship manager.',
        });
      }
    }

    const agent = await User.findOneAndUpdate(
      { _id: req.params.id, role: 'agent' },
      req.body,
      {
        new: true,
        runValidators: true,
      }
    )
      .select('-password')
      .populate('managedBy', 'name')
      .populate('franchise', 'name');

    res.status(200).json({
      success: true,
      data: agent,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Update Agent Status
 */
export const updateAgentStatus = async (req, res, next) => {
  try {
    const { status } = req.body;

    // Check access before updating
    const existingAgent = await User.findOne({ _id: req.params.id, role: 'agent' });
    if (!existingAgent) {
      return res.status(404).json({
        success: false,
        error: 'Partner not found',
      });
    }

    // Role-based access control
    if (req.user.role === 'franchise') {
      if (!req.user.franchiseOwned) {
        return res.status(400).json({
          success: false,
          message: 'Franchise owner does not have an associated franchise',
        });
      }
      if (existingAgent.managedBy?.toString() !== req.user.franchiseOwned.toString()) {
        return res.status(403).json({
          success: false,
          error: 'Access denied. You can only update partners from your franchise.',
        });
      }
    }
    if (req.user.role === 'regional_manager') {
      // Check if agent is under a franchise or relationship manager that belongs to this regional manager
      if (existingAgent.managedByModel === 'Franchise') {
        const canAccess = await regionalManagerCanAccessFranchise(req, existingAgent.managedBy);
        if (!canAccess) {
          return res.status(403).json({
            success: false,
            error: 'Access denied. You can only update agents from franchises associated with you.',
          });
        }
      } else if (existingAgent.managedByModel === 'RelationshipManager') {
        const canAccess = await regionalManagerCanAccessRelationshipManager(req, existingAgent.managedBy);
        if (!canAccess) {
          return res.status(403).json({
            success: false,
            error: 'Access denied. You can only update agents from relationship managers associated with you.',
          });
        }
      } else {
        return res.status(403).json({
          success: false,
          error: 'Access denied. Agent must be associated with a franchise or relationship manager.',
        });
      }
    }
    if (req.user.role === 'relationship_manager') {
      const RM = await import('../models/relationship.model.js').then(m => m.default).catch(() => null);
      let rmId = req.user.relationshipManagerOwned;
      if (!rmId && RM) {
        const rmDoc = await RM.findOne({ owner: req.user._id }).select('_id');
        if (rmDoc) rmId = rmDoc._id;
      }
      if (!rmId || existingAgent.managedBy?.toString() !== rmId.toString()) {
        return res.status(403).json({
          success: false,
          error: 'Access denied. You can only update partners associated with you.',
        });
      }
    }

    const agent = await User.findOneAndUpdate(
      { _id: req.params.id, role: 'agent' },
      { status },
      { new: true }
    ).select('-password');

    res.status(200).json({
      success: true,
      message: 'Agent status updated',
      data: agent,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Delete Agent
 */
export const deleteAgent = async (req, res, next) => {
  try {
    const agent = await User.findOne({ _id: req.params.id, role: 'agent' });
    if (!agent) {
      return res.status(404).json({
        success: false,
        message: 'Agent not found',
      });
    }
    if (req.user.role === 'regional_manager') {
      // Check if agent is under a franchise or relationship manager that belongs to this regional manager
      if (agent.managedByModel === 'Franchise') {
        const canAccess = await regionalManagerCanAccessFranchise(req, agent.managedBy);
        if (!canAccess) {
          return res.status(403).json({
            success: false,
            error: 'Access denied. You can only delete agents from franchises associated with you.',
          });
        }
      } else if (agent.managedByModel === 'RelationshipManager') {
        const canAccess = await regionalManagerCanAccessRelationshipManager(req, agent.managedBy);
        if (!canAccess) {
          return res.status(403).json({
            success: false,
            error: 'Access denied. You can only delete agents from relationship managers associated with you.',
          });
        }
      } else {
        return res.status(403).json({
          success: false,
          error: 'Access denied. Agent must be associated with a franchise or relationship manager.',
        });
      }
    }
    if (req.user.role === 'relationship_manager') {
      const RM = await import('../models/relationship.model.js').then(m => m.default).catch(() => null);
      let rmId = req.user.relationshipManagerOwned;
      if (!rmId && RM) {
        const rmDoc = await RM.findOne({ owner: req.user._id }).select('_id');
        if (rmDoc) rmId = rmDoc._id;
      }
      if (!rmId || agent.managedBy?.toString() !== rmId.toString()) {
        return res.status(403).json({
          success: false,
          error: 'Access denied. You can only delete agents associated with you.',
        });
      }
    }
    
    // Log deletion to audit log
    const agentData = agent.toObject();
    const auditService = (await import('../services/audit.service.js')).default;
    await auditService.logDelete(req.user._id, 'User', req.params.id, agentData, req);
    
    await User.findOneAndDelete({ _id: req.params.id, role: 'agent' });

    res.status(200).json({
      success: true,
      message: 'Agent deleted successfully',
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Create Sub-Agent (for agents)
 */
export const createSubAgent = async (req, res, next) => {
  try {
    // Only agents can create sub-agents
    if (req.user.role !== 'agent') {
      return res.status(403).json({
        success: false,
        error: 'Only agents can create sub-agents',
      });
    }

    const subAgentData = {
      ...req.body,
      role: 'agent',
      parentAgent: req.user._id, // Set parent agent to current logged-in agent
      // Inherit managedBy from parent agent
      managedBy: req.user.managedBy,
      managedByModel: req.user.managedByModel,
      // Don't set password - sub-agents don't need to log in
      // Only include password if explicitly provided
    };
    
    // Remove password from subAgentData if not provided (sub-agents don't need passwords)
    if (!req.body.password) {
      delete subAgentData.password;
    }

    const subAgent = await User.create(subAgentData);

    const subAgentWithParent = await User.findById(subAgent._id)
      .select('-password')
      .populate('parentAgent', 'name email')
      .populate('managedBy', 'name');

    res.status(201).json({
      success: true,
      data: subAgentWithParent,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Get All Sub-Agents (for current agent or admin)
 */
export const getSubAgents = async (req, res, next) => {
  try {
    // Only agents and super_admin can view sub-agents
    if (req.user.role !== 'agent' && req.user.role !== 'super_admin') {
      return res.status(403).json({
        success: false,
        error: 'Only agents and admins can view sub-agents',
      });
    }

    // Build query: agents see only their own, super_admin sees all
    const query = { role: 'agent' };
    if (req.user.role === 'agent') {
      query.parentAgent = req.user._id;
    } else if (req.user.role === 'super_admin') {
      // Admin can see all sub-agents (those with parentAgent set)
      query.parentAgent = { $exists: true, $ne: null };
    }

    const subAgents = await User.find(query)
      .select('-password')
      .populate('parentAgent', 'name email')
      .populate('managedBy', 'name')
      .sort({ createdAt: -1 });

    res.status(200).json({
      success: true,
      data: subAgents,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Get Sub-Agent By ID
 */
export const getSubAgentById = async (req, res, next) => {
  try {
    // Only agents and super_admin can view sub-agents
    if (req.user.role !== 'agent' && req.user.role !== 'super_admin') {
      return res.status(403).json({
        success: false,
        error: 'Only agents and admins can view sub-agents',
      });
    }

    // Build query: agents see only their own, super_admin sees all
    const query = { _id: req.params.id, role: 'agent' };
    if (req.user.role === 'agent') {
      query.parentAgent = req.user._id;
    }

    const subAgent = await User.findOne(query)
      .select('-password')
      .populate('parentAgent', 'name email')
      .populate('managedBy', 'name');

    if (!subAgent) {
      return res.status(404).json({
        success: false,
        error: 'Sub-agent not found',
      });
    }

    res.status(200).json({
      success: true,
      data: subAgent,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Update Sub-Agent
 */
export const updateSubAgent = async (req, res, next) => {
  try {
    // Only agents and super_admin can update sub-agents
    if (req.user.role !== 'agent' && req.user.role !== 'super_admin') {
      return res.status(403).json({
        success: false,
        error: 'Only agents and admins can update sub-agents',
      });
    }

    // Build query: agents can only update their own, super_admin can update any
    const query = { _id: req.params.id, role: 'agent' };
    if (req.user.role === 'agent') {
      query.parentAgent = req.user._id;
    }

    const existingSubAgent = await User.findOne(query);

    if (!existingSubAgent) {
      return res.status(404).json({
        success: false,
        error: 'Sub-agent not found',
      });
    }

    // Prevent changing parentAgent or role (unless super_admin)
    const updateData = { ...req.body };
    if (req.user.role !== 'super_admin') {
      delete updateData.parentAgent;
      delete updateData.role;
      delete updateData.managedBy;
      delete updateData.managedByModel;
    }

    const subAgent = await User.findOneAndUpdate(
      query,
      updateData,
      { new: true, runValidators: true }
    )
      .select('-password')
      .populate('parentAgent', 'name email')
      .populate('managedBy', 'name');

    res.status(200).json({
      success: true,
      data: subAgent,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Delete Sub-Agent
 */
export const deleteSubAgent = async (req, res, next) => {
  try {
    // Only agents and super_admin can delete sub-agents
    if (req.user.role !== 'agent' && req.user.role !== 'super_admin') {
      return res.status(403).json({
        success: false,
        error: 'Only agents and admins can delete sub-agents',
      });
    }

    // Build query: agents can only delete their own, super_admin can delete any
    const query = { _id: req.params.id, role: 'agent' };
    if (req.user.role === 'agent') {
      query.parentAgent = req.user._id;
    }

    const subAgent = await User.findOne(query);

    if (!subAgent) {
      return res.status(404).json({
        success: false,
        error: 'Sub-agent not found',
      });
    }

    // Delete the sub-agent
    await User.findOneAndDelete(query);

    res.status(200).json({
      success: true,
      message: 'Sub-agent deleted successfully',
    });
  } catch (error) {
    next(error);
  }
};
