import Franchise from '../models/franchise.model.js';
import User from '../models/user.model.js';
import Lead from '../models/lead.model.js';
import Invoice from '../models/invoice.model.js';
import Payout from '../models/payout.model.js';
import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import auditService from '../services/audit.service.js';
import { getPaginationMeta } from '../utils/helpers.js';
import { getRegionalManagerFranchiseIds, regionalManagerCanAccessFranchise } from '../utils/regionalScope.js';

/**
 * Create Franchise (and franchise User for login)
 */
export const createFranchise = async (req, res, next) => {
  try {
    const { name, ownerName, email, mobile, password, address, status, commissionStructure, commissionPercentage, regionalManager, franchiseType } = req.body;

    if (!name?.trim()) {
      return res.status(400).json({
        success: false,
        message: 'Franchise name is required',
      });
    }

    if (!email?.trim()) {
      return res.status(400).json({
        success: false,
        message: 'Owner email is required for login',
      });
    }
    if (!mobile?.trim()) {
      return res.status(400).json({
        success: false,
        message: 'Owner mobile is required',
      });
    }
    if (!password || password.length < 6) {
      return res.status(400).json({
        success: false,
        message: 'Password is required and must be at least 6 characters',
      });
    }

    // Validate commissionPercentage if provided
    if (commissionPercentage !== undefined && commissionPercentage !== null && commissionPercentage !== '') {
      const parsedCommission = parseFloat(commissionPercentage);
      if (isNaN(parsedCommission) || parsedCommission < 0 || parsedCommission > 100) {
        return res.status(400).json({
          success: false,
          message: 'Commission percentage must be between 0 and 100',
        });
      }
    }

    // Check if user with this email or mobile already exists
    const existingUser = await User.findOne({
      $or: [{ email: email.toLowerCase().trim() }, { mobile: mobile.trim() }],
    });
    if (existingUser) {
      return res.status(400).json({
        success: false,
        message: 'A user with this email or mobile already exists',
      });
    }

    // Check if franchise with this email or mobile already exists
    const existingFranchise = await Franchise.findOne({
      $or: [{ email: email.toLowerCase().trim() }, { mobile: mobile.trim() }],
    });
    if (existingFranchise) {
      return res.status(400).json({
        success: false,
        message: `Email "${email}" already exists. Please use a different email.`,
      });
    }

    let allowedRegionalManager = regionalManager;
    if (regionalManager && req.user.role !== 'super_admin') {
      allowedRegionalManager = undefined;
    }
    if (allowedRegionalManager) {
      const rm = await User.findById(allowedRegionalManager);
      if (!rm || rm.role !== 'regional_manager') {
        return res.status(400).json({
          success: false,
          message: 'Invalid regional manager. Select a user with regional_manager role.',
        });
      }
    }


    // Owner user `name` must be non-empty; form may only send franchise `name` (ownerName optional in UI).
    const resolvedOwnerName = (ownerName && String(ownerName).trim()) || name.trim();

    const franchisePayload = {
      name: name.trim(),
      ownerName: resolvedOwnerName,
      email: email.toLowerCase().trim(),
      mobile: mobile.trim(),
      status: status || 'active',
      franchiseType: franchiseType || 'normal',
      address: address || {},
      commissionStructure: commissionStructure || {},
      ...(commissionPercentage !== undefined && commissionPercentage !== null && commissionPercentage !== '' 
        ? { commissionPercentage: parseFloat(commissionPercentage) } 
        : {}),
      ...(allowedRegionalManager && { regionalManager: allowedRegionalManager }),
    };
    if (req.user.role === 'regional_manager') {
      franchisePayload.regionalManager = req.user._id;
    }
    // relationship managers are not directly linked to franchises per new hierarchy
    const franchise = await Franchise.create(franchisePayload);

    const hashedPassword = await bcrypt.hash(password, 10);
    const ownerUser = await User.create({
      name: resolvedOwnerName,
      email: franchise.email,
      mobile: franchise.mobile,
      password: hashedPassword,
      role: 'franchise',
      franchise: franchise._id,
      franchiseOwned: franchise._id,
      status: 'active',
    });

    franchise.owner = ownerUser._id;
    await franchise.save();

    const populatedFranchise = await Franchise.findById(franchise._id)
      .populate('owner', 'name email')
      .populate('regionalManager', 'name email');

    console.log('✅ Franchise created successfully:', {
      id: franchise._id,
      name: franchise.name,
      ownerId: ownerUser._id,
      status: franchise.status,
    });

    res.status(201).json({
      success: true,
      message: 'Franchise created successfully and saved to database',
      data: populatedFranchise,
    });
  } catch (error) {
    console.error('❌ Error creating franchise:', error);
    next(error);
  }
};

/**
 * Get All Franchises
 */
export const getFranchises = async (req, res, next) => {
  try {
    const { page = 1, limit = 10, status } = req.query;
    const skip = (page - 1) * limit;

    const query = {};
    if (status) query.status = status;
    // Relationship managers can fetch franchises (e.g. for Refer Franchise dropdown when creating leads)
    if (req.user?.role === 'relationship_manager') {
      // No extra scope: allow list for refer-franchise use case
    } else if (req.user.role === 'accounts_manager') {
      // Accountant can only see franchises under assigned Regional Managers
      const { getAccountantAssignedRegionalManagerIds } = await import('../utils/accountantScope.js');
      const assignedRMIds = await getAccountantAssignedRegionalManagerIds(req);
      if (assignedRMIds.length === 0) {
        return res.status(200).json({
          success: true,
          data: [],
          pagination: getPaginationMeta(page, limit, 0),
        });
      }
      query.regionalManager = { $in: assignedRMIds };
    } else if (req.user.role === 'regional_manager') {
      query.regionalManager = req.user._id;
    }

    const franchises = await Franchise.find(query)
      .populate('owner', 'name email')
      .populate('regionalManager', 'name email')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(parseInt(limit));

    const total = await Franchise.countDocuments(query);
    const pagination = getPaginationMeta(page, limit, total);

    res.status(200).json({
      success: true,
      data: franchises,
      pagination,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Get Active Franchises (all when not authenticated; scoped by role when logged in)
 */
export const getActiveFranchises = async (req, res, next) => {
  try {
    const query = { status: 'active' };
    if (req.user?.role === 'regional_manager') {
      const franchiseIds = await getRegionalManagerFranchiseIds(req);
      if (franchiseIds?.length) query._id = { $in: franchiseIds };
      else query._id = null; // no franchises under this RM
    } else if (req.user?.role === 'franchise' && req.user.franchiseOwned) {
      query._id = req.user.franchiseOwned;
    }
    const franchises = await Franchise.find(query)
      .select('name _id')
      .sort({ name: 1 });

    res.status(200).json({
      success: true,
      data: franchises,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Get Franchise By ID
 */
export const getFranchiseById = async (req, res, next) => {
  try {
    const franchise = await Franchise.findById(req.params.id)
      .populate('owner', 'name email')
      .populate('regionalManager', 'name email');

    if (!franchise) {
      return res.status(404).json({
        success: false,
        message: 'Franchise not found',
      });
    }
    // Relationship managers should not be allowed to view franchise details
    if (req.user?.role === 'relationship_manager') {
      return res.status(403).json({
        success: false,
        message: 'Access denied.',
      });
    }
    if (req.user.role === 'regional_manager') {
      if (franchise.regionalManager?.toString() !== req.user._id.toString()) {
        return res.status(403).json({
          success: false,
          message: 'Access denied. You can only view franchises associated with you.',
        });
      }
    }

    res.status(200).json({
      success: true,
      data: franchise,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Update Franchise
 */
export const updateFranchise = async (req, res, next) => {
  try {
    // Relationship managers should not be allowed to update franchises
    if (req.user?.role === 'relationship_manager') {
      return res.status(403).json({
        success: false,
        message: 'Access denied.',
      });
    }
    if (req.user.role === 'regional_manager') {
      const canAccess = await regionalManagerCanAccessFranchise(req, req.params.id);
      if (!canAccess) {
        return res.status(403).json({
          success: false,
          message: 'Access denied. You can only update franchises associated with you.',
        });
      }
    }
    const updatePayload = { ...req.body };
    
    // Parse commissionPercentage if provided
    if (updatePayload.commissionPercentage !== undefined && updatePayload.commissionPercentage !== null && updatePayload.commissionPercentage !== '') {
      updatePayload.commissionPercentage = parseFloat(updatePayload.commissionPercentage);
      if (isNaN(updatePayload.commissionPercentage) || updatePayload.commissionPercentage < 0 || updatePayload.commissionPercentage > 100) {
        return res.status(400).json({
          success: false,
          message: 'Commission percentage must be between 0 and 100',
        });
      }
    }
    
    if (req.user.role !== 'super_admin') {
      delete updatePayload.regionalManager;
    }
    if (updatePayload.regionalManager !== undefined) {
      if (!updatePayload.regionalManager) {
        updatePayload.regionalManager = null;
      } else {
        const rm = await User.findById(updatePayload.regionalManager);
        if (!rm || rm.role !== 'regional_manager') {
          return res.status(400).json({
            success: false,
            message: 'Invalid regional manager. Select a user with regional_manager role.',
          });
        }
      }
    }
    // relationship managers are not linked to franchises; ignore any relationshipManager updates
    const franchise = await Franchise.findByIdAndUpdate(req.params.id, updatePayload, {
      new: true,
      runValidators: true,
    })
      .populate('owner', 'name email')
      .populate('regionalManager', 'name email');

    if (!franchise) {
      return res.status(404).json({
        success: false,
        message: 'Franchise not found',
      });
    }

    res.status(200).json({
      success: true,
      message: 'Franchise updated successfully',
      data: franchise,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Update Franchise Status
 */
export const updateFranchiseStatus = async (req, res, next) => {
  try {
    // Relationship managers should not be allowed to update franchise status
    if (req.user?.role === 'relationship_manager') {
      return res.status(403).json({
        success: false,
        message: 'Access denied.',
      });
    }
    if (req.user.role === 'regional_manager') {
      const canAccess = await regionalManagerCanAccessFranchise(req, req.params.id);
      if (!canAccess) {
        return res.status(403).json({
          success: false,
          message: 'Access denied. You can only update franchises associated with you.',
        });
      }
    }
    const { status } = req.body;

    const franchise = await Franchise.findByIdAndUpdate(
      req.params.id,
      { status },
      { new: true }
    ).populate('owner', 'name email');

    if (!franchise) {
      return res.status(404).json({
        success: false,
        message: 'Franchise not found',
      });
    }

    res.status(200).json({
      success: true,
      message: 'Franchise status updated',
      data: franchise,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Get franchise agents
 */
export const getFranchiseAgents = async (req, res, next) => {
  try {
    // Relationship managers should not be allowed to view agents under a franchise
    if (req.user?.role === 'relationship_manager') {
      return res.status(403).json({
        success: false,
        message: 'Access denied.',
      });
    }
    if (req.user.role === 'regional_manager') {
      const canAccess = await regionalManagerCanAccessFranchise(req, req.params.id);
      if (!canAccess) {
        return res.status(403).json({
          success: false,
          message: 'Access denied. You can only view partners of franchises associated with you.',
        });
      }
    }
    const { page = 1, limit = 10, status } = req.query;
    const skip = (page - 1) * limit;

    const query = {
      franchise: req.params.id,
      role: 'agent',
    };
    if (status) query.status = status;

    const agents = await User.find(query)
      .select('-password')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(parseInt(limit));

    const total = await User.countDocuments(query);
    const pagination = getPaginationMeta(page, limit, total);

    res.status(200).json({
      success: true,
      data: agents,
      pagination,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Get franchise performance metrics
 */
export const getFranchisePerformance = async (req, res, next) => {
  try {
    // Relationship managers should not be allowed to view franchise performance
    if (req.user?.role === 'relationship_manager') {
      return res.status(403).json({
        success: false,
        message: 'Access denied.',
      });
    }
    if (req.user.role === 'regional_manager') {
      const canAccess = await regionalManagerCanAccessFranchise(req, req.params.id);
      if (!canAccess) {
        return res.status(403).json({
          success: false,
          message: 'Access denied. You can only view performance of franchises associated with you.',
        });
      }
    }
    const franchiseId = new mongoose.Types.ObjectId(req.params.id);

    // Get total agents
    const totalAgents = await User.countDocuments({
      franchise: franchiseId,
      role: 'agent',
      status: 'active',
    });

    // Get total leads
    const totalLeads = await Lead.countDocuments({ franchise: franchiseId });

    // Get disbursed amount
    const disbursedAggregation = await Lead.aggregate([
      { $match: { franchise: franchiseId } },
      { $group: { _id: null, total: { $sum: '$disbursedAmount' } } },
    ]);
    const totalDisbursed = disbursedAggregation[0]?.total || 0;

    // Get total commission
    const commissionAggregation = await Invoice.aggregate([
      { $match: { franchise: franchiseId } },
      { $group: { _id: null, total: { $sum: '$commissionAmount' } } },
    ]);
    const totalCommission = commissionAggregation[0]?.total || 0;

    // Update franchise performance metrics
    const franchise = await Franchise.findById(franchiseId);
    if (franchise) {
      franchise.performanceMetrics = {
        totalLeads,
        activeAgents: totalAgents,
        totalCommission,
        lastUpdated: new Date(),
      };
      await franchise.save();
    }

    res.status(200).json({
      success: true,
      data: {
        totalAgents,
        totalLeads,
        totalDisbursed,
        totalCommission,
      },
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Delete Franchise
 */
export const deleteFranchise = async (req, res, next) => {
  try {
    // Relationship managers should not be allowed to delete franchises
    if (req.user?.role === 'relationship_manager') {
      return res.status(403).json({
        success: false,
        message: 'Access denied.',
      });
    }
    if (req.user.role === 'regional_manager') {
      const canAccess = await regionalManagerCanAccessFranchise(req, req.params.id);
      if (!canAccess) {
        return res.status(403).json({
          success: false,
          message: 'Access denied. You can only delete franchises associated with you.',
        });
      }
    }
    
    const franchise = await Franchise.findById(req.params.id);
    if (!franchise) {
      return res.status(404).json({
        success: false,
        message: 'Franchise not found',
      });
    }
    
    // Log deletion to audit log
    const franchiseData = franchise.toObject();
    await auditService.logDelete(req.user._id, 'Franchise', req.params.id, franchiseData, req);
    
    await Franchise.findByIdAndDelete(req.params.id);

    res.status(200).json({
      success: true,
      message: 'Franchise deleted successfully',
    });
  } catch (error) {
    next(error);
  }
};
