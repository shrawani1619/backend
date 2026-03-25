import Lead from '../models/lead.model.js';
import Bank from '../models/bank.model.js';
import { getAccountantAccessibleAgentIds } from '../utils/accountantScope.js';

// Status mapping for consistent handling across the application
const ACCOUNTANT_ALLOWED_STATUSES = ['sanctioned', 'partial_disbursed', 'disbursed', 'completed'];

// Helper function to calculate dashboard statistics
const calculateDashboardStats = async (req = null) => {
  try {
    // Build query for approved leads
    const query = {
      status: { $in: ACCOUNTANT_ALLOWED_STATUSES }
    };

    // Filter by assigned Regional Managers hierarchy (for accountants only)
    if (req && req.user && req.user.role === 'accounts_manager') {
      const { getAccountantAccessibleAgentIds } = await import('../utils/accountantScope.js');
      const accessibleAgentIds = await getAccountantAccessibleAgentIds(req);
      if (accessibleAgentIds.length === 0) {
        // No assigned RMs or no agents under them - return empty stats
        return {
          totalApprovedAmount: 0,
          totalDisbursedAmount: 0,
          totalRemainingAmount: 0,
          totalCommission: 0,
          activeApprovedLoans: 0,
          completedLoans: 0,
          totalLoans: 0
        };
      }
      query.agent = { $in: accessibleAgentIds };
    }

    // Get approved leads (using correct status values)
    const approvedLeads = await Lead.find(query);

    // Calculate totals
    let totalApprovedAmount = 0;
    let totalDisbursedAmount = 0;
    let totalCommission = 0;
    let activeApprovedLoans = 0;
    let completedLoans = 0;

    approvedLeads.forEach(lead => {
      const loanAmount = lead.loanAmount || lead.amount || 0;
      const disbursedAmount = lead.disbursedAmount || 0;
      const commissionAmount = lead.commissionAmount || 0;
      
      totalApprovedAmount += loanAmount;
      totalDisbursedAmount += disbursedAmount;
      totalCommission += commissionAmount;
      
      // Count loan status
      if (disbursedAmount >= loanAmount) {
        completedLoans++;
      } else {
        activeApprovedLoans++;
      }
    });

    const totalRemainingAmount = totalApprovedAmount - totalDisbursedAmount;

    return {
      totalApprovedAmount,
      totalDisbursedAmount,
      totalRemainingAmount,
      totalCommission,
      activeApprovedLoans,
      completedLoans,
      totalLoans: approvedLeads.length
    };
  } catch (error) {
    throw error;
  }
};

// 1️⃣ Get Approved Leads (Accountant Only)
export const getApprovedLeads = async (req, res, next) => {
  try {
    const { page = 1, limit = 50, search, bank, startDate, endDate, sortBy = 'createdAt', sortOrder = 'desc' } = req.query;
    
    // Build query for approved leads only (using correct status values)
    const query = {
      status: { $in: ACCOUNTANT_ALLOWED_STATUSES }
    };

    // Filter by assigned Regional Managers hierarchy (for accountants only)
    if (req.user.role === 'accounts_manager') {
      const accessibleAgentIds = await getAccountantAccessibleAgentIds(req);
      if (accessibleAgentIds.length === 0) {
        // No assigned RMs or no agents under them - return empty result
        return res.status(200).json({
          success: true,
          data: {
            leads: [],
            pagination: {
              currentPage: parseInt(page),
              totalPages: 0,
              totalLeads: 0,
              hasNextPage: false,
              hasPrevPage: false
            }
          },
          message: 'No leads found for assigned Regional Managers'
        });
      }
      query.agent = { $in: accessibleAgentIds };
    }

    // Search by customer name
    if (search) {
      query.$or = [
        { customerName: { $regex: search, $options: 'i' } },
        { leadId: { $regex: search, $options: 'i' } },
        { loanAccountNo: { $regex: search, $options: 'i' } }
      ];
    }

    // Filter by bank
    if (bank) {
      query['bank.name'] = bank;
    }

    // Filter by date range
    if (startDate || endDate) {
      query.createdAt = {};
      if (startDate) query.createdAt.$gte = new Date(startDate);
      if (endDate) query.createdAt.$lte = new Date(endDate);
    }

    // Build sort object
    const sort = {};
    sort[sortBy] = sortOrder === 'asc' ? 1 : -1;

    // Execute query with pagination
    const leads = await Lead.find(query)
      .sort(sort)
      .limit(limit * 1)
      .skip((page - 1) * limit)
      .populate('agent', 'name email')
      .populate('subAgent', 'name email')
      .populate('referralFranchise', 'name')
      .populate('bank', 'name')
      .populate({
        path: 'associated',
        select: 'name',
        // Populate both Franchise and RelationshipManager
        // Remove match filter to allow both models
      })
      .select('-documents -history');

    // Get invoice information for each lead
    const Invoice = (await import('../models/invoice.model.js')).default;
    const leadIds = leads.map(lead => lead._id);
    const invoices = await Invoice.find({ lead: { $in: leadIds } })
      .select('lead invoiceType')
      .lean();
    
    // Create a map of leadId -> invoices
    const invoiceMap = {};
    invoices.forEach(invoice => {
      const leadId = invoice.lead.toString();
      if (!invoiceMap[leadId]) {
        invoiceMap[leadId] = {};
      }
      invoiceMap[leadId][invoice.invoiceType] = true;
    });
    
    // Add invoice information to each lead
    const leadsWithInvoices = leads.map(lead => {
      const leadObj = lead.toObject();
      const leadId = lead._id.toString();
      leadObj.hasAgentInvoice = invoiceMap[leadId]?.agent || false;
      leadObj.hasSubAgentInvoice = invoiceMap[leadId]?.sub_agent || false;
      leadObj.hasFranchiseInvoice = invoiceMap[leadId]?.franchise || false;
      return leadObj;
    });

    // Get total count for pagination
    const total = await Lead.countDocuments(query);

    res.status(200).json({
      success: true,
      data: {
        leads: leadsWithInvoices,
        pagination: {
          currentPage: parseInt(page),
          totalPages: Math.ceil(total / limit),
          totalLeads: total,
          hasNextPage: page * limit < total,
          hasPrevPage: page > 1
        }
      },
      message: 'Approved leads retrieved successfully'
    });
  } catch (error) {
    next(error);
  }
};

// 2️⃣ Get Single Approved Lead Details
export const getApprovedLeadDetails = async (req, res, next) => {
  try {
    const { id } = req.params;
    
    // Build query
    const query = {
      _id: id,
      status: { $in: [...ACCOUNTANT_ALLOWED_STATUSES, 'sanctioned'] } // Include sanctioned for viewing
    };

    // Filter by assigned Regional Managers hierarchy (for accountants only)
    if (req.user.role === 'accounts_manager') {
      const accessibleAgentIds = await getAccountantAccessibleAgentIds(req);
      if (accessibleAgentIds.length === 0) {
        return res.status(403).json({
          success: false,
          message: 'Access denied. No assigned Regional Managers.'
        });
      }
      query.agent = { $in: accessibleAgentIds };
    }
    
    // Find lead with approved status only (using correct status values)
    const lead = await Lead.findOne(query)
    .populate('agent', 'name email mobile')
    .populate('referralFranchise', 'name')
    .populate('bank', 'name type')
    .populate({
      path: 'associated',
      select: 'name',
      // Populate both Franchise and RelationshipManager
      // Remove match filter to allow both models
    })
    .populate('createdBy', 'name email')
    .select('+disbursementHistory');

    if (!lead) {
      return res.status(404).json({
        success: false,
        message: 'Approved lead not found'
      });
    }

    // Calculate financial summary
    const loanAmount = lead.loanAmount || lead.amount || 0;
    const disbursedAmount = lead.disbursedAmount || 0;
    const remainingAmount = loanAmount - disbursedAmount;
    const commissionAmount = lead.commissionAmount || 0;
    const commissionPercentage = lead.commissionPercentage || 0;

    // Calculate total commission components
    const totalCommission = lead.disbursementHistory?.reduce((sum, entry) => {
      return sum + (entry.commission || 0);
    }, 0) || 0;

    const totalGST = lead.disbursementHistory?.reduce((sum, entry) => {
      return sum + (entry.gst || 0);
    }, 0) || 0;

    const netCommission = totalCommission - totalGST;

    res.status(200).json({
      success: true,
      data: {
        lead,
        financialSummary: {
          loanAmount,
          totalDisbursed: disbursedAmount,
          remainingAmount,
          commissionPercentage,
          calculatedCommission: commissionAmount,
          totalCommission,
          totalGST,
          netCommission
        }
      },
      message: 'Lead details retrieved successfully'
    });
  } catch (error) {
    next(error);
  }
};

// 3️⃣ Add Disbursement
export const addDisbursement = async (req, res, next) => {
  try {
    const { id: leadId } = req.params;
    const { 
      amount, 
      date, 
      utr, 
      bankRef, 
      commission, 
      gst, 
      notes 
    } = req.body;

    // Validate required fields
    if (!amount || !date || !utr) {
      return res.status(400).json({
        success: false,
        message: 'Amount, date, and UTR are required'
      });
    }

    // Find the lead
    const lead = await Lead.findById(leadId);
    if (!lead) {
      return res.status(404).json({
        success: false,
        message: 'Lead not found'
      });
    }

    // Check if accountant can access this lead (filter by assigned RMs)
    if (req.user.role === 'accounts_manager') {
      const accessibleAgentIds = await getAccountantAccessibleAgentIds(req);
      if (accessibleAgentIds.length === 0 || !accessibleAgentIds.includes(lead.agent.toString())) {
        return res.status(403).json({
          success: false,
          message: 'Access denied. You can only add disbursements to leads under your assigned Regional Managers.'
        });
      }
    }

    // Verify lead is approved (using correct status values)
    if (!ACCOUNTANT_ALLOWED_STATUSES.includes(lead.status)) {
      return res.status(400).json({
        success: false,
        message: `Cannot add disbursement to this lead status. Current status: ${lead.status}. Allowed statuses: ${ACCOUNTANT_ALLOWED_STATUSES.join(', ')}`
      });
    }

    const loanAmount = lead.loanAmount || lead.amount || 0;
    const currentDisbursed = lead.disbursedAmount || 0;
    const remainingAmount = loanAmount - currentDisbursed;
    const disbursementAmount = parseFloat(amount);
    const commissionAmount = parseFloat(commission) || 0;
    const gstAmount = parseFloat(gst) || 0;

    // Debug logging
    console.log(`Lead ID: ${leadId}`);
    console.log(`Approved Amount: ${loanAmount}`);
    console.log(`Current Disbursed: ${currentDisbursed}`);
    console.log(`Remaining Amount: ${remainingAmount}`);
    console.log(`Requested Disbursement: ${disbursementAmount}`);

    // Validation: Disbursement amount must be greater than 0
    if (disbursementAmount <= 0) {
      return res.status(400).json({
        success: false,
        message: 'Disbursement amount must be greater than 0'
      });
    }

    // Validation: Disbursement amount must NOT exceed remainingAmount
    if (disbursementAmount > remainingAmount) {
      return res.status(400).json({
        success: false,
        message: `Disbursement amount cannot exceed remaining amount. Maximum allowed: ${remainingAmount}`
      });
    }

    // Add to disbursement history
    const newDisbursement = {
      amount: disbursementAmount,
      date: new Date(date),
      utr,
      bankRef: bankRef || '',
      commission: commissionAmount,
      gst: gstAmount,
      netCommission: commissionAmount - gstAmount,
      notes: notes || '',
      createdBy: req.user._id
    };

    if (!lead.disbursementHistory) {
      lead.disbursementHistory = [];
    }
    lead.disbursementHistory.push(newDisbursement);

    // Update lead totals
    lead.disbursedAmount = currentDisbursed + disbursementAmount;
    lead.commissionAmount = (lead.commissionAmount || 0) + commissionAmount;

    // Update status
    if (lead.disbursedAmount >= loanAmount) {
      lead.status = 'completed';
    } else {
      lead.status = 'partial_disbursed';
    }

    // Save the updated lead
    await lead.save();
    
    console.log(`Disbursement successful. New total disbursed: ${lead.disbursedAmount}, New remaining: ${loanAmount - lead.disbursedAmount}`);

    res.status(201).json({
      success: true,
      data: {
        lead: {
          id: lead._id,
          approvedAmount: loanAmount,
          totalDisbursed: lead.disbursedAmount,
          remainingAmount: loanAmount - lead.disbursedAmount,
          status: lead.status
        },
        disbursement: newDisbursement
      },
      message: 'Disbursement added successfully'
    });
  } catch (error) {
    next(error);
  }
};

// 4️⃣ Get Disbursement History
export const getDisbursementHistory = async (req, res, next) => {
  try {
    const { id: leadId } = req.params;

    const lead = await Lead.findById(leadId)
      .select('disbursementHistory customerName loanAmount')
      .populate('disbursementHistory.createdBy', 'name');

    if (!lead) {
      return res.status(404).json({
        success: false,
        message: 'Lead not found'
      });
    }

    // Verify lead is approved (using correct status values)
    if (!ACCOUNTANT_ALLOWED_STATUSES.includes(lead.status)) {
      return res.status(400).json({
        success: false,
        message: `Cannot access disbursement history for this lead status. Current status: ${lead.status}. Allowed statuses: ${ACCOUNTANT_ALLOWED_STATUSES.join(', ')}`
      });
    }

    const history = lead.disbursementHistory || [];
    const totalDisbursed = history.reduce((sum, entry) => sum + (entry.amount || 0), 0);
    const totalCommission = history.reduce((sum, entry) => sum + (entry.commission || 0), 0);
    const totalGST = history.reduce((sum, entry) => sum + (entry.gst || 0), 0);

    res.status(200).json({
      success: true,
      data: {
        leadId: lead._id,
        customerName: lead.customerName,
        loanAmount: lead.loanAmount,
        history,
        summary: {
          totalEntries: history.length,
          totalDisbursed,
          totalCommission,
          totalGST,
          netCommission: totalCommission - totalGST
        }
      },
      message: 'Disbursement history retrieved successfully'
    });
  } catch (error) {
    next(error);
  }
};

// 5️⃣ Accountant Dashboard Summary
export const getDashboardSummary = async (req, res, next) => {
  try {
    const stats = await calculateDashboardStats(req);
    
    // Build query for recent leads
    const recentLeadsQuery = {
      status: { $in: ACCOUNTANT_ALLOWED_STATUSES }
    };

    // Filter by assigned Regional Managers hierarchy (for accountants only)
    if (req.user.role === 'accounts_manager') {
      const accessibleAgentIds = await getAccountantAccessibleAgentIds(req);
      if (accessibleAgentIds.length === 0) {
        return res.status(200).json({
          success: true,
          data: {
            financialSummary: stats,
            recentLeads: [],
            disbursementStats: {
              totalDisbursements: 0,
              totalAmount: 0,
              thisMonth: 0
            }
          },
          message: 'Dashboard summary retrieved successfully'
        });
      }
      recentLeadsQuery.agent = { $in: accessibleAgentIds };
    }
    
    // Additional dashboard data
    const recentApprovedLeads = await Lead.find(recentLeadsQuery)
    .sort({ createdAt: -1 })
    .limit(5)
    .select('leadId customerName loanAmount status createdAt');

    // Build aggregation match query
    const aggregationMatch = {
      status: { $in: ACCOUNTANT_ALLOWED_STATUSES },
      disbursementHistory: { $exists: true, $ne: [] }
    };

    // Filter by assigned Regional Managers hierarchy (for accountants only)
    if (req.user.role === 'accounts_manager') {
      const accessibleAgentIds = await getAccountantAccessibleAgentIds(req);
      if (accessibleAgentIds.length > 0) {
        aggregationMatch.agent = { $in: accessibleAgentIds };
      } else {
        aggregationMatch._id = null; // No leads match
      }
    }

    const disbursementSummary = await Lead.aggregate([
      {
        $match: aggregationMatch
      },
      { $unwind: '$disbursementHistory' },
      {
        $group: {
          _id: null,
          totalDisbursements: { $sum: 1 },
          totalAmount: { $sum: '$disbursementHistory.amount' },
          thisMonth: {
            $sum: {
              $cond: [
                {
                  $and: [
                    { $gte: ['$disbursementHistory.date', new Date(new Date().setDate(1))] },
                    { $lt: ['$disbursementHistory.date', new Date(new Date().setMonth(new Date().getMonth() + 1, 1))] }
                  ]
                },
                '$disbursementHistory.amount',
                0
              ]
            }
          }
        }
      }
    ]);

    res.status(200).json({
      success: true,
      data: {
        financialSummary: stats,
        recentLeads: recentApprovedLeads,
        disbursementStats: disbursementSummary[0] || {
          totalDisbursements: 0,
          totalAmount: 0,
          thisMonth: 0
        }
      },
      message: 'Dashboard summary retrieved successfully'
    });
  } catch (error) {
    next(error);
  }
};

// 6️⃣ Commission Report API
export const getCommissionReport = async (req, res, next) => {
  try {
    const { startDate, endDate, bank, agent, page = 1, limit = 50 } = req.query;

    // Build aggregation match query
    const aggregationMatch = {
      status: { $in: ACCOUNTANT_ALLOWED_STATUSES },
      disbursementHistory: { $exists: true, $ne: [] }
    };

    // Filter by assigned Regional Managers hierarchy (for accountants only)
    if (req.user.role === 'accounts_manager') {
      const accessibleAgentIds = await getAccountantAccessibleAgentIds(req);
      if (accessibleAgentIds.length > 0) {
        aggregationMatch.agent = { $in: accessibleAgentIds };
      } else {
        aggregationMatch._id = null; // No leads match
      }
    }

    // Build aggregation pipeline
    const pipeline = [
      {
        $match: aggregationMatch
      },
      { $unwind: '$disbursementHistory' }
    ];

    // Date range filter
    if (startDate || endDate) {
      const dateFilter = {};
      if (startDate) dateFilter.$gte = new Date(startDate);
      if (endDate) dateFilter.$lte = new Date(endDate);
      pipeline.push({
        $match: {
          'disbursementHistory.date': dateFilter
        }
      });
    }

    // Bank filter
    if (bank) {
      pipeline.push({
        $match: {
          'bank.name': bank
        }
      });
    }

    // Agent filter
    if (agent) {
      pipeline.push({
        $match: {
          'agent.name': agent
        }
      });
    }

    // Add pagination
    pipeline.push(
      { $skip: (page - 1) * limit },
      { $limit: limit * 1 }
    );

    // Execute aggregation
    const commissionData = await Lead.aggregate(pipeline);

    // Calculate totals (use same match query)
    const totalsPipeline = [
      {
        $match: aggregationMatch
      },
      { $unwind: '$disbursementHistory' }
    ];

    // Apply same filters for totals
    if (startDate || endDate) {
      const dateFilter = {};
      if (startDate) dateFilter.$gte = new Date(startDate);
      if (endDate) dateFilter.$lte = new Date(endDate);
      totalsPipeline.push({
        $match: {
          'disbursementHistory.date': dateFilter
        }
      });
    }

    if (bank) {
      totalsPipeline.push({
        $match: {
          'bank.name': bank
        }
      });
    }

    if (agent) {
      totalsPipeline.push({
        $match: {
          'agent.name': agent
        }
      });
    }

    totalsPipeline.push({
      $group: {
        _id: null,
        grossCommission: { $sum: '$disbursementHistory.commission' },
        totalGST: { $sum: '$disbursementHistory.gst' },
        netCommission: { 
          $sum: { 
            $subtract: ['$disbursementHistory.commission', '$disbursementHistory.gst'] 
          } 
        },
        totalEntries: { $sum: 1 }
      }
    });

    const totals = await Lead.aggregate(totalsPipeline);

    res.status(200).json({
      success: true,
      data: {
        commissionEntries: commissionData,
        totals: totals[0] || {
          grossCommission: 0,
          totalGST: 0,
          netCommission: 0,
          totalEntries: 0
        },
        pagination: {
          currentPage: parseInt(page),
          limit: parseInt(limit)
        }
      },
      message: 'Commission report generated successfully'
    });
  } catch (error) {
    next(error);
  }
};

// 7️⃣ Edit Disbursement Entry
export const editDisbursement = async (req, res, next) => {
  try {
    const { leadId, disbursementId } = req.params;
    const { 
      amount, 
      date, 
      utr, 
      bankRef, 
      commission, 
      gst, 
      notes 
    } = req.body;

    // Find the lead
    const lead = await Lead.findById(leadId);
    if (!lead) {
      return res.status(404).json({
        success: false,
        message: 'Lead not found'
      });
    }

    // Check if accountant can access this lead (filter by assigned RMs)
    if (req.user.role === 'accounts_manager') {
      const accessibleAgentIds = await getAccountantAccessibleAgentIds(req);
      if (accessibleAgentIds.length === 0 || !accessibleAgentIds.includes(lead.agent.toString())) {
        return res.status(403).json({
          success: false,
          message: 'Access denied. You can only edit disbursements for leads under your assigned Regional Managers.'
        });
      }
    }

    // Debug logging
    console.log(`Edit Disbursement - Lead ID: ${leadId}`);
    console.log(`Current Lead Status: ${lead.status}`);
    console.log(`Status Valid: ${ACCOUNTANT_ALLOWED_STATUSES.includes(lead.status)}`);

    // Verify lead is approved and accessible to accountant (using correct status values)
    if (!ACCOUNTANT_ALLOWED_STATUSES.includes(lead.status)) {
      return res.status(400).json({
        success: false,
        message: `Cannot edit disbursement for this lead status. Current status: ${lead.status}. Allowed statuses: ${ACCOUNTANT_ALLOWED_STATUSES.join(', ')}`
      });
    }

    // Find the disbursement entry
    const disbursementIndex = lead.disbursementHistory.findIndex(
      entry => entry._id.toString() === disbursementId
    );

    if (disbursementIndex === -1) {
      return res.status(404).json({
        success: false,
        message: 'Disbursement entry not found'
      });
    }

    // Store original values for calculation
    const originalEntry = lead.disbursementHistory[disbursementIndex];
    const originalAmount = originalEntry.amount || 0;
    const originalCommission = originalEntry.commission || 0;
    const originalGST = originalEntry.gst || 0;

    // Update disbursement entry
    const updatedEntry = {
      _id: originalEntry._id,
      amount: amount !== undefined ? parseFloat(amount) : originalEntry.amount,
      date: date ? new Date(date) : originalEntry.date,
      utr: utr !== undefined ? utr : originalEntry.utr,
      bankRef: bankRef !== undefined ? bankRef : originalEntry.bankRef,
      commission: commission !== undefined ? parseFloat(commission) : originalEntry.commission,
      gst: gst !== undefined ? parseFloat(gst) : originalEntry.gst,
      netCommission: commission !== undefined ? 
        (parseFloat(commission) - (gst !== undefined ? parseFloat(gst) : originalEntry.gst)) : 
        originalEntry.netCommission,
      notes: notes !== undefined ? notes : originalEntry.notes,
      updatedAt: new Date(),
      updatedBy: req.user._id
    };

    lead.disbursementHistory[disbursementIndex] = updatedEntry;

    // Recalculate totals
    const amountDiff = updatedEntry.amount - originalAmount;
    const commissionDiff = updatedEntry.commission - originalCommission;
    const gstDiff = updatedEntry.gst - originalGST;

    lead.disbursedAmount = (lead.disbursedAmount || 0) + amountDiff;
    lead.commissionAmount = (lead.commissionAmount || 0) + commissionDiff;

    // Validate no over-disbursement
    const loanAmount = lead.loanAmount || lead.amount || 0;
    if (lead.disbursedAmount > loanAmount) {
      return res.status(400).json({
        success: false,
        message: `Edit would cause over-disbursement. Maximum allowed: ${loanAmount}`
      });
    }

    // Update status if needed (using correct status values)
    if (lead.disbursedAmount >= loanAmount) {
      lead.status = 'completed';
    } else if (lead.disbursedAmount > 0) {
      lead.status = 'partial_disbursed';
    }

    await lead.save();
    
    console.log('Edit Disbursement - Lead saved successfully, preparing response...');
    console.log('Updated entry ID:', updatedEntry._id.toString());
    console.log('Updated entry amount:', updatedEntry.amount);

    res.status(200).json({
      success: true,
      data: {
        lead: {
          id: lead._id.toString(),
          approvedAmount: loanAmount,
          totalDisbursed: lead.disbursedAmount,
          remainingAmount: loanAmount - lead.disbursedAmount,
          status: lead.status
        },
        updatedDisbursement: {
          id: updatedEntry._id.toString(),
          amount: updatedEntry.amount,
          date: updatedEntry.date,
          utr: updatedEntry.utr,
          commission: updatedEntry.commission,
          gst: updatedEntry.gst,
          netCommission: updatedEntry.netCommission,
          notes: updatedEntry.notes
        }
      },
      message: 'Disbursement entry updated successfully'
    });
  } catch (error) {
    next(error);
  }
};

// 8️⃣ Delete Disbursement Entry
export const deleteDisbursement = async (req, res, next) => {
  try {
    const { leadId, disbursementId } = req.params;

    // Find the lead
    const lead = await Lead.findById(leadId);
    if (!lead) {
      return res.status(404).json({
        success: false,
        message: 'Lead not found'
      });
    }

    // Check if accountant can access this lead (filter by assigned RMs)
    if (req.user.role === 'accounts_manager') {
      const accessibleAgentIds = await getAccountantAccessibleAgentIds(req);
      if (accessibleAgentIds.length === 0 || !accessibleAgentIds.includes(lead.agent.toString())) {
        return res.status(403).json({
          success: false,
          message: 'Access denied. You can only delete disbursements for leads under your assigned Regional Managers.'
        });
      }
    }

    // Verify lead is approved and accessible to accountant
    // Using actual lead status values from the lead model
    const allowedStatuses = ['sanctioned', 'partial_disbursed', 'disbursed', 'completed'];
    console.log(`Lead ID: ${leadId}, Current Status: ${lead.status}, Allowed Statuses: [${allowedStatuses.join(', ')}]`);
    
    if (!allowedStatuses.includes(lead.status)) {
      return res.status(400).json({
        success: false,
        message: `Cannot delete disbursement for this lead status. Current status: ${lead.status}. Allowed statuses: ${allowedStatuses.join(', ')}`
      });
    }

    // Find the disbursement entry
    const disbursementIndex = lead.disbursementHistory.findIndex(
      entry => entry._id.toString() === disbursementId
    );

    if (disbursementIndex === -1) {
      return res.status(404).json({
        success: false,
        message: 'Disbursement entry not found'
      });
    }

    // Store values for calculation
    const entryToDelete = lead.disbursementHistory[disbursementIndex];
    const amountToDelete = entryToDelete.amount || 0;
    const commissionToDelete = entryToDelete.commission || 0;
    const gstToDelete = entryToDelete.gst || 0;

    // Remove the disbursement entry
    lead.disbursementHistory.splice(disbursementIndex, 1);

    // Update totals
    lead.disbursedAmount = (lead.disbursedAmount || 0) - amountToDelete;
    lead.commissionAmount = (lead.commissionAmount || 0) - commissionToDelete;

    // Update status
    const loanAmount = lead.loanAmount || lead.amount || 0;
    if (lead.disbursedAmount <= 0) {
      lead.status = 'sanctioned'; // Reset to sanctioned if no disbursements
    } else if (lead.disbursedAmount >= loanAmount) {
      lead.status = 'completed';
    } else {
      lead.status = 'partial_disbursed';
    }

    await lead.save();

    res.status(200).json({
      success: true,
      data: {
        lead: {
          id: lead._id,
          loanAmount,
          totalDisbursed: lead.disbursedAmount,
          remainingAmount: loanAmount - lead.disbursedAmount,
          status: lead.status
        },
        deletedEntry: entryToDelete
      },
      message: 'Disbursement entry deleted successfully'
    });
  } catch (error) {
    next(error);
  }
};

// 9️⃣ Update Lead Status (Limited to Accountant-approved statuses)
export const updateLeadStatus = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { status, notes } = req.body;

    if (!ACCOUNTANT_ALLOWED_STATUSES.includes(status)) {
      return res.status(400).json({
        success: false,
        message: `Accountants can only update status to: ${ACCOUNTANT_ALLOWED_STATUSES.join(', ')}`
      });
    }

    const lead = await Lead.findById(id);
    if (!lead) {
      return res.status(404).json({
        success: false,
        message: 'Lead not found'
      });
    }

    if (req.user.role === 'accounts_manager') {
      const accessibleAgentIds = await getAccountantAccessibleAgentIds(req);
      if (accessibleAgentIds.length === 0 || !accessibleAgentIds.includes(lead.agent.toString())) {
        return res.status(403).json({
          success: false,
          message: 'Access denied. You can only update leads under your assigned Regional Managers.'
        });
      }
    }

    if (!ACCOUNTANT_ALLOWED_STATUSES.includes(lead.status)) {
      return res.status(400).json({
        success: false,
        message: `Cannot update status for this lead. Current status: ${lead.status}. Allowed current statuses: ${ACCOUNTANT_ALLOWED_STATUSES.join(', ')}`
      });
    }

    // Store previous status for audit
    const previousStatus = lead.status;

    // Update status
    lead.status = status;
    lead.statusNotes = notes || '';
    lead.statusUpdatedBy = req.user._id;
    lead.statusUpdatedAt = new Date();

    await lead.save();

    res.status(200).json({
      success: true,
      data: {
        lead: {
          id: lead._id,
          previousStatus,
          newStatus: lead.status,
          statusNotes: lead.statusNotes
        }
      },
      message: 'Lead status updated successfully'
    });
  } catch (error) {
    next(error);
  }
};

// 🔟 Add Notes to Lead
export const addLeadNote = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { note, noteType = 'general' } = req.body;

    if (!note) {
      return res.status(400).json({
        success: false,
        message: 'Note content is required'
      });
    }

    // Find the lead
    const lead = await Lead.findById(id);
    if (!lead) {
      return res.status(404).json({
        success: false,
        message: 'Lead not found'
      });
    }

    // Verify lead is accessible to accountant (using correct status values)
    const accessibleStatuses = ACCOUNTANT_ALLOWED_STATUSES;
    if (!accessibleStatuses.includes(lead.status)) {
      return res.status(400).json({
        success: false,
        message: `Cannot add notes to this lead status. Current status: ${lead.status}. Allowed statuses: ${accessibleStatuses.join(', ')}`
      });
    }

    // Add note to lead
    if (!lead.notes) {
      lead.notes = [];
    }

    const newNote = {
      content: note,
      type: noteType,
      createdBy: req.user._id,
      createdAt: new Date()
    };

    lead.notes.push(newNote);
    await lead.save();

    res.status(201).json({
      success: true,
      data: {
        note: newNote,
        totalNotes: lead.notes.length
      },
      message: 'Note added successfully'
    });
  } catch (error) {
    next(error);
  }
};