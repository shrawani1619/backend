import mongoose from 'mongoose';
import invoiceService from '../services/invoice.service.js';
import { getPaginationMeta } from '../utils/helpers.js';
import Invoice from '../models/invoice.model.js';
import { getRegionalManagerFranchiseIds, regionalManagerCanAccessFranchise } from '../utils/regionalScope.js';
import { createNotification } from '../services/ticket.service.js';
import User from '../models/user.model.js';

// Gross = Taxable + GST - TDS (GST 18%, TDS 2% of Taxable)
const GST_RATE = 18;
const TDS_RATE = 2;
function computeInvoiceAmounts(taxable, tdsPercentage = TDS_RATE) {
  const gstAmount = (taxable * GST_RATE) / 100;
  const tdsAmount = (taxable * tdsPercentage) / 100;
  const netPayable = taxable + gstAmount - tdsAmount;
  return { gstAmount, tdsAmount, netPayable };
}

/**
 * Get all invoices
 */
export const getInvoices = async (req, res, next) => {
  try {
    const { page = 1, limit = 10, status, agentId, franchiseId, leadId, disbursementId } = req.query;
    const skip = (page - 1) * limit;

    const query = {};
    
    // Role-based filtering
    if (req.user.role === 'agent') {
            // Agents can see:
      // 1. Their own agent invoices (invoiceType = 'agent' AND agent = their ID)
      // 2. Sub-agent invoices where they are the sub-agent (invoiceType = 'sub_agent' AND subAgent = their ID)
      // 3. Sub-agent invoices for their sub-agents (invoiceType = 'sub_agent' AND agent = their ID)
      query.$or = [
        { agent: req.user._id }, // Their own invoices (both agent and sub_agent types where they are the main agent)
        { subAgent: req.user._id } // Invoices where they are the sub-agent
      ];
    } else if (req.user.role === 'franchise') {
      // Franchise owners should only see invoices from their franchise
      if (!req.user.franchiseOwned) {
        return res.status(400).json({
          success: false,
          message: 'Franchise owner does not have an associated franchise',
        });
      }
      query.franchise = req.user.franchiseOwned;
    } else if (req.user.role === 'regional_manager') {
      const franchiseIds = await getRegionalManagerFranchiseIds(req);
      if (!franchiseIds?.length) {
        return res.status(200).json({
          success: true,
          data: [],
          pagination: getPaginationMeta(page, limit, 0),
        });
      }
      query.franchise = franchiseId && franchiseIds.some((fid) => fid.toString() === franchiseId)
        ? franchiseId
        : { $in: franchiseIds };
    } else if (req.user.role === 'relationship_manager') {
      // Relationship managers see only invoices for agents they manage (agent or subAgent)
      const RM = (await import('../models/relationship.model.js')).default;
      let rmId = req.user.relationshipManagerOwned;
      if (!rmId && RM) {
        const rmDoc = await RM.findOne({ owner: req.user._id }).select('_id').lean();
        if (rmDoc) rmId = rmDoc._id;
      }
      if (!rmId) {
        return res.status(200).json({
          success: true,
          data: [],
          pagination: getPaginationMeta(page, limit, 0),
        });
      }
      const agentIds = await User.find({
        role: 'agent',
        managedByModel: 'RelationshipManager',
        managedBy: rmId,
      })
        .select('_id')
        .lean();
      const ids = (agentIds || []).map((a) => a._id);
      if (ids.length === 0) {
        return res.status(200).json({
          success: true,
          data: [],
          pagination: getPaginationMeta(page, limit, 0),
        });
      }
      query.$or = [{ agent: { $in: ids } }, { subAgent: { $in: ids } }];
    } else if (req.user.role === 'accounts_manager') {
      // Only invoices under Regional Managers assigned to this accountant (see Accountant.assignedRegionalManagers).
      const { buildAccountsManagerInvoiceMatch } = await import('../utils/accountantScope.js');
      const { empty, match } = await buildAccountsManagerInvoiceMatch(req);
      if (empty) {
        return res.status(200).json({
          success: true,
          data: [],
          pagination: getPaginationMeta(page, limit, 0),
        });
      }
      Object.assign(query, match);
    }
    // super_admin: no extra query restriction (sees all)

    if (status) query.status = status;
    
    // Additional filters - only when they don't overwrite role-based scope
    if (agentId && req.user.role !== 'agent' && req.user.role !== 'relationship_manager') {
      query.agent = agentId;
    }
    if (franchiseId && req.user.role !== 'regional_manager' && req.user.role !== 'franchise' && req.user.role !== 'accounts_manager') {
      query.franchise = franchiseId;
    }
    if (leadId) query.lead = leadId;
    if (disbursementId) {
      query.disbursementId = mongoose.Types.ObjectId.isValid(disbursementId) && String(disbursementId).length === 24
        ? new mongoose.Types.ObjectId(disbursementId)
        : disbursementId;
    }

    const invoices = await Invoice.find(query)
      .populate('agent', 'name email mobile city address kyc bankDetails agentType gst')
      .populate('subAgent', 'name email mobile city address kyc bankDetails agentType gst')
      .populate('franchise', 'name email mobile address kyc bankDetails franchiseType gst')
      .populate('lead', 'loanAccountNo loanType customerName leadId loanAmount')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(parseInt(limit));

    const total = await Invoice.countDocuments(query);
    const pagination = getPaginationMeta(page, limit, total);

    res.status(200).json({
      success: true,
      data: invoices,
      pagination,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Get invoice by ID
 */
export const getInvoiceById = async (req, res, next) => {
  try {
    const invoice = await invoiceService.getInvoiceById(req.params.id);

    if (!invoice) {
      return res.status(404).json({
        success: false,
        message: 'Invoice not found',
      });
    }

    // Role-based access control
    if (req.user.role === 'agent') {
      // Agents can only view:
      // 1. Their own agent invoices (invoiceType = 'agent' AND agent = their ID)
      // 2. Sub-agent invoices where they are the sub-agent (invoiceType = 'sub_agent' AND subAgent = their ID)
      // 3. Sub-agent invoices for their sub-agents (invoiceType = 'sub_agent' AND agent = their ID)
      const agentId = req.user._id.toString();
      const invoiceAgentId = invoice.agent?._id?.toString() || invoice.agent?.toString();
      const invoiceSubAgentId = invoice.subAgent?._id?.toString() || invoice.subAgent?.toString();
      
      if (invoiceAgentId !== agentId && invoiceSubAgentId !== agentId) {
        return res.status(403).json({
          success: false,
          message: 'Access denied. You can only view your own invoices and sub-partner invoices.',
        });
      }
    } else if (req.user.role === 'franchise') {
      // Franchises can only view invoices for their franchise
      if (!req.user.franchiseOwned) {
        return res.status(400).json({
          success: false,
          message: 'Franchise owner does not have an associated franchise',
        });
      }
      const franchiseId = req.user.franchiseOwned.toString();
      const invoiceFranchiseId = invoice.franchise?._id?.toString() || invoice.franchise?.toString();
      
      if (invoiceFranchiseId !== franchiseId) {
        return res.status(403).json({
          success: false,
          message: 'Access denied. You can only view invoices for your franchise.',
        });
      }
    } else if (req.user.role === 'accounts_manager') {
      const { buildAccountsManagerInvoiceMatch } = await import('../utils/accountantScope.js');
      const { empty, match } = await buildAccountsManagerInvoiceMatch(req);
      if (empty) {
        return res.status(403).json({
          success: false,
          message: 'Access denied.',
        });
      }
      const allowed = await Invoice.exists({ _id: invoice._id, ...match });
      if (!allowed) {
        return res.status(403).json({
          success: false,
          message: 'Access denied. Invoice is outside your assigned Regional Manager scope.',
        });
      }
    }

    res.status(200).json({
      success: true,
      data: invoice,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Accept invoice (Agent)
 */
export const acceptInvoice = async (req, res, next) => {
  try {
    if (req.user.role === 'regional_manager') {
      const inv = await Invoice.findById(req.params.id).select('franchise');
      if (inv && !(await regionalManagerCanAccessFranchise(req, inv.franchise))) {
        return res.status(403).json({ success: false, error: 'Access denied.' });
      }
    }
    const { remarks } = req.body;
    const invoice = await invoiceService.acceptInvoice(req.params.id, remarks);

    res.status(200).json({
      success: true,
      message: 'Invoice accepted successfully',
      data: invoice,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Escalate invoice (Agent)
 */
export const escalateInvoice = async (req, res, next) => {
  try {
    if (req.user.role === 'regional_manager') {
      const inv = await Invoice.findById(req.params.id).select('franchise');
      if (inv && !(await regionalManagerCanAccessFranchise(req, inv.franchise))) {
        return res.status(403).json({ success: false, error: 'Access denied.' });
      }
    }
    const { reason, remarks } = req.body;

    if (!reason) {
      return res.status(400).json({
        success: false,
        message: 'Escalation reason is required',
      });
    }

    const invoice = await invoiceService.escalateInvoice(
      req.params.id,
      reason,
      remarks,
      req.user._id
    );

    res.status(200).json({
      success: true,
      message: 'Invoice escalated successfully',
      data: invoice,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Resolve escalation (Staff/Franchise Owner)
 */
export const resolveEscalation = async (req, res, next) => {
  try {
    if (req.user.role === 'regional_manager') {
      const inv = await Invoice.findById(req.params.id).select('franchise');
      if (inv && !(await regionalManagerCanAccessFranchise(req, inv.franchise))) {
        return res.status(403).json({ success: false, error: 'Access denied.' });
      }
    }
    const { resolutionRemarks, adjustments } = req.body;

    if (!resolutionRemarks) {
      return res.status(400).json({
        success: false,
        message: 'Resolution remarks are required',
      });
    }

    const invoice = await invoiceService.resolveEscalation(
      req.params.id,
      resolutionRemarks,
      req.user._id,
      adjustments
    );

    res.status(200).json({
      success: true,
      message: 'Escalation resolved successfully',
      data: invoice,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Approve invoice (Staff/Accounts)
 */
export const approveInvoice = async (req, res, next) => {
  try {
    if (req.user.role === 'regional_manager') {
      const inv = await Invoice.findById(req.params.id).select('franchise');
      if (inv && !(await regionalManagerCanAccessFranchise(req, inv.franchise))) {
        return res.status(403).json({ success: false, error: 'Access denied.' });
      }
    }
    const invoice = await invoiceService.approveInvoice(req.params.id, req.user._id);

    res.status(200).json({
      success: true,
      message: 'Invoice approved successfully',
      data: invoice,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Reject invoice
 */
export const rejectInvoice = async (req, res, next) => {
  try {
    if (req.user.role === 'regional_manager') {
      const inv = await Invoice.findById(req.params.id).select('franchise');
      if (inv && !(await regionalManagerCanAccessFranchise(req, inv.franchise))) {
        return res.status(403).json({ success: false, error: 'Access denied.' });
      }
    }
    const { rejectionReason } = req.body;

    if (!rejectionReason) {
      return res.status(400).json({
        success: false,
        message: 'Rejection reason is required',
      });
    }

    const invoice = await invoiceService.rejectInvoice(
      req.params.id,
      rejectionReason,
      req.user._id
    );

    res.status(200).json({
      success: true,
      message: 'Invoice rejected',
      data: invoice,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Generate Agent + Sub-Agent invoices for a single disbursement (body: leadId, disbursementId)
 */
export const generateInvoicesForDisbursement = async (req, res, next) => {
  try {
    if (req.user.role !== 'super_admin' && req.user.role !== 'accounts_manager') {
      return res.status(403).json({
        success: false,
        error: 'Access denied. Only Admin and Accountant can generate invoices.',
      });
    }

    const { leadId, disbursementId } = req.body || {};
    if (!leadId || !disbursementId) {
      return res.status(400).json({
        success: false,
        error: 'leadId and disbursementId are required in request body.',
      });
    }

    if (req.user.role === 'accounts_manager') {
      const { getAccountantAccessibleAgentIds } = await import('../utils/accountantScope.js');
      const accessibleAgentIds = await getAccountantAccessibleAgentIds(req);
      if (accessibleAgentIds.length === 0) {
        return res.status(403).json({
          success: false,
          error: 'Access denied. No assigned Regional Managers.',
        });
      }
      const Lead = (await import('../models/lead.model.js')).default;
      const lead = await Lead.findById(leadId).select('agent').lean();
      if (!lead) {
        return res.status(404).json({ success: false, error: 'Lead not found' });
      }
      if (!accessibleAgentIds.includes(lead.agent?.toString())) {
        return res.status(403).json({
          success: false,
          error: 'Access denied. You can only generate invoices for leads under your assigned Regional Managers.',
        });
      }
    }

    const result = await invoiceService.generateInvoicesForDisbursement(leadId, disbursementId);

    const populateOpts = [
      { path: 'lead', select: 'loanAccountNo loanType customerName bank' },
      { path: 'agent', select: 'name email mobile city address kyc bankDetails agentType gst' },
      { path: 'subAgent', select: 'name email mobile city address kyc bankDetails agentType gst' },
      { path: 'franchise', select: 'name' },
    ];

    const agentInvoice = result.agentInvoice
      ? await Invoice.findById(result.agentInvoice._id).populate(populateOpts)
      : null;
    const subAgentInvoice = result.subAgentInvoice
      ? await Invoice.findById(result.subAgentInvoice._id).populate(populateOpts)
      : null;

    return res.status(201).json({
      success: true,
      message: 'Agent and Sub-Agent invoices generated for disbursement.',
      data: { agentInvoice, subAgentInvoice },
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Generate Invoice from Lead
 */
export const generateInvoiceFromLead = async (req, res, next) => {
  try {
    // Only Admin and Accountant can generate invoices
    if (req.user.role !== 'super_admin' && req.user.role !== 'accounts_manager') {
      return res.status(403).json({
        success: false,
        error: 'Access denied. Only Admin and Accountant can generate invoices.',
      });
    }

    const { leadId } = req.params;

    // Check if accountant can access this lead
    if (req.user.role === 'accounts_manager') {
      const { getAccountantAccessibleAgentIds } = await import('../utils/accountantScope.js');
      const accessibleAgentIds = await getAccountantAccessibleAgentIds(req);
      if (accessibleAgentIds.length === 0) {
        return res.status(403).json({
          success: false,
          error: 'Access denied. No assigned Regional Managers.',
        });
      }

      const Lead = (await import('../models/lead.model.js')).default;
      const lead = await Lead.findById(leadId).select('agent');
      if (!lead) {
        return res.status(404).json({
          success: false,
          error: 'Lead not found',
        });
      }

      if (!accessibleAgentIds.includes(lead.agent.toString())) {
        return res.status(403).json({
          success: false,
          error: 'Access denied. You can only generate invoices for leads under your assigned Regional Managers.',
        });
      }
    }

    const invoiceResult = await invoiceService.generateInvoice(leadId);

    // Handle split invoices (when subAgent exists)
    if (invoiceResult.isSplit && invoiceResult.agentInvoice && invoiceResult.subAgentInvoice) {
      const populatedAgentInvoice = await Invoice.findById(invoiceResult.agentInvoice._id)
        .populate('lead', 'loanAccountNo loanType customerName loanAmount')
        .populate('agent', 'name email')
        .populate('franchise', 'name');

      const populatedSubAgentInvoice = await Invoice.findById(invoiceResult.subAgentInvoice._id)
        .populate('lead', 'loanAccountNo loanType customerName loanAmount')
        .populate('agent', 'name email')
        .populate('subAgent', 'name email')
        .populate('franchise', 'name');

      return res.status(201).json({
        success: true,
        message: 'Split invoices generated successfully (Partner and Sub Partner)',
        data: {
          agentInvoice: populatedAgentInvoice,
          subAgentInvoice: populatedSubAgentInvoice,
          isSplit: true,
        },
      });
    }

    // Handle dual franchise invoices (when referral franchise exists)
    if (invoiceResult.mainInvoice && invoiceResult.referralInvoice) {
      const populatedMainInvoice = await Invoice.findById(invoiceResult.mainInvoice._id)
        .populate('lead', 'loanAccountNo loanType customerName loanAmount')
        .populate('agent', 'name email')
        .populate('franchise', 'name');

      const populatedReferralInvoice = await Invoice.findById(invoiceResult.referralInvoice._id)
        .populate('lead', 'loanAccountNo loanType customerName loanAmount')
        .populate('agent', 'name email')
        .populate('franchise', 'name');

      return res.status(201).json({
        success: true,
        message: 'Franchise invoices generated successfully (Main Franchise and Referral Franchise)',
        data: {
          mainInvoice: populatedMainInvoice,
          referralInvoice: populatedReferralInvoice,
          isDualFranchise: true,
        },
      });
    }

    // Handle single invoice (no subAgent, no referral franchise)
    const populatedInvoice = await Invoice.findById(invoiceResult._id)
      .populate('lead', 'loanAccountNo loanType customerName loanAmount')
      .populate('agent', 'name email')
      .populate('franchise', 'name');

    res.status(201).json({
      success: true,
      message: 'Invoice generated successfully',
      data: populatedInvoice,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Create Invoice (Manual creation - Admin only)
 */
export const createInvoice = async (req, res, next) => {
  try {
    // Only Admin can manually create invoices
    if (req.user.role !== 'super_admin') {
      return res.status(403).json({
        success: false,
        error: 'Access denied. Only Admin can manually create invoices. Accountants should generate invoices from leads.',
      });
    }
    
    if (req.user.role === 'regional_manager' && req.body.franchise) {
      const canAccess = await regionalManagerCanAccessFranchise(req, req.body.franchise);
      if (!canAccess) {
        return res.status(403).json({
          success: false,
          error: 'Access denied. You can only create invoices for franchises associated with you.',
        });
      }
    }
    const body = { ...req.body };
    if (body.commissionAmount != null && body.commissionAmount > 0) {
      const tdsPct = body.tdsPercentage != null ? body.tdsPercentage : TDS_RATE;
      const amounts = computeInvoiceAmounts(Number(body.commissionAmount), tdsPct);
      body.gstAmount = amounts.gstAmount;
      body.tdsAmount = amounts.tdsAmount;
      body.netPayable = amounts.netPayable;
    }
    const invoice = await Invoice.create(body);

    const populatedInvoice = await Invoice.findById(invoice._id)
      .populate('lead', 'loanAccountNo loanType loanAmount')
      .populate('agent', 'name email')
      .populate('franchise', 'name');

    res.status(201).json({
      success: true,
      message: 'Invoice created successfully',
      data: populatedInvoice,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Update Invoice
 */
export const updateInvoice = async (req, res, next) => {
  try {
    // Only Admin and Accountant can edit invoices
    if (req.user.role !== 'super_admin' && req.user.role !== 'accounts_manager') {
      return res.status(403).json({
        success: false,
        error: 'Access denied. Only Admin and Accountant can edit invoices.',
      });
    }
    
    if (req.user.role === 'regional_manager') {
      const existing = await Invoice.findById(req.params.id).select('franchise');
      if (existing && !(await regionalManagerCanAccessFranchise(req, existing.franchise))) {
        return res.status(403).json({ success: false, error: 'Access denied.' });
      }
      if (req.body.franchise && !(await regionalManagerCanAccessFranchise(req, req.body.franchise))) {
        return res.status(403).json({ success: false, error: 'Access denied.' });
      }
    }

    // Get the invoice before update to check previous status
    const previousInvoice = await Invoice.findById(req.params.id)
      .populate('agent', 'name email')
      .populate('subAgent', 'name email')
      .populate('franchise', 'name');

    if (!previousInvoice) {
      return res.status(404).json({
        success: false,
        message: 'Invoice not found',
      });
    }

    const previousStatus = previousInvoice.status;
    const newStatus = req.body.status;

    const body = { ...req.body };
    if (body.commissionAmount != null && body.commissionAmount > 0) {
      const tdsPct = body.tdsPercentage != null ? body.tdsPercentage : (previousInvoice.tdsPercentage ?? TDS_RATE);
      const amounts = computeInvoiceAmounts(Number(body.commissionAmount), tdsPct);
      body.gstAmount = amounts.gstAmount;
      body.tdsAmount = amounts.tdsAmount;
      body.netPayable = amounts.netPayable;
    }

    // Update the invoice
    const invoice = await Invoice.findByIdAndUpdate(req.params.id, body, {
      new: true,
      runValidators: true,
    })
      .populate('lead', 'loanAccountNo loanType loanAmount')
      .populate('agent', 'name email')
      .populate('subAgent', 'name email')
      .populate('franchise', 'name');

    if (!invoice) {
      return res.status(404).json({
        success: false,
        message: 'Invoice not found',
      });
    }

    // Send notification if status changed from 'pending' to 'paid'
    if (previousStatus === 'pending' && newStatus === 'paid') {
      try {
        let notificationUserId = null;

        // Determine which user should receive the notification
        if (invoice.invoiceType === 'agent' || invoice.invoiceType === 'sub_agent') {
          // For agent/sub_agent invoices, notify the agent (or subAgent if it's a sub_agent invoice)
          if (invoice.invoiceType === 'sub_agent' && invoice.subAgent) {
            notificationUserId = invoice.subAgent._id || invoice.subAgent;
          } else if (invoice.agent) {
            notificationUserId = invoice.agent._id || invoice.agent;
          }
        } else if (invoice.invoiceType === 'franchise') {
          // For franchise invoices, find the franchise owner
          const franchiseOwner = await User.findOne({
            role: 'franchise',
            franchiseOwned: invoice.franchise._id || invoice.franchise,
          }).select('_id');

          if (franchiseOwner) {
            notificationUserId = franchiseOwner._id;
          }
        }

        // Create notification if we found a user to notify
        if (notificationUserId) {
          const invoiceNumber = invoice.invoiceNumber || 'N/A';
          const netPayable = invoice.netPayable || 0;
          const title = 'Invoice Paid';
          const message = `Your invoice ${invoiceNumber} has been marked as paid. Amount: ₹${netPayable.toLocaleString('en-IN')}`;

          await createNotification(
            notificationUserId,
            title,
            message,
            null, // relatedTicketId
            'invoice_paid',
            invoice._id // relatedInvoiceId
          );
        }
      } catch (notificationError) {
        // Log error but don't fail the invoice update
        console.error('Error creating invoice paid notification:', notificationError);
      }
    }

    res.status(200).json({
      success: true,
      message: 'Invoice updated successfully',
      data: invoice,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Delete Invoice
 */
export const deleteInvoice = async (req, res, next) => {
  try {
    // Only Admin and Accountant can delete invoices
    if (req.user.role !== 'super_admin' && req.user.role !== 'accounts_manager') {
      return res.status(403).json({
        success: false,
        error: 'Access denied. Only Admin and Accountant can delete invoices.',
      });
    }
    
    if (req.user.role === 'regional_manager') {
      const inv = await Invoice.findById(req.params.id).select('franchise');
      if (inv && !(await regionalManagerCanAccessFranchise(req, inv.franchise))) {
        return res.status(403).json({ success: false, error: 'Access denied.' });
      }
    }
    const invoice = await Invoice.findByIdAndDelete(req.params.id);

    if (!invoice) {
      return res.status(404).json({
        success: false,
        message: 'Invoice not found',
      });
    }

    res.status(200).json({
      success: true,
      message: 'Invoice deleted successfully',
    });
  } catch (error) {
    next(error);
  }
};
