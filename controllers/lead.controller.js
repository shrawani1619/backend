import mongoose from 'mongoose';
import Lead from '../models/lead.model.js';
import LeadHistory from '../models/leadHistory.model.js';
import User from '../models/user.model.js';
import Staff from '../models/staff.model.js';
import Bank from '../models/bank.model.js';
import BankManager from '../models/bankManager.model.js';
import RelationshipManager from '../models/relationship.model.js';
import Franchise from '../models/franchise.model.js';
import commissionService from '../services/commission.service.js';
import invoiceService from '../services/invoice.service.js';
import emailService from '../services/email.service.js';
import auditService from '../services/audit.service.js';
import { getPaginationMeta, trackLeadChanges } from '../utils/helpers.js';
import { getRegionalManagerFranchiseIds, regionalManagerCanAccessFranchise, regionalManagerCanAccessRelationshipManager } from '../utils/regionalScope.js';

/**
 * Create Lead
 */
export const createLead = async (req, res, next) => {
  try {
    // Generate case number

    let agentId = req.body.agent;
    let associated = req.body.associated;
    let associatedModel = req.body.associatedModel;

    // Normalize empty strings
    if (associated === '') associated = undefined;
    if (associatedModel === '') associatedModel = undefined;

    // Agent users always create leads for themselves; infer associated from their managedBy
    if (req.user.role === 'agent') {
      agentId = req.user._id;
      associated = req.user.managedBy || req.user.franchise || undefined;
      associatedModel = req.user.managedByModel || (req.user.franchise ? 'Franchise' : undefined);
    }

    // Franchise owners can create leads for themselves or assign to agents
    if (req.user.role === 'franchise') {
      // If agent is provided in body, use it (could be self or another agent)
      if (agentId) {
        // If agent is self (current user), set agent to current user
        if (agentId.toString() === req.user._id.toString()) {
          agentId = req.user._id;
          associated = req.user.franchiseOwned || req.user.franchise || associated;
          associatedModel = 'Franchise';
          // Franchise can set commission even when assigned to self (unlike RM)
        } else {
          // Agent is assigned to another agent - infer associated from that agent
          try {
            const agentUser = await User.findById(agentId).select('managedBy managedByModel');
            if (agentUser && agentUser.managedBy) {
              associated = agentUser.managedBy;
              associatedModel = agentUser.managedByModel;
            } else {
              // Fallback to franchise's associated
              associated = req.user.franchiseOwned || req.user.franchise || associated;
              associatedModel = 'Franchise';
            }
          } catch (err) {
            console.warn('Unable to infer associated from assigned agent:', err);
            associated = req.user.franchiseOwned || req.user.franchise || associated;
            associatedModel = 'Franchise';
          }
        }
      } else {
        // No agent specified - default to self
        agentId = req.user._id;
        associated = req.user.franchiseOwned || req.user.franchise || associated;
        associatedModel = 'Franchise';
      }
    }

    // Relationship managers can create leads for themselves or assign to agents
    if (req.user.role === 'relationship_manager') {
      // If agent is provided in body, use it (could be self or another agent)
      if (agentId) {
        // If agent is self (current user), set agent to current user
        if (agentId.toString() === req.user._id.toString()) {
          agentId = req.user._id;
          associated = req.user.relationshipManagerOwned || associated;
          associatedModel = 'RelationshipManager';
          // If RM assigns to self, remove commission fields
          if (req.body.commissionPercentage !== undefined) {
            delete req.body.commissionPercentage;
          }
          if (req.body.commissionAmount !== undefined) {
            delete req.body.commissionAmount;
          }
        } else {
          // Agent is assigned to another agent - infer associated from that agent
          try {
            const agentUser = await User.findById(agentId).select('managedBy managedByModel');
            if (agentUser && agentUser.managedBy) {
              associated = agentUser.managedBy;
              associatedModel = agentUser.managedByModel;
            } else {
              // Fallback to RM's associated
              associated = req.user.relationshipManagerOwned || associated;
              associatedModel = 'RelationshipManager';
            }
          } catch (err) {
            console.warn('Unable to infer associated from assigned agent:', err);
            associated = req.user.relationshipManagerOwned || associated;
            associatedModel = 'RelationshipManager';
          }
        }
      } else {
        // No agent specified - default to self
        agentId = req.user._id;
        associated = req.user.relationshipManagerOwned || associated;
        associatedModel = 'RelationshipManager';
      }
    }

    // Regional manager: if associatedModel === 'Franchise' enforce regional scope
    if (req.user.role === 'regional_manager' && associatedModel === 'Franchise' && associated) {
      const franchiseIds = await getRegionalManagerFranchiseIds(req);
      if (franchiseIds !== null && franchiseIds.length > 0) {
        const allowed = franchiseIds.some((fid) => fid.toString() === associated.toString());
        if (!allowed) {
          return res.status(403).json({
            success: false,
            error: 'Access denied. You can only create leads for franchises associated with you.',
          });
        }
      }
    }

    // If associated not provided, try to infer it from the agent (useful when RM creates lead for an agent)
    if (!associated && agentId) {
      try {
        const agentUser = await User.findById(agentId).select('managedBy managedByModel');
        if (agentUser && agentUser.managedBy) {
          associated = agentUser.managedBy;
          associatedModel = agentUser.managedByModel;
        }
      } catch (err) {
        console.warn('Unable to infer associated from agent:', err);
      }
    }

    // Get agent name if agent is assigned
    let agentName = req.body.agentName || req.user.name;
    if (agentId && agentId !== req.user._id) {
      try {
        const assignedAgent = await User.findById(agentId).select('name');
        if (assignedAgent) {
          agentName = assignedAgent.name;
        }
      } catch (err) {
        console.warn('Unable to fetch assigned agent name:', err);
      }
    }

    // Validate franchise commission limits if franchise user is setting commission
    if (req.user.role === 'franchise' && req.body.bank && (req.body.commissionPercentage || req.body.commissionAmount)) {
      try {
        const FranchiseCommissionLimit = (await import('../models/franchiseCommissionLimit.model.js')).default;
        const commissionLimit = await FranchiseCommissionLimit.findOne({ bank: req.body.bank })
          .populate('bank', 'name');

        if (commissionLimit) {
          let exceedsLimit = false;
          let errorMessage = '';

          if (commissionLimit.limitType === 'percentage') {
            // Validate percentage
            const franchisePercentage = req.body.commissionPercentage ? parseFloat(req.body.commissionPercentage) : 0;
            if (franchisePercentage > commissionLimit.maxCommissionValue) {
              exceedsLimit = true;
              errorMessage = `Commission cannot exceed Admin maximum limit of ${commissionLimit.maxCommissionValue}%`;
            }
          } else if (commissionLimit.limitType === 'amount') {
            // Validate amount
            const franchiseAmount = req.body.commissionAmount ? parseFloat(req.body.commissionAmount) : 0;
            if (franchiseAmount > commissionLimit.maxCommissionValue) {
              exceedsLimit = true;
              errorMessage = `Commission cannot exceed Admin maximum limit of ₹${commissionLimit.maxCommissionValue.toLocaleString()}`;
            }
          }

          if (exceedsLimit) {
            return res.status(400).json({
              success: false,
              error: errorMessage,
            });
          }
        }
      } catch (error) {
        console.error('Error validating franchise commission limit:', error);
        // Don't block lead creation if validation fails, but log the error
      }
    }

    const leadData = {
      ...req.body,
      agent: agentId || req.user._id,
      agentName: req.user.role === 'super_admin' ? req.user.name : agentName,
      associated,
      associatedModel,
      leadType: req.body.leadType || 'bank',
    };

    // Normalize bank field - use bankId if bank is not provided
    if (!leadData.bank && leadData.bankId) {
      leadData.bank = leadData.bankId;
    }
    // Remove bankId if bank is set (to avoid confusion)
    if (leadData.bank) {
      delete leadData.bankId;
    }
    // Cast bank to ObjectId if it's a valid string (so populate works correctly)
    if (leadData.bank && typeof leadData.bank === 'string' && mongoose.Types.ObjectId.isValid(leadData.bank)) {
      leadData.bank = new mongoose.Types.ObjectId(leadData.bank);
    }
    // Denormalize bank name directly on the lead for reliable display
    if (leadData.bank) {
      try {
        const bankDoc = await Bank.findById(leadData.bank).select('name');
        if (bankDoc) leadData.bankName = bankDoc.name;
      } catch (_) {}
    }

    // If client submitted a dynamic lead form payload, validate required fields/documents
    if (req.body.leadForm) {
      try {
        const LeadForm = (await import('../models/leadForm.model.js')).default;
        const form = await LeadForm.findById(req.body.leadForm);
        if (form) {
          // attach reference and leadType
          leadData.leadForm = form._id;
          leadData.leadType = form.leadType || 'bank';
          leadData.formValues = req.body.formValues || {};

          // Validate required fields presence
          const missingFields = [];
          (form.fields || []).forEach((f) => {
            if (f.required) {
              const val = leadData.formValues?.[f.key];
              if (val === undefined || val === null || val === '') missingFields.push(f.key);
            }
          });

          // Validate required documents
          const providedDocs = Array.isArray(req.body.documents) ? req.body.documents : [];
          const missingDocs = [];
          (form.documentTypes || []).forEach((dt) => {
            if (dt.required) {
              const found = providedDocs.find((d) => d.documentType === dt.key && d.url);
              if (!found) missingDocs.push(dt.key);
            }
          });

          if (missingFields.length > 0 || missingDocs.length > 0) {
            return res.status(400).json({
              success: false,
              error: 'Missing required form fields or documents',
              missingFields,
              missingDocs,
            });
          }

          // attach documents (ensure metadata)
          leadData.documents = providedDocs.map((d) => ({
            documentType: d.documentType,
            url: d.url,
            uploadedBy: req.user?._id,
            uploadedAt: new Date(),
          }));

          // Automatically promote standard fields from formValues to top-level if missing
          // Skip bank-specific promotions for new_lead
          const fieldsToPromote = form.leadType === 'new_lead'
            ? ['customerName', 'applicantEmail', 'applicantMobile']
            : [
                'customerName', 'loanType', 'loanAmount', 'applicantEmail', 'applicantMobile',
                'dsaCode', 'branch', 'loanAccountNo'
              ];

          // Map alternative keys to standard fields
          const alternativeKeys = {
            'loanAmount': ['amount', 'loan_amount', 'loan_amt', 'amount_requested'],
            'customerName': ['name', 'applicant_name', 'client_name', 'leadName', 'lead_name'],
            'applicantMobile': ['mobile', 'phone', 'contact'],
            'applicantEmail': ['email'],
            'loanAccountNo': ['account_no', 'loan_acc_no', 'lan']
          };

          fieldsToPromote.forEach(field => {
            // Only promote if current leadData field is empty/null
            if (!leadData[field] || leadData[field] === '') {
              // Try the direct key first
              if (leadData.formValues[field]) {
                leadData[field] = leadData.formValues[field];
              }
              // Then try alternative keys
              else if (alternativeKeys[field]) {
                for (const altKey of alternativeKeys[field]) {
                  if (leadData.formValues[altKey]) {
                    leadData[field] = leadData.formValues[altKey];
                    break;
                  }
                }
              }
            }
          });

          // Legacy handling for smBm/asm (separate because they might be objects/ids)
          // Skip for new_lead - no bank-related fields
          if (form.leadType !== 'new_lead') {
            const smBmFields = ['smBmName', 'smBmEmail', 'smBmMobile', 'asmName', 'asmEmail', 'asmMobile'];
            smBmFields.forEach(field => {
              if (!leadData[field] && leadData.formValues[field]) {
                leadData[field] = leadData.formValues[field];
              }
            });
          }
        }
      } catch (err) {
        console.warn('Lead form validation error:', err);
      }
    }

    // Validate agent and associated ID formats
    if (leadData.agent && !mongoose.Types.ObjectId.isValid(leadData.agent)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid partner ID format',
      });
    }
    if (leadData.associated && !mongoose.Types.ObjectId.isValid(leadData.associated)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid associated ID format',
      });
    }
    if (leadData.subAgent && !mongoose.Types.ObjectId.isValid(leadData.subAgent)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid sub-partner ID format',
      });
    }

    // Validate and set sub-agent name (for agents and hierarchy users)
    if (leadData.subAgent) {
      try {
        // For agents: validate subAgent belongs to them
        if (req.user.role === 'agent') {
          const subAgent = await User.findOne({ 
            _id: leadData.subAgent, 
            parentAgent: req.user._id, 
            role: 'agent' 
          });
          if (!subAgent) {
            return res.status(403).json({
              success: false,
              error: 'Sub-partner not found or does not belong to you',
            });
          }
          // Get sub-agent name
          leadData.subAgentName = subAgent.name;
        } else {
          // For hierarchy users: just fetch the subAgent name (no validation needed)
          const subAgent = await User.findById(leadData.subAgent).select('name');
          if (subAgent) {
            leadData.subAgentName = subAgent.name;
          } else {
            console.warn('Sub-agent not found for ID:', leadData.subAgent);
          }
        }
      } catch (err) {
        console.warn('Unable to validate/fetch sub-agent:', err);
        // Don't fail the request, just log the warning
        // The subAgent ID will still be saved, name might be missing
      }
    }

    console.log('🔍 DEBUG: Creating lead with agent:', leadData.agent);
    console.log('🔍 DEBUG: SubAgent data:', {
      subAgent: leadData.subAgent,
      subAgentName: leadData.subAgentName,
      subAgentFromBody: req.body.subAgent,
      userRole: req.user.role
    });

    // Ensure SM/BM exists (prefer BankManager for bank contacts; fallback to Staff)
    try {
      if (!leadData.smBm && (leadData.smBmEmail || leadData.smBmMobile || req.body.smBmName)) {
        let existing = null;

        // If bank provided, prefer BankManager collection (they don't need login)
        if (leadData.bank) {
          if (leadData.smBmEmail) {
            existing = await BankManager.findOne({ email: leadData.smBmEmail.toLowerCase(), bank: leadData.bank });
          }
          if (!existing && leadData.smBmMobile) {
            existing = await BankManager.findOne({ mobile: leadData.smBmMobile, bank: leadData.bank });
          }

          if (existing) {
            leadData.smBm = existing._id;
            leadData.smBmModel = 'BankManager';
          } else {
            // Create new BankManager for contact purposes
            const name = req.body.smBmName || (leadData.smBmEmail ? leadData.smBmEmail.split('@')[0].replace(/\./g, ' ') : 'SM/BM');
            const newBM = await BankManager.create({
              name,
              email: leadData.smBmEmail ? leadData.smBmEmail.toLowerCase() : undefined,
              mobile: leadData.smBmMobile || undefined,
              role: 'bm',
              bank: leadData.bank,
              status: 'active',
            });
            leadData.smBm = newBM._id;
            leadData.smBmModel = 'BankManager';
          }
        } else {
          // No bank specified -> fallback to creating Staff (login-able)
          if (leadData.smBmEmail) {
            existing = await Staff.findOne({ email: leadData.smBmEmail.toLowerCase() });
          }
          if (!existing && leadData.smBmMobile) {
            existing = await Staff.findOne({ mobile: leadData.smBmMobile });
          }

          if (existing) {
            leadData.smBm = existing._id;
            leadData.smBmModel = 'Staff';
          } else {
            const name = req.body.smBmName || (leadData.smBmEmail ? leadData.smBmEmail.split('@')[0].replace(/\./g, ' ') : 'SM/BM');
            const newStaff = await Staff.create({
              name,
              email: leadData.smBmEmail ? leadData.smBmEmail.toLowerCase() : undefined,
              mobile: leadData.smBmMobile || undefined,
              password: 'Default@123',
              role: 'staff',
              status: 'active',
            });
            leadData.smBm = newStaff._id;
            leadData.smBmModel = 'Staff';
          }
        }
      }
    } catch (err) {
      console.warn('Unable to ensure SM/BM exists:', err);
    }

    // Ensure ASM exists as a BankManager (contact) when bank provided and ASM details present
    try {
      if (leadData.bank && (leadData.asmEmail || leadData.asmMobile || req.body.asmName)) {
        let existingAsm = null;
        if (leadData.asmEmail) {
          existingAsm = await BankManager.findOne({ email: leadData.asmEmail.toLowerCase(), bank: leadData.bank });
        }
        if (!existingAsm && leadData.asmMobile) {
          existingAsm = await BankManager.findOne({ mobile: leadData.asmMobile, bank: leadData.bank });
        }
        if (!existingAsm) {
          const asmName = req.body.asmName || (leadData.asmEmail ? leadData.asmEmail.split('@')[0].replace(/\./g, ' ') : 'ASM');
          await BankManager.create({
            name: asmName,
            email: leadData.asmEmail ? leadData.asmEmail.toLowerCase() : undefined,
            mobile: leadData.asmMobile || undefined,
            role: 'asm',
            bank: leadData.bank,
            status: 'active',
          });
        }
      }
    } catch (err) {
      console.warn('Unable to ensure ASM BankManager exists:', err);
    }

    console.log('🔍 DEBUG: Lead data before creation:', {
      subAgent: leadData.subAgent,
      subAgentName: leadData.subAgentName,
      agent: leadData.agent,
      agentName: leadData.agentName
    });
    
    const lead = await Lead.create(leadData);
    
    console.log('🔍 DEBUG: Lead created:', {
      leadId: lead._id,
      subAgent: lead.subAgent,
      subAgentName: lead.subAgentName
    });

    const populatedLead = await Lead.findById(lead._id)
      .populate('agent', 'name email mobile')
      .populate('subAgent', 'name email mobile')
      .populate('associated', 'name email mobile')
      .populate('referralFranchise', 'name email mobile')
      .populate('bank', 'name type')
      .populate('smBm', 'name email mobile');

    // Track creation
    await LeadHistory.create({
      lead: lead._id,
      changedBy: req.user._id,
      action: 'created',
      changes: [],
      remarks: 'Lead created',
    });

    res.status(201).json({
      success: true,
      message: 'Lead created successfully',
      data: populatedLead,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Get All Leads
 */
export const getLeads = async (req, res, next) => {
  try {
    const { page = 1, limit = 10, status, verificationStatus, agentId, associatedId, associatedModel, franchiseId, bankId } = req.query;
    const skip = (page - 1) * limit;

    const query = {};

    // Role-based filtering: agent = own leads, franchise = own + agents' leads, super_admin = all, regional_manager = their franchises
    if (req.user.role === 'agent') {
      query.agent = req.user._id;
    } else if (req.user.role === 'franchise') {
      if (!req.user.franchiseOwned) {
        return res.status(400).json({
          success: false,
          message: 'Franchise owner does not have an associated franchise',
        });
      }
      // Franchise owners can only see leads for agents under their franchise (and leads where they are the agent)
      const agentIds = await User.find({ managedByModel: 'Franchise', managedBy: req.user.franchiseOwned }).distinct('_id');
      const allowedAgentIds = (agentIds || []).map(String);
      allowedAgentIds.push(req.user._id.toString());
      if (!allowedAgentIds.length) {
        return res.status(200).json({
          success: true,
          data: [],
          pagination: getPaginationMeta(page, limit, 0),
        });
      }
      query.agent = { $in: allowedAgentIds };
    } else if (req.user.role === 'regional_manager') {
      const franchiseIds = await getRegionalManagerFranchiseIds(req);
      if (franchiseIds === null || franchiseIds.length === 0) {
        return res.status(200).json({
          success: true,
          data: [],
          pagination: getPaginationMeta(page, limit, 0),
        });
      }
      // regional managers only manage franchises; restrict to leads associated with franchises in their scope
      query.associated = { $in: franchiseIds };
      query.associatedModel = 'Franchise';
    } else if (req.user.role === 'relationship_manager') {
      // Relationship managers should only see leads for agents associated with their RM profile
      const RM = await import('../models/relationship.model.js').then(m => m.default).catch(() => null);
      let rmId = req.user.relationshipManagerOwned;
      if (!rmId && RM) {
        const rmDoc = await RM.findOne({ owner: req.user._id }).select('_id');
        if (rmDoc) rmId = rmDoc._id;
      }
      if (!rmId) {
        return res.status(200).json({
          success: true,
          data: [],
          pagination: getPaginationMeta(page, limit, 0),
        });
      }
      // find agents managed by this RM
      const agentIds = await User.find({ managedByModel: 'RelationshipManager', managedBy: rmId }).distinct('_id');
      const allowedAgentIds = agentIds || [];
      // include leads where agent is the relationship manager user (if any)
      allowedAgentIds.push(req.user._id);
      query.agent = { $in: allowedAgentIds };
    }
    // super_admin: no base filter → all leads; optional filters below

    if (status) query.status = status;
    if (verificationStatus) query.verificationStatus = verificationStatus;
    if (bankId) query.bank = bankId;
    const canFilterScope = ['super_admin', 'relationship_manager'].includes(req.user.role);
    if (canFilterScope) {
      if (agentId) {
        // If relationship_manager, ensure requested agentId is within RM's scope
        if (req.user.role === 'relationship_manager') {
          const RM = await import('../models/relationship.model.js').then(m => m.default).catch(() => null);
          let rmId = req.user.relationshipManagerOwned;
          if (!rmId && RM) {
            const rmDoc = await RM.findOne({ owner: req.user._id }).select('_id');
            if (rmDoc) rmId = rmDoc._id;
          }
          const allowed = await User.exists({ _id: agentId, managedByModel: 'RelationshipManager', managedBy: rmId });
          if (!allowed) {
            return res.status(403).json({ success: false, error: 'Access denied.' });
          }
        }
        query.agent = agentId;
      }
      // Support new associatedId/associatedModel query params; fall back to legacy franchiseId if present
      if (associatedId) {
        query.associated = associatedId;
        if (associatedModel) query.associatedModel = associatedModel;
      } else if (franchiseId) {
        query.associated = franchiseId;
        query.associatedModel = 'Franchise';
      }
    }

    const leads = await Lead.find(query)
      .populate('agent', 'name email mobile')
      .populate('subAgent', 'name email mobile')
      .populate('associated', 'name email mobile')
      .populate('referralFranchise', 'name email mobile')
      .populate('bank', 'name type')
      .populate('verifiedBy', 'name email')
      .populate('smBm', 'name email mobile')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(parseInt(limit));

    const total = await Lead.countDocuments(query);
    const pagination = getPaginationMeta(page, limit, total);

    res.status(200).json({
      success: true,
      data: leads,
      pagination,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Get Lead By ID
 */
export const getLeadById = async (req, res, next) => {
  try {
    const lead = await Lead.findById(req.params.id)
      .populate('agent', 'name email mobile')
      .populate('subAgent', 'name email mobile')
      .populate('associated', 'name email mobile')
      .populate('referralFranchise', 'name email mobile')
      .populate('bank', 'name type')
      .populate('verifiedBy', 'name email')
      .populate('smBm', 'name email mobile');

    if (!lead) {
      return res.status(404).json({
        success: false,
        error: 'Lead not found',
      });
    }

    // Role-based access control
    if (req.user.role === 'agent' && lead.agent.toString() !== req.user._id.toString()) {
      return res.status(403).json({
        success: false,
        error: 'Access denied. You can only view your own leads.',
      });
    }

    if (req.user.role === 'franchise') {
      if (!req.user.franchiseOwned) {
        return res.status(400).json({
          success: false,
          message: 'Franchise owner does not have an associated franchise',
        });
      }
      // Franchise owners can view leads for agents under their franchise (and leads where they are the agent)
      const agentIds = await User.find({ managedByModel: 'Franchise', managedBy: req.user.franchiseOwned }).distinct('_id');
      const allowedAgentIds = (agentIds || []).map(String);
      allowedAgentIds.push(req.user._id.toString());
      if (!allowedAgentIds.includes(lead.agent.toString())) {
        return res.status(403).json({
          success: false,
          error: 'Access denied. You can only view leads associated with your franchise agents.',
        });
      }
    }
    if (req.user.role === 'regional_manager') {
      let canAccess = false;
      if (lead.associatedModel === 'Franchise') {
        canAccess = await regionalManagerCanAccessFranchise(req, lead.associated);
      } else if (lead.associatedModel === 'RelationshipManager') {
        canAccess = await regionalManagerCanAccessRelationshipManager(req, lead.associated);
      } else {
        // If no associated model, check if agent is under a franchise or RM
        const agentUser = await User.findById(lead.agent).select('managedBy managedByModel');
        if (agentUser?.managedByModel === 'Franchise') {
          canAccess = await regionalManagerCanAccessFranchise(req, agentUser.managedBy);
        } else if (agentUser?.managedByModel === 'RelationshipManager') {
          canAccess = await regionalManagerCanAccessRelationshipManager(req, agentUser.managedBy);
        }
      }
      if (!canAccess) {
        return res.status(403).json({
          success: false,
          error: 'Access denied. You can only view leads from your hierarchy.',
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
      // Get agents for this RM
      const agentIds = rmId ? await User.find({ managedByModel: 'RelationshipManager', managedBy: rmId }).distinct('_id') : [];
      const allowedAgentIds = agentIds || [];
      allowedAgentIds.push(req.user._id);
      if (!allowedAgentIds.map(String).includes(lead.agent.toString())) {
        return res.status(403).json({
          success: false,
          error: 'Access denied. You can only view leads associated with your agents.',
        });
      }
    }

    res.status(200).json({
      success: true,
      data: lead,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Update Lead
 */
export const updateLead = async (req, res, next) => {
  try {
    console.log('🔍 DEBUG: Update lead request:', {
      leadId: req.params.id,
      body: req.body,
      agent: req.body.agent,
      agentType: typeof req.body.agent
    });

    // Check access before updating
    const existingLead = await Lead.findById(req.params.id);
    if (!existingLead) {
      return res.status(404).json({
        success: false,
        error: 'Lead not found',
      });
    }

    // Role-based access control
    if (req.user.role === 'agent' && existingLead.agent.toString() !== req.user._id.toString()) {
      return res.status(403).json({
        success: false,
        error: 'Access denied. You can only update your own leads.',
      });
    }

    if (req.user.role === 'franchise') {
      if (!req.user.franchiseOwned) {
        return res.status(400).json({
          success: false,
          message: 'Franchise owner does not have an associated franchise',
        });
      }
      // Franchise owners can update leads for agents under their franchise (and leads where they are the agent)
      const agentIds = await User.find({ managedByModel: 'Franchise', managedBy: req.user.franchiseOwned }).distinct('_id');
      const allowedAgentIds = (agentIds || []).map(String);
      allowedAgentIds.push(req.user._id.toString());
      if (!allowedAgentIds.includes(existingLead.agent.toString())) {
        return res.status(403).json({
          success: false,
          error: 'Access denied. You can only update leads associated with your franchise agents.',
        });
      }
    }
    if (req.user.role === 'regional_manager') {
      let canAccess = false;
      if (existingLead.associatedModel === 'Franchise') {
        canAccess = await regionalManagerCanAccessFranchise(req, existingLead.associated);
      } else if (existingLead.associatedModel === 'RelationshipManager') {
        canAccess = await regionalManagerCanAccessRelationshipManager(req, existingLead.associated);
      } else {
        // If no associated model, check if agent is under a franchise or RM
        const agentUser = await User.findById(existingLead.agent).select('managedBy managedByModel');
        if (agentUser?.managedByModel === 'Franchise') {
          canAccess = await regionalManagerCanAccessFranchise(req, agentUser.managedBy);
        } else if (agentUser?.managedByModel === 'RelationshipManager') {
          canAccess = await regionalManagerCanAccessRelationshipManager(req, agentUser.managedBy);
        }
      }
      if (!canAccess) {
        return res.status(403).json({
          success: false,
          error: 'Access denied. You can only update leads from your hierarchy.',
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
      const agentIds = rmId ? await User.find({ managedByModel: 'RelationshipManager', managedBy: rmId }).distinct('_id') : [];
      const allowedAgentIds = agentIds || [];
      allowedAgentIds.push(req.user._id);
      if (!allowedAgentIds.map(String).includes(existingLead.agent.toString())) {
        return res.status(403).json({
          success: false,
          error: 'Access denied. You can only update leads associated with your agents.',
        });
      }
    }

    // Ensure agent ID is valid ObjectId format
    const updateData = { ...req.body };

    // Cast bank to ObjectId if it's a valid string (so populate works correctly)
    if (updateData.bank && typeof updateData.bank === 'string' && mongoose.Types.ObjectId.isValid(updateData.bank)) {
      updateData.bank = new mongoose.Types.ObjectId(updateData.bank);
    }
    if (!updateData.bank && updateData.bankId && typeof updateData.bankId === 'string' && mongoose.Types.ObjectId.isValid(updateData.bankId)) {
      updateData.bank = new mongoose.Types.ObjectId(updateData.bankId);
    }
    if (updateData.bankId) delete updateData.bankId;
    // Denormalize bank name directly on the lead for reliable display
    if (updateData.bank) {
      try {
        const bankDoc = await Bank.findById(updateData.bank).select('name');
        if (bankDoc) updateData.bankName = bankDoc.name;
      } catch (_) {}
    }

    // Only Relationship Manager, Accountant, and Franchise can set commission percentage and amount
    if (updateData.commissionPercentage !== undefined || updateData.commissionAmount !== undefined) {
      if (req.user.role !== 'relationship_manager' && req.user.role !== 'accountant' && req.user.role !== 'franchise' && req.user.role !== 'accounts_manager') {
        // Remove commission fields if user is not authorized
        delete updateData.commissionPercentage;
        delete updateData.commissionAmount;
        // Optionally return error instead of silently removing
        // return res.status(403).json({
        //   success: false,
        //   error: 'Access denied. Only Relationship Managers, Accountants, and Franchise can set commission.',
        // });
      } else if (req.user.role === 'relationship_manager') {
        // If RM is updating and lead is assigned to self, remove commission fields
        // (Franchise can set commission even when assigned to self)
        const finalAgentId = updateData.agent || existingLead.agent;
        if (finalAgentId && finalAgentId.toString() === req.user._id.toString()) {
          delete updateData.commissionPercentage;
          delete updateData.commissionAmount;
        }
      }
      // Note: Franchise users can set commission even when assigned to self (no restriction)
    }

    // Handle agent commission fields (for franchise-created leads)
    // Allow franchise, relationship_manager, accounts_manager, and accountant to update agent commission
    if (updateData.agentCommissionPercentage !== undefined || updateData.agentCommissionAmount !== undefined) {
      if (req.user.role !== 'franchise' && req.user.role !== 'relationship_manager' && req.user.role !== 'accounts_manager' && req.user.role !== 'accountant' && req.user.role !== 'super_admin') {
        // Remove agent commission fields if user is not authorized
        delete updateData.agentCommissionPercentage;
        delete updateData.agentCommissionAmount;
      }
    }

    // Promote fields from formValues if present (same logic as createLead)
    if (updateData.formValues) {
      const fieldsToPromote = [
        'customerName', 'loanType', 'loanAmount', 'applicantEmail', 'applicantMobile',
        'dsaCode', 'branch', 'loanAccountNo'
      ];
      const alternativeKeys = {
        'loanAmount': ['amount', 'loan_amount', 'loan_amt', 'amount_requested'],
        'customerName': ['name', 'applicant_name', 'client_name'],
        'loanAccountNo': ['account_no', 'loan_acc_no', 'lan']
      };

      fieldsToPromote.forEach(field => {
        if (!updateData[field] || updateData[field] === '') {
          if (updateData.formValues[field]) {
            updateData[field] = updateData.formValues[field];
          } else if (alternativeKeys[field]) {
            for (const altKey of alternativeKeys[field]) {
              if (updateData.formValues[altKey]) {
                updateData[field] = updateData.formValues[altKey];
                break;
              }
            }
          }
        }
      });
    }

    if (updateData.dsaCode !== undefined) {
      updateData.codeUse = updateData.dsaCode;
      delete updateData.dsaCode;
    }
    if (updateData.agent && !mongoose.Types.ObjectId.isValid(updateData.agent)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid partner ID format',
      });
    }

    const lead = await Lead.findByIdAndUpdate(req.params.id, updateData, {
      new: true,
      runValidators: true,
    })
      .populate('agent', 'name email mobile')
      .populate('subAgent', 'name email mobile')
      .populate('associated', 'name email mobile')
      .populate('referralFranchise', 'name email mobile')
      .populate('bank', 'name type')
      .populate('verifiedBy', 'name email')
      .populate('smBm', 'name email mobile');

    // Track changes - only check fields that were actually updated
    const fieldsToCheck = Object.keys(updateData);
    const changes = trackLeadChanges(existingLead.toObject(), lead.toObject(), fieldsToCheck);
    if (changes.length > 0) {
      await LeadHistory.create({
        lead: lead._id,
        changedBy: req.user._id,
        action: 'updated',
        changes,
        remarks: req.body.remarks || null,
      });
    }

    console.log('🔍 DEBUG: Updated lead:', {
      leadId: lead._id,
      agent: lead.agent,
      agentId: lead.agent?._id || lead.agent,
      agentName: lead.agent?.name,
      agentPopulated: !!lead.agent?.name
    });

    res.status(200).json({
      success: true,
      data: lead,
    });
  } catch (error) {
    console.error('🔍 DEBUG: Update lead error:', error);
    next(error);
  }
};

/**
 * Update Lead Status
 */
export const updateLeadStatus = async (req, res, next) => {
  try {
    const { status, sanctionedDate, disbursedAmount, disbursementType } = req.body;

    // Check access before updating
    const existingLead = await Lead.findById(req.params.id);
    if (!existingLead) {
      return res.status(404).json({
        success: false,
        error: 'Lead not found',
      });
    }

    // Role-based access control - agents can only mark leads as DISBURSED
    if (req.user.role === 'agent') {
      // Agents can only mark their own leads as DISBURSED
      if (existingLead.agent.toString() !== req.user._id.toString()) {
        return res.status(403).json({
          success: false,
          error: 'Access denied. You can only update your own leads.',
        });
      }
      // Agents can only set status to 'disbursed'
      if (status && status !== 'disbursed') {
        return res.status(403).json({
          success: false,
          error: 'Access denied. Partners can only mark leads as DISBURSED.',
        });
      }
      // If status is disbursed, allow it
      if (status === 'disbursed') {
        const updateData = { status: 'disbursed' };
        if (disbursedAmount !== undefined) {
          updateData.disbursedAmount = disbursedAmount;
          updateData.disbursementDate = new Date();
          if (disbursedAmount >= (existingLead.loanAmount || 0)) {
            updateData.disbursementType = 'full';
            updateData.status = 'completed';
          } else {
            updateData.disbursementType = 'partial';
          }
        } else {
          updateData.disbursementDate = new Date();
        }

        const lead = await Lead.findByIdAndUpdate(
          req.params.id,
          updateData,
          { new: true, runValidators: true }
        )
          .populate('agent', 'name email mobile')
          .populate('associated', 'name email mobile')
          .populate('referralFranchise', 'name email mobile')
          .populate('bank', 'name type')
          .populate('smBm', 'name email mobile');

        // Track changes
        const changes = trackLeadChanges(existingLead.toObject(), lead.toObject(), Object.keys(updateData));
        if (changes.length > 0) {
          await LeadHistory.create({
            lead: lead._id,
            changedBy: req.user._id,
            action: 'status_changed',
            changes,
            remarks: req.body.remarks || 'Lead marked as DISBURSED by agent',
          });
        }

        return res.status(200).json({
          success: true,
          message: 'Lead marked as DISBURSED',
          data: lead,
        });
      }
    }

    if (req.user.role === 'franchise') {
      if (!req.user.franchiseOwned) {
        return res.status(400).json({
          success: false,
          message: 'Franchise owner does not have an associated franchise',
        });
      }
      // Franchise owners can update leads for agents under their franchise (and leads where they are the agent)
      const agentIds = await User.find({ managedByModel: 'Franchise', managedBy: req.user.franchiseOwned }).distinct('_id');
      const allowedAgentIds = (agentIds || []).map(String);
      allowedAgentIds.push(req.user._id.toString());
      if (!allowedAgentIds.includes(existingLead.agent.toString())) {
        return res.status(403).json({
          success: false,
          error: 'Access denied. You can only update leads associated with your franchise agents.',
        });
      }
    }
    if (req.user.role === 'regional_manager') {
      let canAccess = false;
      if (existingLead.associatedModel === 'Franchise') {
        canAccess = await regionalManagerCanAccessFranchise(req, existingLead.associated);
      } else if (existingLead.associatedModel === 'RelationshipManager') {
        canAccess = await regionalManagerCanAccessRelationshipManager(req, existingLead.associated);
      } else {
        // If no associated model, check if agent is under a franchise or RM
        const agentUser = await User.findById(existingLead.agent).select('managedBy managedByModel');
        if (agentUser?.managedByModel === 'Franchise') {
          canAccess = await regionalManagerCanAccessFranchise(req, agentUser.managedBy);
        } else if (agentUser?.managedByModel === 'RelationshipManager') {
          canAccess = await regionalManagerCanAccessRelationshipManager(req, agentUser.managedBy);
        }
      }
      if (!canAccess) {
        return res.status(403).json({
          success: false,
          error: 'Access denied. You can only update leads from your hierarchy.',
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
      const agentIds = rmId ? await User.find({ managedByModel: 'RelationshipManager', managedBy: rmId }).distinct('_id') : [];
      const allowedAgentIds = agentIds || [];
      allowedAgentIds.push(req.user._id);
      if (!allowedAgentIds.map(String).includes(existingLead.agent.toString())) {
        return res.status(403).json({
          success: false,
          error: 'Access denied. You can only update leads associated with your agents.',
        });
      }
    }

    const updateData = { status };

    if (sanctionedDate !== undefined) {
      updateData.sanctionedDate = sanctionedDate || new Date();
    }

    if (disbursedAmount !== undefined) {
      const lead = await Lead.findById(req.params.id);
      const previousAmount = lead.disbursedAmount || 0;

      updateData.disbursedAmount = disbursedAmount;
      updateData.disbursementType = disbursementType || (disbursedAmount === lead.loanAmount ? 'full' : 'partial');

      // Add to disbursement history
      if (!lead.disbursementHistory) {
        lead.disbursementHistory = [];
      }
      lead.disbursementHistory.push({
        amount: disbursedAmount - previousAmount,
        date: new Date(),
        type: updateData.disbursementType,
      });
      updateData.disbursementHistory = lead.disbursementHistory;

      // If fully disbursed, mark as completed
      if (disbursedAmount >= (lead.loanAmount || 0)) {
        updateData.status = 'completed';
        updateData.disbursementType = 'full';

        // Auto-generate invoice when completed
        try {
          await commissionService.recalculateCommission(req.params.id);
          await invoiceService.generateInvoice(req.params.id);
        } catch (error) {
          console.error('Error auto-generating invoice:', error);
        }
      }

      // Recalculate commission if basis is disbursed
      if (lead.commissionBasis === 'disbursed') {
        await commissionService.recalculateCommission(req.params.id);
      }
    }

    const lead = await Lead.findByIdAndUpdate(
      req.params.id,
      updateData,
      { new: true, runValidators: true }
    )
      .populate('agent', 'name email mobile')
      .populate('associated', 'name email mobile')
      .populate('referralFranchise', 'name email mobile')
      .populate('bank', 'name type')
      .populate('smBm', 'name email mobile');

    if (!lead) {
      return res.status(404).json({
        success: false,
        error: 'Lead not found',
      });
    }

    // Track changes - only check fields that were actually updated
    const fieldsToCheck = Object.keys(updateData);
    const changes = trackLeadChanges(existingLead.toObject(), lead.toObject(), fieldsToCheck);
    if (changes.length > 0) {
      await LeadHistory.create({
        lead: lead._id,
        changedBy: req.user._id,
        action: 'status_changed',
        changes,
        remarks: req.body.remarks || null,
      });
    }

    res.status(200).json({
      success: true,
      message: 'Lead status updated',
      data: lead,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Verify Lead (Staff/Franchise Owner)
 */
export const verifyLead = async (req, res, next) => {
  try {
    const { verificationStatus, remarks, commissionPercentage } = req.body;

    if (!verificationStatus || !['verified', 'rejected'].includes(verificationStatus)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid verification status',
      });
    }

    // Check access before verifying
    const existingLead = await Lead.findById(req.params.id);
    if (!existingLead) {
      return res.status(404).json({
        success: false,
        message: 'Lead not found',
      });
    }

    if (req.user.role === 'franchise') {
      if (!req.user.franchiseOwned) {
        return res.status(400).json({
          success: false,
          message: 'Franchise owner does not have an associated franchise',
        });
      }
      // Franchise owners can verify leads for agents under their franchise (and leads where they are the agent)
      const agentIds = await User.find({ managedByModel: 'Franchise', managedBy: req.user.franchiseOwned }).distinct('_id');
      const allowedAgentIds = (agentIds || []).map(String);
      allowedAgentIds.push(req.user._id.toString());
      if (!allowedAgentIds.includes(existingLead.agent.toString())) {
        return res.status(403).json({
          success: false,
          error: 'Access denied. You can only verify leads associated with your franchise agents.',
        });
      }
    }
    if (req.user.role === 'regional_manager') {
      let canAccess = false;
      if (existingLead.associatedModel === 'Franchise') {
        canAccess = await regionalManagerCanAccessFranchise(req, existingLead.associated);
      } else if (existingLead.associatedModel === 'RelationshipManager') {
        canAccess = await regionalManagerCanAccessRelationshipManager(req, existingLead.associated);
      } else {
        // If no associated model, check if agent is under a franchise or RM
        const agentUser = await User.findById(existingLead.agent).select('managedBy managedByModel');
        if (agentUser?.managedByModel === 'Franchise') {
          canAccess = await regionalManagerCanAccessFranchise(req, agentUser.managedBy);
        } else if (agentUser?.managedByModel === 'RelationshipManager') {
          canAccess = await regionalManagerCanAccessRelationshipManager(req, agentUser.managedBy);
        }
      }
      if (!canAccess) {
        return res.status(403).json({
          success: false,
          error: 'Access denied. You can only verify leads from your hierarchy.',
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
      const agentIds = rmId ? await User.find({ managedByModel: 'RelationshipManager', managedBy: rmId }).distinct('_id') : [];
      const allowedAgentIds = agentIds || [];
      allowedAgentIds.push(req.user._id);
      if (!allowedAgentIds.map(String).includes(existingLead.agent.toString())) {
        return res.status(403).json({
          success: false,
          error: 'Access denied. You can only verify leads associated with your agents.',
        });
      }
    }

    const updateData = {
      verificationStatus,
      verifiedBy: req.user._id,
      verifiedAt: new Date(),
      remarks,
    };

    // Only Relationship Manager, Accountant, and Franchise can set commission percentage
    if (commissionPercentage !== undefined) {
      if (req.user.role !== 'relationship_manager' && req.user.role !== 'accountant' && req.user.role !== 'franchise') {
        return res.status(403).json({
          success: false,
          error: 'Access denied. Only Relationship Managers, Accountants, and Franchise can set commission percentage.',
        });
      }
      updateData.commissionPercentage = commissionPercentage;
    }

    const lead = await Lead.findByIdAndUpdate(
      req.params.id,
      updateData,
      { new: true, runValidators: true }
    )
      .populate('agent', 'name email mobile')
      .populate('associated', 'name email mobile')
      .populate('referralFranchise', 'name email mobile')
      .populate('bank', 'name type')
      .populate('smBm', 'name email mobile');

    // Track changes - only check fields that were actually updated
    const fieldsToCheck = Object.keys(updateData);
    const changes = trackLeadChanges(existingLead.toObject(), lead.toObject(), fieldsToCheck);
    if (changes.length > 0) {
      await LeadHistory.create({
        lead: lead._id,
        changedBy: req.user._id,
        action: 'verified',
        changes,
        remarks: remarks || null,
      });
    }

    // If verified, calculate commission
    if (verificationStatus === 'verified') {
      try {
        await commissionService.calculateCommission(req.params.id);
      } catch (error) {
        console.error('Error calculating commission:', error);
      }
    }

    res.status(200).json({
      success: true,
      message: 'Lead verified successfully',
      data: lead,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Get documents for a lead
 */
export const getLeadDocuments = async (req, res, next) => {
  try {
    const fileUploadService = (await import('../services/fileUpload.service.js')).default;
    const documents = await fileUploadService.getDocuments('lead', req.params.id);

    res.status(200).json({
      success: true,
      data: documents,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Upload document for a lead
 */
export const uploadLeadDocument = async (req, res, next) => {
  try {
    const fileUploadService = (await import('../services/fileUpload.service.js')).default;
    const upload = fileUploadService.getUploadMiddleware('file');

    upload(req, res, async (err) => {
      if (err) {
        return res.status(400).json({
          success: false,
          message: err.message,
        });
      }

      if (!req.file) {
        return res.status(400).json({
          success: false,
          message: 'No file uploaded',
        });
      }

      const { documentType, description } = req.body;

      if (!documentType) {
        return res.status(400).json({
          success: false,
          message: 'Document type is required',
        });
      }

      const document = await fileUploadService.saveDocument({
        entityType: 'lead',
        entityId: req.params.id,
        documentType,
        fileName: req.file.filename,
        originalFileName: req.file.originalname,
        filePath: req.file.path,
        fileSize: req.file.size,
        mimeType: req.file.mimetype,
        uploadedBy: req.user._id,
        description,
      });

      res.status(201).json({
        success: true,
        message: 'Document uploaded successfully',
        data: document,
      });
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Delete Lead
 */
export const deleteLead = async (req, res, next) => {
  try {
    const lead = await Lead.findById(req.params.id);
    if (!lead) {
      return res.status(404).json({
        success: false,
        message: 'Lead not found',
      });
    }
    if (req.user.role === 'regional_manager') {
      let canAccess = false;
      if (lead.associatedModel === 'Franchise') {
        canAccess = await regionalManagerCanAccessFranchise(req, lead.associated);
      } else if (lead.associatedModel === 'RelationshipManager') {
        canAccess = await regionalManagerCanAccessRelationshipManager(req, lead.associated);
      } else {
        // If no associated model, check if agent is under a franchise or RM
        const agentUser = await User.findById(lead.agent).select('managedBy managedByModel');
        if (agentUser?.managedByModel === 'Franchise') {
          canAccess = await regionalManagerCanAccessFranchise(req, agentUser.managedBy);
        } else if (agentUser?.managedByModel === 'RelationshipManager') {
          canAccess = await regionalManagerCanAccessRelationshipManager(req, agentUser.managedBy);
        }
      }
      if (!canAccess) {
        return res.status(403).json({
          success: false,
          error: 'Access denied. You can only delete leads from your hierarchy.',
        });
      }
    }
    if (req.user.role === 'franchise') {
      if (!req.user.franchiseOwned) {
        return res.status(400).json({
          success: false,
          message: 'Franchise owner does not have an associated franchise',
        });
      }
      const agentIds = await User.find({ managedByModel: 'Franchise', managedBy: req.user.franchiseOwned }).distinct('_id');
      const allowedAgentIds = (agentIds || []).map(String);
      allowedAgentIds.push(req.user._id.toString());
      if (!allowedAgentIds.includes(lead.agent.toString())) {
        return res.status(403).json({
          success: false,
          error: 'Access denied. You can only delete leads associated with your franchise agents.',
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
      const agentIds = rmId ? await User.find({ managedByModel: 'RelationshipManager', managedBy: rmId }).distinct('_id') : [];
      const allowedAgentIds = agentIds || [];
      allowedAgentIds.push(req.user._id);
      if (!allowedAgentIds.map(String).includes(lead.agent.toString())) {
        return res.status(403).json({
          success: false,
          error: 'Access denied. You can only delete leads associated with your agents.',
        });
      }
    }
    if (req.user.role === 'accounts_manager') {
      // Accountant can only delete leads under assigned Regional Managers
      const { getAccountantAccessibleAgentIds } = await import('../utils/accountantScope.js');
      const accessibleAgentIds = await getAccountantAccessibleAgentIds(req);
      if (accessibleAgentIds.length === 0 || !accessibleAgentIds.includes(lead.agent.toString())) {
        return res.status(403).json({
          success: false,
          error: 'Access denied. You can only delete leads under your assigned Regional Managers.',
        });
      }
    }
    
    // Log deletion to audit log
    const leadData = lead.toObject();
    await auditService.logDelete(req.user._id, 'Lead', req.params.id, leadData, req);
    
    await Lead.findByIdAndDelete(req.params.id);

    res.status(200).json({
      success: true,
      message: 'Lead deleted successfully',
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Get Lead Version History
 */
export const getLeadHistory = async (req, res, next) => {
  try {
    const { page = 1, limit = 20 } = req.query;
    const skip = (page - 1) * limit;

    // Check if lead exists
    const lead = await Lead.findById(req.params.id);
    if (!lead) {
      return res.status(404).json({
        success: false,
        error: 'Lead not found',
      });
    }

    // Role-based access control
    if (req.user.role === 'agent' && lead.agent.toString() !== req.user._id.toString()) {
      return res.status(403).json({
        success: false,
        error: 'Access denied. You can only view history of your own leads.',
      });
    }

    if (req.user.role === 'franchise') {
      if (!req.user.franchiseOwned) {
        return res.status(400).json({
          success: false,
          message: 'Franchise owner does not have an associated franchise',
        });
      }
      const agentIds = await User.find({ managedByModel: 'Franchise', managedBy: req.user.franchiseOwned }).distinct('_id');
      const allowedAgentIds = (agentIds || []).map(String);
      allowedAgentIds.push(req.user._id.toString());
      if (!allowedAgentIds.includes(lead.agent.toString())) {
        return res.status(403).json({
          success: false,
          error: 'Access denied. You can only view history of leads associated with your franchise agents.',
        });
      }
    }
    if (req.user.role === 'regional_manager') {
      let canAccess = false;
      if (lead.associatedModel === 'Franchise') {
        canAccess = await regionalManagerCanAccessFranchise(req, lead.associated);
      } else if (lead.associatedModel === 'RelationshipManager') {
        canAccess = await regionalManagerCanAccessRelationshipManager(req, lead.associated);
      } else {
        // If no associated model, check if agent is under a franchise or RM
        const agentUser = await User.findById(lead.agent).select('managedBy managedByModel');
        if (agentUser?.managedByModel === 'Franchise') {
          canAccess = await regionalManagerCanAccessFranchise(req, agentUser.managedBy);
        } else if (agentUser?.managedByModel === 'RelationshipManager') {
          canAccess = await regionalManagerCanAccessRelationshipManager(req, agentUser.managedBy);
        }
      }
      if (!canAccess) {
        return res.status(403).json({
          success: false,
          error: 'Access denied. You can only view history of leads from your hierarchy.',
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
      const agentIds = rmId ? await User.find({ managedByModel: 'RelationshipManager', managedBy: rmId }).distinct('_id') : [];
      const allowedAgentIds = agentIds || [];
      allowedAgentIds.push(req.user._id);
      if (!allowedAgentIds.map(String).includes(lead.agent.toString())) {
        return res.status(403).json({
          success: false,
          error: 'Access denied. You can only view history of leads associated with your agents.',
        });
      }
    }

    if (req.user.role === 'agent' && lead.agent.toString() !== req.user._id.toString()) {
      return res.status(403).json({
        success: false,
        error: 'Access denied. You can only view history of your own leads.',
      });
    }

    const history = await LeadHistory.find({ lead: req.params.id })
      .populate('changedBy', 'name email role')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(parseInt(limit));

    const total = await LeadHistory.countDocuments({ lead: req.params.id });
    const pagination = getPaginationMeta(page, limit, total);

    res.status(200).json({
      success: true,
      data: history,
      pagination,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Get Approved Leads (for Accountant)
 * Leads that are sanctioned or partially disbursed
 */
export const getApprovedLeads = async (req, res, next) => {
  try {
    const { page = 1, limit = 50, searchTerm } = req.query;
    const skip = (page - 1) * limit;

    // Filter for approved leads
    const query = {
      status: { $in: ['sanctioned', 'partial_disbursed'] }
    };

    if (searchTerm) {
      query.$or = [
        { customerName: { $regex: searchTerm, $options: 'i' } },
        { loanAccountNo: { $regex: searchTerm, $options: 'i' } },
        { applicantMobile: { $regex: searchTerm, $options: 'i' } }
      ];
    }

    const leads = await Lead.find(query)
      .populate('agent', 'name email mobile')
      .populate('associated', 'name email mobile')
      .populate('referralFranchise', 'name email mobile')
      .populate('bank', 'name type')
      .populate('smBm', 'name email mobile')
      .sort({ updatedAt: -1 })
      .skip(skip)
      .limit(parseInt(limit));

    const total = await Lead.countDocuments(query);
    const pagination = getPaginationMeta(page, limit, total);

    res.status(200).json({
      success: true,
      data: leads,
      pagination,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Forward Lead to Relationship Manager
 * Allows Franchise users to forward a lead to a Relationship Manager
 */
export const forwardLeadToRM = async (req, res, next) => {
  try {
    const { relationshipManagerId, remarks } = req.body;

    if (!relationshipManagerId) {
      return res.status(400).json({
        success: false,
        error: 'Relationship Manager ID is required',
      });
    }

    // Check access - only Franchise users can forward leads
    if (req.user.role !== 'franchise') {
      return res.status(403).json({
        success: false,
        error: 'Access denied. Only Franchise users can forward leads to Relationship Managers.',
      });
    }

    // Check if franchise has an associated franchise
    if (!req.user.franchiseOwned) {
      return res.status(400).json({
        success: false,
        message: 'Franchise owner does not have an associated franchise',
      });
    }

    // Check if lead exists
    const existingLead = await Lead.findById(req.params.id);
    if (!existingLead) {
      return res.status(404).json({
        success: false,
        error: 'Lead not found',
      });
    }

    // Verify franchise can access this lead (must be from their agents)
    const agentIds = await User.find({ managedByModel: 'Franchise', managedBy: req.user.franchiseOwned }).distinct('_id');
    const allowedAgentIds = (agentIds || []).map(String);
    allowedAgentIds.push(req.user._id.toString());
    if (!allowedAgentIds.includes(existingLead.agent.toString())) {
      return res.status(403).json({
        success: false,
        error: 'Access denied. You can only forward leads associated with your franchise agents.',
      });
    }

    // Verify Relationship Manager exists and belongs to the same Regional Manager
    const RM = await import('../models/relationship.model.js').then(m => m.default).catch(() => null);
    if (!RM) {
      return res.status(500).json({
        success: false,
        error: 'Relationship Manager model not available',
      });
    }

    const relationshipManager = await RM.findById(relationshipManagerId);
    if (!relationshipManager) {
      return res.status(404).json({
        success: false,
        error: 'Relationship Manager not found',
      });
    }

    // Verify both Franchise and Relationship Manager are under the same Regional Manager
    const Franchise = await import('../models/franchise.model.js').then(m => m.default).catch(() => null);
    if (!Franchise) {
      return res.status(500).json({
        success: false,
        error: 'Franchise model not available',
      });
    }

    const franchise = await Franchise.findById(req.user.franchiseOwned);
    if (!franchise) {
      return res.status(404).json({
        success: false,
        error: 'Franchise not found',
      });
    }

    // Both should have the same regional manager
    if (franchise.regionalManager?.toString() !== relationshipManager.regionalManager?.toString()) {
      return res.status(403).json({
        success: false,
        error: 'Access denied. Franchise and Relationship Manager must be under the same Regional Manager.',
      });
    }

    // Update lead to be associated with the Relationship Manager
    const updateData = {
      associated: relationshipManagerId,
      associatedModel: 'RelationshipManager',
    };

    const lead = await Lead.findByIdAndUpdate(
      req.params.id,
      updateData,
      { new: true, runValidators: true }
    )
      .populate('agent', 'name email mobile')
      .populate('associated', 'name email mobile')
      .populate('referralFranchise', 'name email mobile')
      .populate('bank', 'name type')
      .populate('smBm', 'name email mobile');

    // Track the forwarding action
    const changes = trackLeadChanges(existingLead.toObject(), lead.toObject(), ['associated', 'associatedModel']);
    await LeadHistory.create({
      lead: lead._id,
      changedBy: req.user._id,
      action: 'forwarded_to_rm',
      changes,
      remarks: remarks || `Lead forwarded to Relationship Manager: ${relationshipManager.name}`,
    });

    res.status(200).json({
      success: true,
      message: 'Lead forwarded to Relationship Manager successfully',
      data: lead,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Add Disbursement Tranche
 * Used by Accountants to log a disbursement event
 */
export const addDisbursement = async (req, res, next) => {
  try {
    // Only Relationship Manager and Accountant can add disbursements with commission
    if (req.user.role !== 'relationship_manager' && req.user.role !== 'accountant') {
      return res.status(403).json({
        success: false,
        error: 'Access denied. Only Relationship Managers and Accountants can add disbursements with commission.',
      });
    }

    const { amount, date, utr, bankRef, commission, gst, notes } = req.body;
    const leadId = req.params.id;

    const lead = await Lead.findById(leadId);
    if (!lead) {
      return res.status(404).json({ success: false, message: 'Lead not found' });
    }

    const trancheAmount = parseFloat(amount);
    const trancheCommission = parseFloat(commission) || 0;
    const trancheGst = parseFloat(gst) || 0;
    const netCommission = trancheCommission - trancheGst;

    // Update total disbursed and commission
    lead.disbursedAmount = (lead.disbursedAmount || 0) + trancheAmount;
    lead.commissionAmount = (lead.commissionAmount || 0) + trancheCommission;

    // Update status
    if (lead.disbursedAmount >= (lead.loanAmount || 0)) {
      lead.status = 'completed';
    } else {
      lead.status = 'partial_disbursed';
    }

    // Add to history
    if (!lead.disbursementHistory) lead.disbursementHistory = [];

    lead.disbursementHistory.push({
      amount: trancheAmount,
      date: date || new Date(),
      type: lead.status === 'completed' ? 'full' : 'partial',
      utr,
      bankRef,
      commission: trancheCommission,
      gst: trancheGst,
      netCommission,
      remarks: notes
    });

    await lead.save();

    // Log the action in LeadHistory
    await LeadHistory.create({
      lead: lead._id,
      changedBy: req.user._id,
      action: 'disbursement_added',
      changes: [{
        field: 'disbursedAmount',
        oldValue: lead.disbursedAmount - trancheAmount,
        newValue: lead.disbursedAmount
      }],
      remarks: `Disbursement of ₹${trancheAmount} added. UTR: ${utr || 'N/A'}`
    });

    res.status(200).json({
      success: true,
      message: 'Disbursement added successfully',
      data: lead
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Get Disbursement Confirmation Email Preview
 * Returns email data with auto-filled fields and hierarchy-based CC list
 */
export const getDisbursementEmailPreview = async (req, res, next) => {
  try {
    const leadId = req.params.id;
    
    // Check access - agents cannot access, all other roles can
    if (req.user.role === 'agent') {
      return res.status(403).json({
        success: false,
        error: 'Access denied. Partners cannot access this feature.',
      });
    }

    // Get lead with all populated data
    const lead = await Lead.findById(leadId)
      .populate('agent', 'name email mobile')
      .populate('associated', 'name email mobile')
      .populate('referralFranchise', 'name email mobile')
      .populate('bank', 'name contactEmail')
      .populate('smBm', 'name email mobile');

    if (!lead) {
      return res.status(404).json({
        success: false,
        error: 'Lead not found',
      });
    }

    // Check if lead status is disbursed
    if (lead.status !== 'disbursed') {
      return res.status(400).json({
        success: false,
        error: 'Lead status must be "disbursed" to send disbursement confirmation email',
      });
    }

    // Get SM/BM email (TO field) — prefer populated ref, fall back to denormalised field
    const smBmEmail = lead.smBm?.email || lead.smBmEmail || '';
    if (!smBmEmail) {
      return res.status(400).json({
        success: false,
        error: 'SM/BM email not found. Please ensure the SM/BM assigned to this lead has an email.',
      });
    }

    // Get FROM email from system settings
    const envConfig = await import('../config/env.js');
    const fromEmail = envConfig.SMTP_FROM || envConfig.SMTP_USER || '';

    // Build CC list based on hierarchy
    const ccEmails = [];
    const emailSet = new Set(); // To avoid duplicates

    // 1. Agent (Lead Creator)
    if (lead.agent?.email) {
      emailSet.add(lead.agent.email);
      ccEmails.push({ email: lead.agent.email, role: 'Agent', name: lead.agent.name });
    }

    // 2. Relationship Manager
    let relationshipManager = null;
    if (lead.agent?.managedByModel === 'RelationshipManager') {
      relationshipManager = await RelationshipManager.findById(lead.agent.managedBy)
        .populate('owner', 'name email');
      if (relationshipManager?.email) {
        emailSet.add(relationshipManager.email);
        ccEmails.push({ email: relationshipManager.email, role: 'Relationship Manager', name: relationshipManager.name });
      }
    }

    // 3. Regional Manager
    let regionalManager = null;
    if (lead.associatedModel === 'Franchise') {
      const franchise = await Franchise.findById(lead.associated)
        .populate('regionalManager', 'name email');
      if (franchise?.regionalManager?.email) {
        regionalManager = franchise.regionalManager;
        emailSet.add(regionalManager.email);
        ccEmails.push({ email: regionalManager.email, role: 'Regional Manager', name: regionalManager.name });
      }
    } else if (relationshipManager?.regionalManager) {
      regionalManager = await User.findById(relationshipManager.regionalManager).select('name email');
      if (regionalManager?.email) {
        emailSet.add(regionalManager.email);
        ccEmails.push({ email: regionalManager.email, role: 'Regional Manager', name: regionalManager.name });
      }
    }

    // 4. Franchise
    if (lead.associatedModel === 'Franchise' && lead.associated?.email) {
      emailSet.add(lead.associated.email);
      ccEmails.push({ email: lead.associated.email, role: 'Franchise', name: lead.associated.name });
    }

    // 5. Accountant (Assigned under Regional Manager)
    if (regionalManager?._id) {
      const accountants = await User.find({ 
        role: 'accounts_manager',
        status: 'active'
      }).select('name email');
      
      // For now, include all active accountants. In future, can filter by regional manager assignment
      accountants.forEach(acc => {
        if (acc.email && !emailSet.has(acc.email)) {
          emailSet.add(acc.email);
          ccEmails.push({ email: acc.email, role: 'Accountant', name: acc.name });
        }
      });
    }

    // 6. ASM (if assigned)
    if (lead.asmEmail) {
      emailSet.add(lead.asmEmail);
      ccEmails.push({ email: lead.asmEmail, role: 'ASM', name: lead.asmName || 'ASM' });
    }

    // Get current user info for email signature
    const currentUser = req.user;
    const currentUserMobile = currentUser.mobile || '';

    // Format current date & time (DD/MM/YYYY HH:MM AM/PM)
    const now = new Date();
    const day = String(now.getDate()).padStart(2, '0');
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const year = now.getFullYear();
    let hours = now.getHours();
    const minutes = String(now.getMinutes()).padStart(2, '0');
    const ampm = hours >= 12 ? 'PM' : 'AM';
    hours = hours % 12;
    hours = hours ? hours : 12; // the hour '0' should be '12'
    const formattedDate = `${day}/${month}/${year} ${String(hours).padStart(2, '0')}:${minutes} ${ampm}`;

    // Generate loan details table HTML
    const formatValue = (value) => {
      if (value === null || value === undefined || value === '') return '-';
      if (typeof value === 'number') {
        if (value === 0) return '-';
        return `₹${value.toLocaleString('en-IN')}`;
      }
      return String(value);
    };

    const formatDate = (date) => {
      if (!date) return '-';
      const d = new Date(date);
      const day = String(d.getDate()).padStart(2, '0');
      const month = String(d.getMonth() + 1).padStart(2, '0');
      const year = d.getFullYear();
      return `${day}/${month}/${year}`;
    };

    // Format disbursed amount with Sanction and Disbursements breakdown
    const sanctionAmount = formatValue(lead.loanAmount);
    const disbursedAmount = formatValue(lead.disbursedAmount);
    const disbursedAmountDisplay = sanctionAmount !== '-' && disbursedAmount !== '-' 
      ? `Sanction - ${sanctionAmount}<br>Disbursements - ${disbursedAmount}`
      : formatValue(lead.disbursedAmount);

    const loanDetailsTable = `
      <table border="1" cellpadding="8" cellspacing="0" style="border-collapse: collapse; width: 70%; font-family: Arial, sans-serif; border: 2px solid #000;">
        <tr style="background-color: #d32f2f; color: #ffffff;">
          <td style="font-weight: bold; text-align: center; padding: 10px; border: 1px solid #000; width: 40%;">Descriptions</td>
          <td style="font-weight: bold; text-align: center; padding: 10px; border: 1px solid #000; width: 60%;">Status</td>
        </tr>
        <tr>
          <td style="padding: 8px; border: 1px solid #000; width: 40%;">Customer Name</td>
          <td style="padding: 8px; border: 1px solid #000; width: 60%;">${formatValue(lead.customerName)}</td>
        </tr>
        <tr>
          <td style="padding: 8px; border: 1px solid #000; width: 40%;">Firm/Company/Entity Name</td>
          <td style="padding: 8px; border: 1px solid #000; width: 60%; background-color: #fff9c4;">${formatValue(lead.formValues?.firmName || lead.formValues?.companyName || lead.formValues?.entityName || '-')}</td>
        </tr>
        <tr>
          <td style="padding: 8px; border: 1px solid #000; width: 40%;">NBFC/Bank Name</td>
          <td style="padding: 8px; border: 1px solid #000; width: 60%; background-color: #fff9c4;">${formatValue(lead.bank?.name)}</td>
        </tr>
        <tr>
          <td style="padding: 8px; border: 1px solid #000; width: 40%;">Loan Type</td>
          <td style="padding: 8px; border: 1px solid #000; width: 60%;">${formatValue(lead.loanType?.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase()) || '-')}</td>
        </tr>
        <tr>
          <td style="padding: 8px; border: 1px solid #000; width: 40%;">Sanctioned Amount</td>
          <td style="padding: 8px; border: 1px solid #000; width: 60%;">${formatValue(lead.loanAmount)}</td>
        </tr>
        <tr>
          <td style="padding: 8px; border: 1px solid #000; width: 40%;">Disbursed Amount</td>
          <td style="padding: 8px; border: 1px solid #000; width: 60%;">${disbursedAmountDisplay}</td>
        </tr>
        <tr>
          <td style="padding: 8px; border: 1px solid #000; width: 40%;">Insurance Amount (If Any)</td>
          <td style="padding: 8px; border: 1px solid #000; width: 60%; background-color: #fff9c4;">${formatValue(lead.formValues?.insurance || lead.formValues?.insuranceAmount || '-')}</td>
        </tr>
        <tr>
          <td style="padding: 8px; border: 1px solid #000; width: 40%;">Application Number</td>
          <td style="padding: 8px; border: 1px solid #000; width: 60%;">${formatValue(lead.caseNumber || lead.formValues?.applicationNumber || '-')}</td>
        </tr>
        <tr>
          <td style="padding: 8px; border: 1px solid #000; width: 40%;">LAN Number</td>
          <td style="padding: 8px; border: 1px solid #000; width: 60%;">${formatValue(lead.loanAccountNo || lead.formValues?.lanNumber || '-')}</td>
        </tr>
        <tr>
          <td style="padding: 8px; border: 1px solid #000; width: 40%;">ROI%</td>
          <td style="padding: 8px; border: 1px solid #000; width: 60%;">${formatValue(lead.formValues?.roi || lead.formValues?.rateOfInterest || lead.formValues?.roiPercent || '-')}</td>
        </tr>
        <tr>
          <td style="padding: 8px; border: 1px solid #000; width: 40%;">PF%</td>
          <td style="padding: 8px; border: 1px solid #000; width: 60%;">${formatValue(lead.formValues?.pf || lead.formValues?.processingFee || lead.formValues?.pfPercent || '-')}</td>
        </tr>
        <tr>
          <td style="padding: 8px; border: 1px solid #000; width: 40%;">OTC/PDD Clearance (Cleared/Pending)</td>
          <td style="padding: 8px; border: 1px solid #000; width: 60%;">${formatValue(lead.formValues?.otc || lead.formValues?.pdd || lead.formValues?.otcPddClearance || '-')}</td>
        </tr>
        <tr>
          <td style="padding: 8px; border: 1px solid #000; width: 40%;">Cheque Handover Status (Yes/No)</td>
          <td style="padding: 8px; border: 1px solid #000; width: 60%; background-color: #fff9c4;">${formatValue(lead.formValues?.chequeHandover || lead.formValues?.chequeHandoverStatus || '-')}</td>
        </tr>
        <tr>
          <td style="padding: 8px; border: 1px solid #000; width: 40%;">Code Confirmation (code / Name)</td>
          <td style="padding: 8px; border: 1px solid #000; width: 60%;">${formatValue(lead.dsaCode || lead.codeUse || lead.formValues?.codeConfirmation || '-')}</td>
        </tr>
        <tr>
          <td style="padding: 8px; border: 1px solid #000; width: 40%;">Subvention (If Any)</td>
          <td style="padding: 8px; border: 1px solid #000; width: 60%; background-color: #fff9c4;">${formatValue(lead.formValues?.subvention || '-')}</td>
        </tr>
        <tr>
          <td style="padding: 8px; border: 1px solid #000; width: 40%;">Disbursement Date</td>
          <td style="padding: 8px; border: 1px solid #000; width: 60%;">${formatDate(lead.disbursementDate)}</td>
        </tr>
        <tr>
          <td style="padding: 8px; border: 1px solid #000; width: 40%;">Reporting Manager Name & Mobile Number</td>
          <td style="padding: 8px; border: 1px solid #000; width: 60%;">${formatValue(currentUser.name)} ${formatValue(currentUserMobile)}</td>
        </tr>
      </table>
    `;

    // Email subject
    const subject = `Disbursement Confirmation:- ${formatValue(lead.customerName)}`;

    // Email body
    const emailBody = `
      <html>
        <body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333;">
          <p>Dear Sir/Madam,</p>
          <p>Kindly Provide Disbursement Confirmation in below mentioned format & ( attaché - Sanction Letter/SOA/Appraisal Letter if required)</p>
          ${loanDetailsTable}
          <p style="margin-top: 20px;">Regards,<br>
          ${currentUser.name}<br>
          ${currentUserMobile}<br>
          YKC FINSERV PVT LTD</p>
        </body>
      </html>
    `;

    // Structured table data for frontend editing
    const tableFields = [
      { key: 'customerName', label: 'Customer Name', value: formatValue(lead.customerName), highlighted: false },
      { key: 'firmName', label: 'Firm/Company/Entity Name', value: formatValue(lead.formValues?.firmName || lead.formValues?.companyName || lead.formValues?.entityName || '-'), highlighted: true },
      { key: 'bankName', label: 'NBFC/Bank Name', value: formatValue(lead.bank?.name), highlighted: true },
      { key: 'loanType', label: 'Loan Type', value: formatValue(lead.loanType?.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase()) || '-'), highlighted: false },
      { key: 'sanctionedAmount', label: 'Sanctioned Amount', value: formatValue(lead.loanAmount), highlighted: false },
      { key: 'disbursedAmount', label: 'Disbursed Amount', value: disbursedAmountDisplay, highlighted: false },
      { key: 'insuranceAmount', label: 'Insurance Amount (If Any)', value: formatValue(lead.formValues?.insurance || lead.formValues?.insuranceAmount || '-'), highlighted: true },
      { key: 'applicationNumber', label: 'Application Number', value: formatValue(lead.caseNumber || lead.formValues?.applicationNumber || '-'), highlighted: false },
      { key: 'lanNumber', label: 'LAN Number', value: formatValue(lead.loanAccountNo || lead.formValues?.lanNumber || '-'), highlighted: false },
      { key: 'roi', label: 'ROI%', value: formatValue(lead.formValues?.roi || lead.formValues?.rateOfInterest || lead.formValues?.roiPercent || '-'), highlighted: false },
      { key: 'pf', label: 'PF%', value: formatValue(lead.formValues?.pf || lead.formValues?.processingFee || lead.formValues?.pfPercent || '-'), highlighted: false },
      { key: 'otcPddClearance', label: 'OTC/PDD Clearance (Cleared/Pending)', value: formatValue(lead.formValues?.otc || lead.formValues?.pdd || lead.formValues?.otcPddClearance || '-'), highlighted: false },
      { key: 'chequeHandoverStatus', label: 'Cheque Handover Status (Yes/No)', value: formatValue(lead.formValues?.chequeHandover || lead.formValues?.chequeHandoverStatus || '-'), highlighted: true },
      { key: 'codeConfirmation', label: 'Code Confirmation', value: formatValue(lead.dsaCode || lead.codeUse || lead.formValues?.codeConfirmation || '-'), highlighted: false },
      { key: 'subvention', label: 'Subvention (If Any)', value: formatValue(lead.formValues?.subvention || '-'), highlighted: true },
      { key: 'disbursementDate', label: 'Disbursement Date', value: formatDate(lead.disbursementDate), highlighted: false },
      { key: 'reportingManager', label: 'Reporting Manager Name & Mobile Number', value: `${formatValue(currentUser.name)} ${formatValue(currentUserMobile)}`.trim(), highlighted: false },
    ];

    res.status(200).json({
      success: true,
      data: {
        to: smBmEmail,
        from: fromEmail,
        date: formattedDate,
        cc: ccEmails,
        subject,
        body: emailBody,
        loanDetailsTable,
        tableFields, // Structured data for frontend editing
        lead: {
          id: lead._id,
          customerName: lead.customerName,
          bankName: lead.bank?.name,
          reportingManager: currentUser.name,
          reportingManagerMobile: currentUserMobile,
        },
      },
    });
  } catch (error) {
    console.error('Error getting email preview:', error);
    next(error);
  }
};

/**
 * Send Disbursement Confirmation Email
 */
export const sendDisbursementEmail = async (req, res, next) => {
  try {
    const leadId = req.params.id;
    const { to, cc, subject, body } = req.body;

    // Check access - agents cannot send, all other roles can
    if (req.user.role === 'agent') {
      return res.status(403).json({
        success: false,
        error: 'Access denied. Partners cannot send this email.',
      });
    }

    // Validate required fields
    if (!to || !subject || !body) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: to, subject, and body are required',
      });
    }

    // Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(to)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid TO email format',
      });
    }

    // Validate CC emails if provided
    const ccArray = Array.isArray(cc) ? cc : (cc ? [cc] : []);
    const invalidCC = ccArray.filter(email => !emailRegex.test(email));
    if (invalidCC.length > 0) {
      return res.status(400).json({
        success: false,
        error: `Invalid CC email format: ${invalidCC.join(', ')}`,
      });
    }

    // Get lead to verify it exists and is disbursed
    const lead = await Lead.findById(leadId);
    if (!lead) {
      return res.status(404).json({
        success: false,
        error: 'Lead not found',
      });
    }

    if (lead.status !== 'disbursed') {
      return res.status(400).json({
        success: false,
        error: 'Lead status must be "disbursed" to send disbursement confirmation email',
      });
    }

    // Send email using email service
    try {
      const emailLog = await emailService.sendEmail({
        to,
        cc: ccArray,
        subject,
        body,
        emailType: 'disbursement_confirmation',
        entityType: 'Lead',
        entityId: lead._id,
      });

      // Log activity in LeadHistory
      await LeadHistory.create({
        lead: lead._id,
        changedBy: req.user._id,
        action: 'email_sent',
        changes: [{
          field: 'disbursement_confirmation_email',
          oldValue: null,
          newValue: `Email sent to ${to} at ${new Date().toISOString()}`,
        }],
        remarks: `Disbursement confirmation email sent to ${to}`,
      });

      res.status(200).json({
        success: true,
        message: 'Disbursement confirmation email sent successfully',
        data: {
          emailLogId: emailLog._id,
          status: emailLog.status,
          sentAt: emailLog.sentAt,
        },
      });
    } catch (emailError) {
      console.error('Error sending email:', emailError);
      
      // Parse error message for user-friendly response
      let errorMessage = emailError.message || 'Unknown error occurred';
      
      // Check for common SMTP errors and provide user-friendly messages
      if (errorMessage.includes('Invalid login') || errorMessage.includes('Username and Password not accepted') || errorMessage.includes('BadCredentials')) {
        errorMessage = 'SMTP authentication failed. Please check your email server credentials in the system settings. The username and password may be incorrect or the account may require an app-specific password.';
      } else if (errorMessage.includes('ECONNREFUSED') || errorMessage.includes('ETIMEDOUT')) {
        errorMessage = 'Unable to connect to the email server. Please check your SMTP server settings (host and port).';
      } else if (errorMessage.includes('authentication')) {
        errorMessage = 'Email server authentication failed. Please verify your SMTP credentials.';
      }
      
      // Log failed attempt
      try {
        await LeadHistory.create({
          lead: lead._id,
          changedBy: req.user._id,
          action: 'email_sent_failed',
          changes: [{
            field: 'disbursement_confirmation_email',
            oldValue: null,
            newValue: `Failed to send email to ${to}`,
          }],
          remarks: `Failed to send disbursement confirmation email: ${emailError.message}`,
        });
      } catch (historyError) {
        console.error('Error logging email failure to history:', historyError);
      }

      return res.status(500).json({
        success: false,
        error: errorMessage,
        details: process.env.NODE_ENV === 'development' ? emailError.message : undefined,
      });
    }
  } catch (error) {
    console.error('Error sending disbursement email:', error);
    next(error);
  }
};
