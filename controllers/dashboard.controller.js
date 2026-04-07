import Lead from '../models/lead.model.js';
import Invoice from '../models/invoice.model.js';
import Payout from '../models/payout.model.js';
import User from '../models/user.model.js';
import Bank from '../models/bank.model.js';
import Franchise from '../models/franchise.model.js';
import EmailLog from '../models/emailLog.model.js';
import mongoose from 'mongoose';
import { getRegionalManagerFranchiseIds } from '../utils/regionalScope.js';
import { getAccountsManagerDashboardScopes } from '../utils/accountantScope.js';

const getAdvancePaymentStats = async ({ leadMatch = {} } = {}) => {
  const advanceLeadIds = await Lead.find({ ...leadMatch, advancePayment: true }).distinct('_id');
  const advancePaymentCount = Array.isArray(advanceLeadIds) ? advanceLeadIds.length : 0;

  if (!advanceLeadIds || advanceLeadIds.length === 0) {
    return { advancePaymentCount: 0, advancePaymentPendingAmount: 0 };
  }

  const agg = await Invoice.aggregate([
    { $match: { lead: { $in: advanceLeadIds } } },
    {
      $lookup: {
        from: 'payouts',
        localField: 'payout',
        foreignField: '_id',
        as: 'payoutDoc',
      },
    },
    {
      $addFields: {
        payoutStatus: { $ifNull: [{ $arrayElemAt: ['$payoutDoc.status', 0] }, null] },
      },
    },
    {
      $group: {
        _id: null,
        total: { $sum: { $ifNull: ['$netPayable', 0] } },
        received: {
          $sum: {
            $cond: [
              { $in: ['$payoutStatus', ['payment_received', 'complete']] },
              { $ifNull: ['$netPayable', 0] },
              0,
            ],
          },
        },
      },
    },
  ]);

  const total = agg[0]?.total || 0;
  const received = agg[0]?.received || 0;
  const advancePaymentPendingAmount = Math.max(0, total - received);
  return { advancePaymentCount, advancePaymentPendingAmount };
};

/**
 * Get agent dashboard data
 */
export const getAgentDashboard = async (req, res, next) => {
  try {
    const agentId = new mongoose.Types.ObjectId(req.user._id);
    const { bankId, codeUse, leadStatus, dateFrom, dateTo, limit } = req.query;

    const baseMatch = { agent: agentId };
    if (bankId) baseMatch.bank = new mongoose.Types.ObjectId(bankId);
    if (codeUse && String(codeUse).trim()) baseMatch.dsaCode = new RegExp(String(codeUse).trim(), 'i');
    if (leadStatus && String(leadStatus).trim()) baseMatch.status = leadStatus;
    if (dateFrom || dateTo) {
      baseMatch.createdAt = {};
      if (dateFrom) baseMatch.createdAt.$gte = new Date(dateFrom);
      if (dateTo) {
        const end = new Date(dateTo);
        end.setHours(23, 59, 59, 999);
        baseMatch.createdAt.$lte = end;
      }
    }
    const limitNum = limit ? Math.min(parseInt(limit, 10) || 10, 100) : 10;

    const totalLeads = await Lead.countDocuments(baseMatch);
    const pendingLeads = await Lead.countDocuments({ ...baseMatch, verificationStatus: 'pending' });
    const verifiedLeads = await Lead.countDocuments({ ...baseMatch, verificationStatus: 'verified' });
    const completedLeads = await Lead.countDocuments({ ...baseMatch, status: 'completed' });

    const pendingInvoices = await Invoice.countDocuments({ agent: agentId, status: 'pending' });
    const approvedInvoices = await Invoice.countDocuments({ agent: agentId, status: 'approved' });
    const escalatedInvoices = await Invoice.countDocuments({ agent: agentId, status: 'escalated' });

    const pendingPayouts = await Payout.countDocuments({ agent: agentId, status: 'pending' });
    const paidPayouts = await Payout.countDocuments({ agent: agentId, status: { $in: ['complete', 'payment_received'] } });

    const commissionAggregation = await Invoice.aggregate([
      { $match: { agent: agentId } },
      { $group: { _id: null, total: { $sum: '$commissionAmount' } } },
    ]);
    const totalCommission = commissionAggregation[0]?.total || 0;

    const recentLeads = await Lead.find(baseMatch)
      .populate('referralFranchise', 'name')
      .populate('bank', 'name')
      .sort({ createdAt: -1 })
      .limit(Math.min(limitNum, 5));

    const completedLeadsWithoutInvoices = await Lead.find({
      ...baseMatch,
      status: 'completed',
      $or: [
        { isInvoiceGenerated: false },
        { isInvoiceGenerated: { $exists: false } },
        { invoice: { $exists: false } },
        { invoice: null },
      ],
    })
      .populate('bank', 'name')
      .sort({ createdAt: -1 })
      .limit(limitNum);

    const pendingInvoicesForAction = await Invoice.find({
      agent: agentId,
      status: 'pending',
    })
      .populate('lead', 'loanAccountNo loanAmount')
      .populate('franchise', 'name')
      .sort({ createdAt: -1 })
      .limit(limitNum);

    const escalatedInvoicesList = await Invoice.find({
      agent: agentId,
      status: 'escalated',
    })
      .populate('lead', 'loanAccountNo loanAmount')
      .populate('franchise', 'name')
      .sort({ escalatedAt: -1 })
      .limit(limitNum);

    // Lead Conversion Funnel - Calculate total amounts for each stage
    const { funnelPeriod = 'monthly' } = req.query;
    const now = new Date();
    let dateFilter = {};
    
    if (funnelPeriod === 'weekly') {
      const weekAgo = new Date(now);
      weekAgo.setDate(weekAgo.getDate() - 7);
      dateFilter = { createdAt: { $gte: weekAgo } };
    } else if (funnelPeriod === 'monthly') {
      const monthAgo = new Date(now);
      monthAgo.setMonth(monthAgo.getMonth() - 1);
      dateFilter = { createdAt: { $gte: monthAgo } };
    } else if (funnelPeriod === 'yearly') {
      const yearAgo = new Date(now);
      yearAgo.setFullYear(yearAgo.getFullYear() - 1);
      dateFilter = { createdAt: { $gte: yearAgo } };
    }

    const agentFunnelMatch = { agent: agentId, ...dateFilter };
    
    const loggedAgg = await Lead.aggregate([
      { $match: { ...agentFunnelMatch, status: 'logged' } },
      { $group: { _id: null, totalAmount: { $sum: '$loanAmount' } } }
    ]);
    const sanctionedAgg = await Lead.aggregate([
      { $match: { ...agentFunnelMatch, status: 'sanctioned' } },
      { $group: { _id: null, totalAmount: { $sum: '$loanAmount' } } }
    ]);
    const disbursedAgg = await Lead.aggregate([
      { $match: { ...agentFunnelMatch, status: { $in: ['partial_disbursed', 'disbursed'] } } },
      { $group: { _id: null, totalAmount: { $sum: '$loanAmount' } } }
    ]);
    const completedAgg = await Lead.aggregate([
      { $match: { ...agentFunnelMatch, status: 'completed' } },
      { $group: { _id: null, totalAmount: { $sum: '$loanAmount' } } }
    ]);
    const rejectedAgg = await Lead.aggregate([
      { $match: { ...agentFunnelMatch, status: 'rejected' } },
      { $group: { _id: null, totalAmount: { $sum: '$loanAmount' } } }
    ]);
    
    const leadConversionFunnel = [
      { stage: 'Logged', value: loggedAgg[0]?.totalAmount || 0, fill: '#f97316' },
      { stage: 'Sanctioned', value: sanctionedAgg[0]?.totalAmount || 0, fill: '#84cc16' },
      { stage: 'Disbursed', value: disbursedAgg[0]?.totalAmount || 0, fill: '#3b82f6' },
      { stage: 'Completed', value: completedAgg[0]?.totalAmount || 0, fill: '#ea580c' },
      { stage: 'Rejected', value: rejectedAgg[0]?.totalAmount || 0, fill: '#b91c1c' },
    ];

    res.status(200).json({
      success: true,
      data: {
        leads: {
          total: totalLeads,
          pending: pendingLeads,
          verified: verifiedLeads,
          completed: completedLeads,
        },
        invoices: {
          pending: pendingInvoices,
          approved: approvedInvoices,
          escalated: escalatedInvoices,
        },
        payouts: {
          pending: pendingPayouts,
          paid: paidPayouts,
        },
        totalCommission,
        recentLeads,
        completedLeadsWithoutInvoices,
        pendingInvoicesForAction,
        escalatedInvoicesList,
        leadConversionFunnel,
      },
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Get relationship manager dashboard data (legacy staff dashboard - for backwards compatibility)
 */
export const getStaffDashboard = async (req, res, next) => {
  try {
    const pendingVerification = await Lead.countDocuments({ verificationStatus: 'pending' });
    const escalatedInvoices = await Invoice.countDocuments({ status: 'escalated' });
    const recentLeads = await Lead.find({ verificationStatus: 'pending' })
      .populate('agent', 'name email')
      .populate('associated', 'name') // polymorphic: Franchise or RelationshipManager
      .populate('referralFranchise', 'name')
      .populate('bank', 'name')
      .sort({ createdAt: -1 })
      .limit(10);
    const escalated = await Invoice.find({ status: 'escalated' })
      .populate('agent', 'name email')
      .populate('franchise', 'name')
      .sort({ escalatedAt: -1 })
      .limit(10);
    res.status(200).json({
      success: true,
      data: { pendingVerification, escalatedInvoices, recentLeads, escalated },
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Get relationship manager dashboard data (similar to franchise owner dashboard, scoped by assigned franchises)
 */
export const getRelationshipManagerDashboard = async (req, res, next) => {
  try {
    // Get the Relationship Manager ID from the user
    let rmId = req.user.relationshipManagerOwned;
    if (!rmId) {
      // Try to find the RM profile by owner
      const RelationshipManager = (await import('../models/relationship.model.js')).default;
      const rmDoc = await RelationshipManager.findOne({ owner: req.user._id }).select('_id');
      if (rmDoc) rmId = rmDoc._id;
    }

    // Find all agents managed by this Relationship Manager
    const managedAgentIds = rmId 
      ? await User.find({ managedByModel: 'RelationshipManager', managedBy: rmId }).distinct('_id')
      : [];
    
    // Include the RM user themselves as an agent (if they create leads for themselves)
    const allAgentIds = [...managedAgentIds];
    if (req.user._id) {
      allAgentIds.push(req.user._id);
    }

    // Build lead match query: leads where agent is in managed agents OR associated with this RM
    const leadMatch = {
      $or: [
        { agent: { $in: allAgentIds } },
        { associatedModel: 'RelationshipManager', associated: rmId }
      ]
    };

    const totalLeads = rmId ? await Lead.countDocuments(leadMatch) : 0;
    const totalAgents = managedAgentIds.length;
    const totalFranchises = 0; // RMs don't manage franchises directly
    
    // Get invoices for leads managed by this RM
    const leadIds = rmId ? await Lead.find(leadMatch).distinct('_id') : [];
    const totalInvoices = leadIds.length
      ? await Invoice.countDocuments({ lead: { $in: leadIds } })
      : 0;

    const commissionAggregation = leadIds.length
      ? await Invoice.aggregate([
        { $match: { lead: { $in: leadIds } } },
        { $group: { _id: null, total: { $sum: '$commissionAmount' } } },
      ])
      : [];
    const totalCommission = commissionAggregation[0]?.total || 0;

    const payoutAggregation = leadIds.length
      ? await Invoice.aggregate([
        { $match: { lead: { $in: leadIds }, status: 'paid' } },
        { $group: { _id: null, total: { $sum: '$commissionAmount' } } },
      ])
      : [];
    const totalPayouts = payoutAggregation[0]?.total || 0;

    const leadStatusBreakdown = rmId
      ? await Lead.aggregate([
        { $match: leadMatch },
        { $group: { _id: '$status', count: { $sum: 1 } } },
      ])
      : [];

    const loanDistributionAgg = rmId
      ? await Lead.aggregate([
        { $match: { ...leadMatch, loanType: { $exists: true, $ne: null } } },
        { $group: { _id: '$loanType', count: { $sum: 1 }, totalAmount: { $sum: '$loanAmount' } } },
        { $sort: { count: -1 } },
      ])
      : [];
    const totalForLoan = loanDistributionAgg.reduce((s, i) => s + i.count, 0) || 1;
    const loanTypeLabels = {
      personal_loan: 'Personal Loan',
      home_loan: 'Home Loan',
      business_loan: 'Business Loan',
      loan_against_property: 'Loan Against Property',
      education_loan: 'Education Loan',
      car_loan: 'Car Loan',
      gold_loan: 'Gold Loan',
    };
    const loanDistributionColors = ['#f97316', '#3b82f6', '#1e40af', '#22c55e', '#84cc16', '#eab308', '#a855f7'];
    const loanDistributionRaw = loanDistributionAgg.map((item, idx) => ({
      name: loanTypeLabels[item._id] || item._id,
      value: Math.round((item.count / totalForLoan) * 100),
      count: item.count,
      totalAmount: item.totalAmount || 0,
      color: loanDistributionColors[idx % loanDistributionColors.length],
    }));
    const sumPct = loanDistributionRaw.reduce((s, i) => s + i.value, 0);
    const loanDistribution = loanDistributionRaw.map((item, idx) => ({
      ...item,
      value: idx === 0 ? item.value + (100 - sumPct) : item.value,
    }));

    // Get funnel period filter from query params (weekly, monthly, yearly)
    const funnelPeriod = req.query.funnelPeriod || 'monthly';
    const now = new Date();
    let dateFilter = {};
    
    if (funnelPeriod === 'weekly') {
      const weekAgo = new Date(now);
      weekAgo.setDate(weekAgo.getDate() - 7);
      dateFilter = { createdAt: { $gte: weekAgo } };
    } else if (funnelPeriod === 'monthly') {
      const monthAgo = new Date(now);
      monthAgo.setMonth(monthAgo.getMonth() - 1);
      dateFilter = { createdAt: { $gte: monthAgo } };
    } else if (funnelPeriod === 'yearly') {
      const yearAgo = new Date(now);
      yearAgo.setFullYear(yearAgo.getFullYear() - 1);
      dateFilter = { createdAt: { $gte: yearAgo } };
    }

    // Calculate total amounts for each funnel stage instead of counts
    const funnelMatch = rmId
      ? { ...leadMatch, ...dateFilter }
      : { ...dateFilter };
    
    const loggedAgg = await Lead.aggregate([
      { $match: { ...funnelMatch, status: 'logged' } },
      { $group: { _id: null, totalAmount: { $sum: '$loanAmount' } } }
    ]);
    const sanctionedAgg = await Lead.aggregate([
      { $match: { ...funnelMatch, status: 'sanctioned' } },
      { $group: { _id: null, totalAmount: { $sum: '$loanAmount' } } }
    ]);
    const disbursedAgg = await Lead.aggregate([
      { $match: { ...funnelMatch, status: { $in: ['partial_disbursed', 'disbursed'] } } },
      { $group: { _id: null, totalAmount: { $sum: '$loanAmount' } } }
    ]);
    const completedAgg = await Lead.aggregate([
      { $match: { ...funnelMatch, status: 'completed' } },
      { $group: { _id: null, totalAmount: { $sum: '$loanAmount' } } }
    ]);
    const rejectedAgg = await Lead.aggregate([
      { $match: { ...funnelMatch, status: 'rejected' } },
      { $group: { _id: null, totalAmount: { $sum: '$loanAmount' } } }
    ]);
    
    const leadConversionFunnel = [
      { stage: 'Logged', value: loggedAgg[0]?.totalAmount || 0, fill: '#f97316' },
      { stage: 'Sanctioned', value: sanctionedAgg[0]?.totalAmount || 0, fill: '#84cc16' },
      { stage: 'Disbursed', value: disbursedAgg[0]?.totalAmount || 0, fill: '#3b82f6' },
      { stage: 'Completed', value: completedAgg[0]?.totalAmount || 0, fill: '#ea580c' },
      { stage: 'Rejected', value: rejectedAgg[0]?.totalAmount || 0, fill: '#b91c1c' },
    ];

    const recentLeads = rmId
      ? await Lead.find(leadMatch)
        .populate('agent', 'name email')
        .populate('associated', 'name')
        .populate('referralFranchise', 'name')
        .populate('bank', 'name')
        .sort({ createdAt: -1 })
        .limit(5)
      : [];

    const recentAgents = managedAgentIds.length
      ? await User.find({ _id: { $in: managedAgentIds } })
        .select('name email mobile status createdAt')
        .sort({ createdAt: -1 })
        .limit(5)
      : [];

    const recentFranchises = [];

    const recentInvoices = leadIds.length
      ? await Invoice.find({ lead: { $in: leadIds } })
        .populate('agent', 'name email')
        .populate('lead', 'customerName applicantMobile loanAmount')
        .select('invoiceNumber amount commissionAmount status createdAt')
        .sort({ createdAt: -1 })
        .limit(5)
      : [];

    const recentPayouts = []; // RMs don't have direct payouts

    const sevenMonthsAgo = new Date();
    sevenMonthsAgo.setMonth(sevenMonthsAgo.getMonth() - 7);
    const visitorData = rmId
      ? await Lead.aggregate([
        { $match: { ...leadMatch, createdAt: { $gte: sevenMonthsAgo } } },
        {
          $group: {
            _id: { year: { $year: '$createdAt' }, month: { $month: '$createdAt' } },
            visitors: { $sum: 1 },
            leads: { $sum: 1 },
            conversions: { $sum: { $cond: [{ $eq: ['$status', 'completed'] }, 1, 0] } },
          },
        },
        { $sort: { '_id.year': 1, '_id.month': 1 } },
        { $limit: 7 },
      ])
      : [];
    const monthNames = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
    const formattedVisitorData = visitorData.map((item) => ({
      month: `${monthNames[item._id.month - 1]}/${String(item._id.year).slice(-2)}`,
      visitors: item.visitors,
      leads: item.leads,
      conversions: item.conversions,
    }));

    const totalLeadsCount = totalLeads;
    const completedLeadsCount = rmId
      ? await Lead.countDocuments({ ...leadMatch, status: 'completed' })
      : 0;
    const activeLeadsCount = rmId
      ? await Lead.countDocuments({ ...leadMatch, status: 'active' })
      : 0;
    const verifiedLeadsCount = rmId
      ? await Lead.countDocuments({ ...leadMatch, verificationStatus: 'verified' })
      : 0;

    const bounceRate = totalLeadsCount > 0 ? ((totalLeadsCount - completedLeadsCount) / totalLeadsCount * 100).toFixed(2) : 0;
    const pageViewsRate = totalLeadsCount > 0 ? ((verifiedLeadsCount / totalLeadsCount) * 100).toFixed(2) : 0;
    const impressionsRate = totalLeadsCount > 0 ? ((activeLeadsCount / totalLeadsCount) * 100).toFixed(2) : 0;
    const conversionRate = totalLeadsCount > 0 ? ((completedLeadsCount / totalLeadsCount) * 100).toFixed(2) : 0;

    const previousPeriodStart = new Date(sevenMonthsAgo);
    previousPeriodStart.setMonth(previousPeriodStart.getMonth() - 7);
    const prevMatch = rmId
      ? {
        ...leadMatch,
        createdAt: { $gte: previousPeriodStart, $lt: sevenMonthsAgo },
      }
      : { _id: null };
    const previousPeriodLeads = await Lead.countDocuments(prevMatch);
    const previousPeriodCompleted = await Lead.countDocuments({ ...prevMatch, status: 'completed' });
    const previousPeriodVerified = await Lead.countDocuments({ ...prevMatch, verificationStatus: 'verified' });
    const previousPeriodActive = await Lead.countDocuments({ ...prevMatch, status: 'active' });

    const prevBounceRate = previousPeriodLeads > 0 ? ((previousPeriodLeads - previousPeriodCompleted) / previousPeriodLeads * 100).toFixed(2) : 0;
    const prevPageViewsRate = previousPeriodLeads > 0 ? ((previousPeriodVerified / previousPeriodLeads) * 100).toFixed(2) : 0;
    const prevImpressionsRate = previousPeriodLeads > 0 ? ((previousPeriodActive / previousPeriodLeads) * 100).toFixed(2) : 0;
    const prevConversionRate = previousPeriodLeads > 0 ? ((previousPeriodCompleted / previousPeriodLeads) * 100).toFixed(2) : 0;

    const browserData = [
      { name: 'Google Chrome', value: 90, color: '#10b981' },
      { name: 'Mozilla Firefox', value: 76, color: '#3b82f6' },
      { name: 'Apple Safari', value: 50, color: '#f59e0b' },
      { name: 'Edge Browser', value: 20, color: '#10b981' },
      { name: 'Opera Mini', value: 15, color: '#ef4444' },
      { name: 'Internet Explorer', value: 12, color: '#60a5fa' },
      { name: 'Others', value: 6, color: '#9ca3af' },
    ];

    const totalEmails = leadIds.length ? await EmailLog.countDocuments({ entityType: 'lead', entityId: { $in: leadIds } }) : 0;
    const sentEmails = leadIds.length ? await EmailLog.countDocuments({ entityType: 'lead', entityId: { $in: leadIds }, status: 'sent' }) : 0;
    const bouncedEmails = leadIds.length ? await EmailLog.countDocuments({ entityType: 'lead', entityId: { $in: leadIds }, status: 'bounced' }) : 0;
    const openedEmails = Math.floor(sentEmails * 0.49);
    const clickedEmails = Math.floor(sentEmails * 0.25);

    // Calculate total loan amount from loan distribution
    const totalLoanAmount = loanDistribution.reduce((sum, item) => sum + (item.totalAmount || 0), 0);

    res.status(200).json({
      success: true,
      data: {
        totalLeads,
        totalAgents,
        totalFranchises,
        totalInvoices,
        totalCommission,
        totalPayouts,
        totalRevenue: totalCommission,
        totalLoanAmount,
        leadStatusBreakdown,
        loanDistribution,
        leadConversionFunnel,
        recentLeads,
        recentAgents,
        recentFranchises,
        recentInvoices,
        recentPayouts,
        emailStats: {
          total: totalEmails,
          sent: sentEmails,
          delivered: sentEmails,
          opened: openedEmails,
          clicked: clickedEmails,
          bounced: bouncedEmails,
        },
        visitorData: formattedVisitorData,
        browserData,
        performanceMetrics: [
          {
            title: 'Bounce Rate Avg',
            value: `${bounceRate}%`,
            change: prevBounceRate > 0 ? `${((parseFloat(bounceRate) - parseFloat(prevBounceRate)) / parseFloat(prevBounceRate) * 100).toFixed(2)}%` : '0%',
            changeType: parseFloat(bounceRate) > parseFloat(prevBounceRate) ? 'positive' : 'negative',
            vsPrev: `VS ${prevBounceRate}% (Prev)`,
          },
          {
            title: 'Page Views Avg',
            value: `${pageViewsRate}%`,
            change: prevPageViewsRate > 0 ? `${((parseFloat(pageViewsRate) - parseFloat(prevPageViewsRate)) / parseFloat(prevPageViewsRate) * 100).toFixed(2)}%` : '0%',
            changeType: parseFloat(pageViewsRate) > parseFloat(prevPageViewsRate) ? 'positive' : 'negative',
            vsPrev: `VS ${prevPageViewsRate}% (Prev)`,
          },
          {
            title: 'Site Impressions Avg',
            value: `${impressionsRate}%`,
            change: prevImpressionsRate > 0 ? `${((parseFloat(impressionsRate) - parseFloat(prevImpressionsRate)) / parseFloat(prevImpressionsRate) * 100).toFixed(2)}%` : '0%',
            changeType: parseFloat(impressionsRate) > parseFloat(prevImpressionsRate) ? 'positive' : 'negative',
            vsPrev: `VS ${prevImpressionsRate}% (Prev)`,
          },
          {
            title: 'Conversions Rate Avg',
            value: `${conversionRate}%`,
            change: prevConversionRate > 0 ? `${((parseFloat(conversionRate) - parseFloat(prevConversionRate)) / parseFloat(prevConversionRate) * 100).toFixed(2)}%` : '0%',
            changeType: parseFloat(conversionRate) > parseFloat(prevConversionRate) ? 'positive' : 'negative',
            vsPrev: `VS ${prevConversionRate}% (Prev)`,
          },
        ],
      },
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Get accounts dashboard data
 */
export const getAccountsDashboard = async (req, res, next) => {
  try {
    const accountScopes =
      req.user.role === 'accounts_manager' ? await getAccountsManagerDashboardScopes(req) : null;

    if (accountScopes?.isEmpty) {
      return res.status(200).json({
        success: true,
        data: {
          totalLeads: 0,
          verifiedLeads: 0,
          disbursedCases: 0,
          activeAgents: 0,
          totalFranchises: 0,
          activeRelationshipManagers: 0,
          totalInvoices: 0,
          totalRevenue: 0,
          totalLoanAmount: 0,
          advancePaymentCount: 0,
          advancePaymentPendingAmount: 0,
          totalPendingPayoutAmount: 0,
          loanDistribution: [],
          funnelData: [],
          recentLeads: [],
          recentAgents: [],
        },
      });
    }

    const scoped = accountScopes && !accountScopes.isEmpty;
    const leadMatch = scoped ? accountScopes.leadMatch : {};
    const invoiceMatch = scoped ? accountScopes.invoiceMatch : {};
    const franchiseMatch = scoped ? accountScopes.franchiseMatch : { status: 'active' };
    const payoutMatch = scoped ? accountScopes.payoutMatch : {};
    const activeAgentsMatch = scoped ? accountScopes.activeAgentsMatch : { role: 'agent', status: 'active' };
    const recentAgentsMatch = scoped ? accountScopes.recentAgentsMatch : { role: 'agent' };
    const rmUserCountMatch = scoped ? accountScopes.rmUserCountMatch : { role: 'relationship_manager', status: 'active' };

    // 1. Core Counts (accounts_manager: only data under Regional Managers assigned to this user)
    const totalLeads = await Lead.countDocuments(leadMatch);
    const verifiedLeads = await Lead.countDocuments({ ...leadMatch, verificationStatus: 'verified' });
    const disbursedCases = await Lead.countDocuments({
      ...leadMatch,
      status: { $in: ['disbursed', 'partial_disbursed', 'completed'] },
    });
    const activeAgents = await User.countDocuments(activeAgentsMatch);
    const totalFranchises = await Franchise.countDocuments(franchiseMatch);
    const activeRelationshipManagers = await User.countDocuments(rmUserCountMatch);
    const totalInvoices = await Invoice.countDocuments(invoiceMatch);

    // 2. Revenue (Commission Sum)
    const commissionAggregation = await Invoice.aggregate([
      ...(scoped ? [{ $match: invoiceMatch }] : []),
      { $group: { _id: null, total: { $sum: '$commissionAmount' } } },
    ]);
    const totalRevenue = commissionAggregation[0]?.total || 0;

    const pendingPayoutAggregation = await Payout.aggregate([
      { $match: scoped ? { ...payoutMatch, status: 'pending' } : { status: 'pending' } },
      { $group: { _id: null, total: { $sum: '$netPayable' } } },
    ]);
    const totalPendingPayoutAmount = pendingPayoutAggregation[0]?.total || 0;

    // 3. Loan Distribution (count + total loan amount per type)
    const loanDistributionAgg = await Lead.aggregate([
      ...(scoped ? [{ $match: leadMatch }] : []),
      {
        $group: {
          _id: '$loanType',
          count: { $sum: 1 },
          totalAmount: { $sum: '$loanAmount' },
        },
      },
      { $sort: { count: -1 } },
    ]);
    const totalForLoan = loanDistributionAgg.reduce((s, i) => s + i.count, 0) || 1;
    const loanTypeLabels = {
      personal_loan: 'Personal Loan',
      home_loan: 'Home Loan',
      business_loan: 'Business Loan',
      loan_against_property: 'Loan Against Property',
      education_loan: 'Education Loan',
      car_loan: 'Car Loan',
      gold_loan: 'Gold Loan',
    };
    const loanDistributionColors = ['#f97316', '#3b82f6', '#1e40af', '#22c55e', '#84cc16', '#eab308', '#a855f7'];
    const loanDistribution = loanDistributionAgg.map((item, idx) => ({
      name: loanTypeLabels[item._id] || item._id || 'Other',
      value: Math.round((item.count / totalForLoan) * 100),
      count: item.count,
      totalAmount: item.totalAmount || 0,
      color: loanDistributionColors[idx % loanDistributionColors.length],
    }));

    // 3b. Overall total loan amount for all leads
    const totalLoanAmountAgg = await Lead.aggregate([
      ...(scoped ? [{ $match: leadMatch }] : []),
      { $group: { _id: null, total: { $sum: '$loanAmount' } } },
    ]);
    const totalLoanAmount = totalLoanAmountAgg[0]?.total || 0;

    // 3c. Advance Payment Stats
    const { advancePaymentCount, advancePaymentPendingAmount } = await getAdvancePaymentStats({
      leadMatch: scoped ? leadMatch : {},
    });

    // 4. Lead Funnel
    // Get funnel period filter from query params (weekly, monthly, yearly)
    const funnelPeriod = req.query.funnelPeriod || 'monthly';
    const now = new Date();
    let dateFilter = {};
    
    if (funnelPeriod === 'weekly') {
      const weekAgo = new Date(now);
      weekAgo.setDate(weekAgo.getDate() - 7);
      dateFilter = { createdAt: { $gte: weekAgo } };
    } else if (funnelPeriod === 'monthly') {
      const monthAgo = new Date(now);
      monthAgo.setMonth(monthAgo.getMonth() - 1);
      dateFilter = { createdAt: { $gte: monthAgo } };
    } else if (funnelPeriod === 'yearly') {
      const yearAgo = new Date(now);
      yearAgo.setFullYear(yearAgo.getFullYear() - 1);
      dateFilter = { createdAt: { $gte: yearAgo } };
    }

    const funnelSteps = ['logged', 'sanctioned', 'disbursed', 'completed', 'rejected'];
    const funnelMap = {
      logged: 'Logged',
      sanctioned: 'Sanctioned',
      disbursed: 'Disbursed',
      completed: 'Completed',
      rejected: 'Rejected'
    };
    const funnelColors = ['#f97316', '#84cc16', '#3b82f6', '#ea580c', '#dc2626'];

    const funnelData = await Promise.all(funnelSteps.map(async (step, idx) => {
      const agg = await Lead.aggregate([
        { $match: { ...leadMatch, status: step, ...dateFilter } },
        { $group: { _id: null, totalAmount: { $sum: '$loanAmount' } } }
      ]);
      return {
        name: funnelMap[step],
        value: agg[0]?.totalAmount || 0,
        fill: funnelColors[idx]
      };
    }));

    // 5. Recent Items
    const recentLeads = await Lead.find(leadMatch)
      .select('customerName applicantMobile loanAmount status createdAt')
      .sort({ createdAt: -1 })
      .limit(5);

    const recentAgents = await User.find(recentAgentsMatch)
      .select('name email status profileImage createdAt')
      .sort({ createdAt: -1 })
      .limit(5);

    res.status(200).json({
      success: true,
      data: {
        totalLeads,
        verifiedLeads,
        disbursedCases,
        activeAgents,
        totalFranchises,
        activeRelationshipManagers,
        totalInvoices,
        totalRevenue,
        totalLoanAmount,
        advancePaymentCount,
        advancePaymentPendingAmount,
        totalPendingPayoutAmount,
        loanDistribution,
        funnelData,
        recentLeads: recentLeads.map(l => ({
          id: l._id,
          name: l.customerName || 'No Name',
          amount: `₹${(l.loanAmount || 0).toLocaleString()}`,
          status: l.status.charAt(0) + l.status.slice(1),
          date: new Date(l.createdAt).toLocaleDateString('en-IN', { month: 'short', day: 'numeric', year: 'numeric' })
        })),
        recentAgents: recentAgents.map(a => ({
          name: a.name,
          email: a.email,
          status: a.status,
          avatar: a.profileImage || `https://ui-avatars.com/api/?name=${encodeURIComponent(a.name)}&background=random`
        })),
      },
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Get admin dashboard data (scoped by franchises for regional_manager)
 */
export const getAdminDashboard = async (req, res, next) => {
  try {
    const isRegionalManager = req.user.role === 'regional_manager';
    const franchiseIds = isRegionalManager ? await getRegionalManagerFranchiseIds(req) : null;
    
    // For regional managers, also get Relationship Manager IDs they manage
    let rmIds = [];
    if (isRegionalManager) {
      const RelationshipManager = (await import('../models/relationship.model.js')).default;
      rmIds = await RelationshipManager.find({ regionalManager: req.user._id }).distinct('_id');
    }
    
    // Build proper lead match query for regional managers (leads use associated/associatedModel, not franchise)
    let leadMatch = {};
    if (isRegionalManager) {
      if (franchiseIds?.length || rmIds.length) {
        leadMatch = {
          $or: [
            ...(franchiseIds?.length ? [{ associated: { $in: franchiseIds }, associatedModel: 'Franchise' }] : []),
            ...(rmIds.length ? [{ associated: { $in: rmIds }, associatedModel: 'RelationshipManager' }] : [])
          ]
        };
      } else {
        leadMatch = { _id: null }; // No accessible data
      }
    }
    
    const franchiseMatch =
      franchiseIds?.length ? { franchise: { $in: franchiseIds } } : isRegionalManager ? { _id: null } : {};

    const totalLeads = isRegionalManager ? await Lead.countDocuments(leadMatch) : await Lead.countDocuments(franchiseMatch);
    
    // For regional managers, count agents managed by their franchises or relationship managers
    let totalAgents = 0;
    if (isRegionalManager) {
      const agentQuery = {
        role: 'agent',
        status: 'active',
      };
      if (franchiseIds?.length || rmIds.length) {
        agentQuery.$or = [
          ...(franchiseIds?.length ? [{ managedByModel: 'Franchise', managedBy: { $in: franchiseIds } }] : []),
          ...(rmIds.length ? [{ managedByModel: 'RelationshipManager', managedBy: { $in: rmIds } }] : [])
        ];
      } else {
        agentQuery._id = null; // No accessible agents
      }
      totalAgents = await User.countDocuments(agentQuery);
    } else {
      totalAgents = await User.countDocuments({
      role: 'agent',
      status: 'active',
      ...(franchiseMatch.franchise && { franchise: franchiseMatch.franchise }),
    });
    }
    const totalFranchises = isRegionalManager
      ? await Franchise.countDocuments({ status: 'active', regionalManager: req.user._id })
      : await Franchise.countDocuments({ status: 'active' });
    // For regional managers, query invoices by franchise
    let totalInvoices = 0;
    if (isRegionalManager) {
      if (franchiseIds?.length) {
        totalInvoices = await Invoice.countDocuments({ franchise: { $in: franchiseIds } });
      } else {
        totalInvoices = 0;
      }
    } else {
      totalInvoices = franchiseMatch.franchise
        ? await Invoice.countDocuments({ franchise: franchiseMatch.franchise })
          : await Invoice.countDocuments();
    }

    const commissionAggregation = await Invoice.aggregate([
      ...(isRegionalManager && franchiseIds?.length ? [{ $match: { franchise: { $in: franchiseIds } } }] : []),
      ...(!isRegionalManager && franchiseMatch.franchise ? [{ $match: { franchise: { $in: franchiseIds } } }] : []),
      ...(isRegionalManager && !franchiseIds?.length ? [{ $match: { _id: null } }] : []),
      { $group: { _id: null, total: { $sum: '$commissionAmount' } } },
    ]);
    const totalCommission = commissionAggregation[0]?.total || 0;

    const payoutAggregation = await Payout.aggregate([
      {
        $match: {
          status: { $in: ['complete', 'payment_received'] },
          ...(isRegionalManager && franchiseIds?.length ? { franchise: { $in: franchiseIds } } : {}),
          ...(!isRegionalManager && franchiseMatch.franchise ? { franchise: { $in: franchiseIds } } : {}),
          ...(isRegionalManager && !franchiseIds?.length ? { _id: null } : {}),
        },
      },
      { $group: { _id: null, total: { $sum: '$netPayable' } } },
    ]);
    const totalPayouts = payoutAggregation[0]?.total || 0;

    const leadStatusBreakdown = await Lead.aggregate([
      ...(isRegionalManager && Object.keys(leadMatch).length ? [{ $match: leadMatch }] : []),
      ...(!isRegionalManager && franchiseMatch.franchise ? [{ $match: { associated: { $in: franchiseIds }, associatedModel: 'Franchise' } }] : []),
      { $group: { _id: '$status', count: { $sum: 1 } } },
    ]);

    const loanDistributionAgg = await Lead.aggregate([
      ...(isRegionalManager && Object.keys(leadMatch).length ? [{ $match: { ...leadMatch, loanType: { $exists: true, $ne: null } } }] : []),
      ...(!isRegionalManager && franchiseMatch.franchise ? [{ $match: { associated: { $in: franchiseIds }, associatedModel: 'Franchise', loanType: { $exists: true, $ne: null } } }] : []),
      {
        $group: {
          _id: '$loanType',
          count: { $sum: 1 },
          totalAmount: { $sum: '$loanAmount' },
        },
      },
      { $sort: { count: -1 } },
    ]);
    const totalForLoan = loanDistributionAgg.reduce((s, i) => s + i.count, 0) || 1;
    const loanTypeLabels = {
      personal_loan: 'Personal Loan',
      home_loan: 'Home Loan',
      business_loan: 'Business Loan',
      loan_against_property: 'Loan Against Property',
      education_loan: 'Education Loan',
      car_loan: 'Car Loan',
      gold_loan: 'Gold Loan',
    };
    const loanDistributionColors = ['#f97316', '#3b82f6', '#1e40af', '#22c55e', '#84cc16', '#eab308', '#a855f7'];
    const loanDistributionRaw = loanDistributionAgg.map((item, idx) => ({
      name: loanTypeLabels[item._id] || item._id,
      value: Math.round((item.count / totalForLoan) * 100),
      count: item.count,
      totalAmount: item.totalAmount || 0,
      color: loanDistributionColors[idx % loanDistributionColors.length],
    }));
    const sumPct = loanDistributionRaw.reduce((s, i) => s + i.value, 0);
    const loanDistribution = loanDistributionRaw.map((item, idx) => ({
      ...item,
      value: idx === 0 ? item.value + (100 - sumPct) : item.value,
    }));

    const totalLoanAmountAgg = await Lead.aggregate([
      ...(isRegionalManager && Object.keys(leadMatch).length ? [{ $match: leadMatch }] : []),
      ...(!isRegionalManager && Object.keys(franchiseMatch).length ? [{ $match: { associated: { $in: franchiseIds }, associatedModel: 'Franchise' } }] : []),
      { $group: { _id: null, total: { $sum: '$loanAmount' } } },
    ]);
    const totalLoanAmount = totalLoanAmountAgg[0]?.total || 0;

    // Get funnel period filter from query params (weekly, monthly, yearly)
    const funnelPeriod = req.query.funnelPeriod || 'monthly';
    const now = new Date();
    let dateFilter = {};
    
    if (funnelPeriod === 'weekly') {
      const weekAgo = new Date(now);
      weekAgo.setDate(weekAgo.getDate() - 7);
      dateFilter = { createdAt: { $gte: weekAgo } };
    } else if (funnelPeriod === 'monthly') {
      const monthAgo = new Date(now);
      monthAgo.setMonth(monthAgo.getMonth() - 1);
      dateFilter = { createdAt: { $gte: monthAgo } };
    } else if (funnelPeriod === 'yearly') {
      const yearAgo = new Date(now);
      yearAgo.setFullYear(yearAgo.getFullYear() - 1);
      dateFilter = { createdAt: { $gte: yearAgo } };
    }

    // Combine lead match with date filter for regional managers, or franchise match for others
    const funnelMatch = isRegionalManager 
      ? { ...leadMatch, ...dateFilter }
      : { ...franchiseMatch, ...dateFilter };

    // Calculate total amounts for each funnel stage instead of counts
    // For regional managers, use leadMatch; for others, use proper associated query
    const baseFunnelMatch = isRegionalManager 
      ? leadMatch 
      : (franchiseMatch.franchise ? { associated: { $in: franchiseIds }, associatedModel: 'Franchise' } : {});
    
    const loggedAgg = await Lead.aggregate([
      { $match: { ...baseFunnelMatch, ...dateFilter, status: 'logged' } },
      { $group: { _id: null, totalAmount: { $sum: '$loanAmount' } } }
    ]);
    const sanctionedAgg = await Lead.aggregate([
      { $match: { ...baseFunnelMatch, ...dateFilter, status: 'sanctioned' } },
      { $group: { _id: null, totalAmount: { $sum: '$loanAmount' } } }
    ]);
    const disbursedAgg = await Lead.aggregate([
      { $match: { ...baseFunnelMatch, ...dateFilter, status: { $in: ['partial_disbursed', 'disbursed'] } } },
      { $group: { _id: null, totalAmount: { $sum: '$loanAmount' } } }
    ]);
    const completedAgg = await Lead.aggregate([
      { $match: { ...baseFunnelMatch, ...dateFilter, status: 'completed' } },
      { $group: { _id: null, totalAmount: { $sum: '$loanAmount' } } }
    ]);
    const rejectedAgg = await Lead.aggregate([
      { $match: { ...baseFunnelMatch, ...dateFilter, status: 'rejected' } },
      { $group: { _id: null, totalAmount: { $sum: '$loanAmount' } } }
    ]);
    
    const leadConversionFunnel = [
      { stage: 'Logged', value: loggedAgg[0]?.totalAmount || 0, fill: '#f97316' },
      { stage: 'Sanctioned', value: sanctionedAgg[0]?.totalAmount || 0, fill: '#84cc16' },
      { stage: 'Disbursed', value: disbursedAgg[0]?.totalAmount || 0, fill: '#3b82f6' },
      { stage: 'Completed', value: completedAgg[0]?.totalAmount || 0, fill: '#ea580c' },
      { stage: 'Rejected', value: rejectedAgg[0]?.totalAmount || 0, fill: '#b91c1c' },
    ];

    const recentLeadsQuery = isRegionalManager 
      ? leadMatch 
      : (franchiseMatch.franchise ? { associated: { $in: franchiseIds }, associatedModel: 'Franchise' } : franchiseMatch);
    const recentLeads = await Lead.find(recentLeadsQuery)
      .populate('agent', 'name email')
      .populate('associated', 'name')
      .populate('referralFranchise', 'name')
      .populate('bank', 'name')
      .sort({ createdAt: -1 })
      .limit(5);

    // For regional managers, get agents from their franchises or relationship managers
    let recentAgentsQuery = {
      role: 'agent',
    };
    if (isRegionalManager) {
      if (franchiseIds?.length || rmIds.length) {
        recentAgentsQuery.$or = [
          ...(franchiseIds?.length ? [{ managedByModel: 'Franchise', managedBy: { $in: franchiseIds } }] : []),
          ...(rmIds.length ? [{ managedByModel: 'RelationshipManager', managedBy: { $in: rmIds } }] : [])
        ];
      } else {
        recentAgentsQuery._id = null; // No accessible agents
      }
    } else {
      recentAgentsQuery = {
      role: 'agent',
      ...(franchiseMatch.franchise && { franchise: franchiseMatch.franchise }),
    };
    }
    const recentAgents = await User.find(recentAgentsQuery)
      .select('name email mobile status createdAt')
      .populate('franchise', 'name')
      .sort({ createdAt: -1 })
      .limit(5);

    const recentFranchisesQuery = isRegionalManager
      ? { regionalManager: req.user._id }
      : {};
    const recentFranchises = await Franchise.find(recentFranchisesQuery)
      .select('name ownerName email mobile status createdAt')
      .sort({ createdAt: -1 })
      .limit(5);

    const recentInvoicesFilter = isRegionalManager
      ? (franchiseIds?.length ? { franchise: { $in: franchiseIds } } : { _id: null })
      : (franchiseMatch.franchise ? { franchise: franchiseMatch.franchise } : {});
    const recentInvoices = await Invoice.find(recentInvoicesFilter)
      .populate('agent', 'name email')
      .populate('franchise', 'name')
      .select('invoiceNumber amount commissionAmount status createdAt')
      .sort({ createdAt: -1 })
      .limit(5);

    const recentPayoutsFilter = isRegionalManager
      ? (franchiseIds?.length ? { franchise: { $in: franchiseIds } } : { _id: null })
      : (franchiseMatch.franchise ? { franchise: franchiseMatch.franchise } : {});
    const recentPayouts = await Payout.find(recentPayoutsFilter)
      .populate('agent', 'name email')
      .populate('franchise', 'name')
      .select('payoutNumber netPayable status createdAt')
      .sort({ createdAt: -1 })
      .limit(5);

    // Email Statistics
    const totalEmails = await EmailLog.countDocuments();
    const sentEmails = await EmailLog.countDocuments({ status: 'sent' });
    const deliveredEmails = await EmailLog.countDocuments({ status: 'sent' }); // Assuming sent = delivered
    const bouncedEmails = await EmailLog.countDocuments({ status: 'bounced' });
    const failedEmails = await EmailLog.countDocuments({ status: 'failed' });

    // Calculate email opened/clicked (if tracking is implemented)
    // For now, estimate based on sent emails
    const openedEmails = Math.floor(sentEmails * 0.49); // ~49% open rate estimate
    const clickedEmails = Math.floor(sentEmails * 0.25); // ~25% click rate estimate

    const sevenMonthsAgo = new Date();
    sevenMonthsAgo.setMonth(sevenMonthsAgo.getMonth() - 7);

    const visitorDataMatch = isRegionalManager
      ? { ...leadMatch, createdAt: { $gte: sevenMonthsAgo } }
      : {
      createdAt: { $gte: sevenMonthsAgo },
          ...(franchiseMatch.franchise && { associated: { $in: franchiseIds }, associatedModel: 'Franchise' }),
    };
    const visitorData = await Lead.aggregate([
      { $match: visitorDataMatch },
      {
        $group: {
          _id: {
            year: { $year: '$createdAt' },
            month: { $month: '$createdAt' }
          },
          visitors: { $sum: 1 },
          leads: { $sum: 1 },
          conversions: {
            $sum: {
              $cond: [{ $eq: ['$status', 'completed'] }, 1, 0]
            }
          }
        }
      },
      {
        $sort: { '_id.year': 1, '_id.month': 1 }
      },
      {
        $limit: 7
      }
    ]);

    // Format visitor data with month labels
    const monthNames = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
    const formattedVisitorData = visitorData.map(item => ({
      month: `${monthNames[item._id.month - 1]}/${String(item._id.year).slice(-2)}`,
      visitors: item.visitors,
      leads: item.leads,
      conversions: item.conversions
    }));

    // Performance Metrics
    const totalLeadsCount = totalLeads;
    const completedLeadsCount = await Lead.countDocuments({ status: 'completed' });
    const activeLeadsCount = await Lead.countDocuments({ status: 'active' });
    const verifiedLeadsCount = await Lead.countDocuments({ verificationStatus: 'verified' });

    // Calculate metrics
    const bounceRate = totalLeadsCount > 0
      ? ((totalLeadsCount - completedLeadsCount) / totalLeadsCount * 100).toFixed(2)
      : 0;

    const pageViewsRate = totalLeadsCount > 0
      ? ((verifiedLeadsCount / totalLeadsCount) * 100).toFixed(2)
      : 0;

    const impressionsRate = totalLeadsCount > 0
      ? ((activeLeadsCount / totalLeadsCount) * 100).toFixed(2)
      : 0;

    const conversionRate = totalLeadsCount > 0
      ? ((completedLeadsCount / totalLeadsCount) * 100).toFixed(2)
      : 0;

    // Get previous period data for comparison (previous 7 months before current period)
    const previousPeriodStart = new Date(sevenMonthsAgo);
    previousPeriodStart.setMonth(previousPeriodStart.getMonth() - 7);

    const prevMatch = {
      createdAt: { $gte: previousPeriodStart, $lt: sevenMonthsAgo },
      ...(franchiseMatch.franchise && { franchise: { $in: franchiseIds } }),
    };
    const previousPeriodLeads = await Lead.countDocuments(prevMatch);
    const previousPeriodCompleted = await Lead.countDocuments({ ...prevMatch, status: 'completed' });
    const previousPeriodVerified = await Lead.countDocuments({ ...prevMatch, verificationStatus: 'verified' });
    const previousPeriodActive = await Lead.countDocuments({ ...prevMatch, status: 'active' });

    const prevBounceRate = previousPeriodLeads > 0
      ? ((previousPeriodLeads - previousPeriodCompleted) / previousPeriodLeads * 100).toFixed(2)
      : 0;

    const prevPageViewsRate = previousPeriodLeads > 0
      ? ((previousPeriodVerified / previousPeriodLeads) * 100).toFixed(2)
      : 0;

    const prevImpressionsRate = previousPeriodLeads > 0
      ? ((previousPeriodActive / previousPeriodLeads) * 100).toFixed(2)
      : 0;

    const prevConversionRate = previousPeriodLeads > 0
      ? ((previousPeriodCompleted / previousPeriodLeads) * 100).toFixed(2)
      : 0;

    const { advancePaymentCount, advancePaymentPendingAmount } = await getAdvancePaymentStats({
      leadMatch: isRegionalManager ? leadMatch : {},
    });

    // Browser States (simplified - can be enhanced with actual tracking)
    // For now, using distribution based on common browser usage
    const browserData = [
      { name: 'Google Chrome', value: 90, color: '#10b981' },
      { name: 'Mozilla Firefox', value: 76, color: '#3b82f6' },
      { name: 'Apple Safari', value: 50, color: '#f59e0b' },
      { name: 'Edge Browser', value: 20, color: '#10b981' },
      { name: 'Opera Mini', value: 15, color: '#ef4444' },
      { name: 'Internet Explorer', value: 12, color: '#60a5fa' },
      { name: 'Others', value: 6, color: '#9ca3af' },
    ];

    res.status(200).json({
      success: true,
      data: {
        totalLeads,
        totalAgents,
        totalFranchises,
        totalInvoices,
        totalCommission,
        totalPayouts,
        totalRevenue: totalCommission,
        totalLoanAmount,
        advancePaymentCount,
        advancePaymentPendingAmount,
        leadStatusBreakdown,
        loanDistribution,
        leadConversionFunnel,
        recentLeads,
        recentAgents,
        recentFranchises,
        recentInvoices,
        recentPayouts,
        // Email Statistics
        emailStats: {
          total: totalEmails,
          sent: sentEmails,
          delivered: deliveredEmails,
          opened: openedEmails,
          clicked: clickedEmails,
          bounced: bouncedEmails,
        },
        // Visitor Data
        visitorData: formattedVisitorData,
        // Browser Data
        browserData,
        // Performance Metrics
        performanceMetrics: [
          {
            title: 'Bounce Rate Avg',
            value: `${bounceRate}%`,
            change: prevBounceRate > 0 ? `${((parseFloat(bounceRate) - parseFloat(prevBounceRate)) / parseFloat(prevBounceRate) * 100).toFixed(2)}%` : '0%',
            changeType: parseFloat(bounceRate) > parseFloat(prevBounceRate) ? 'positive' : 'negative',
            vsPrev: `VS ${prevBounceRate}% (Prev)`,
          },
          {
            title: 'Page Views Avg',
            value: `${pageViewsRate}%`,
            change: prevPageViewsRate > 0 ? `${((parseFloat(pageViewsRate) - parseFloat(prevPageViewsRate)) / parseFloat(prevPageViewsRate) * 100).toFixed(2)}%` : '0%',
            changeType: parseFloat(pageViewsRate) > parseFloat(prevPageViewsRate) ? 'positive' : 'negative',
            vsPrev: `VS ${prevPageViewsRate}% (Prev)`,
          },
          {
            title: 'Site Impressions Avg',
            value: `${impressionsRate}%`,
            change: prevImpressionsRate > 0 ? `${((parseFloat(impressionsRate) - parseFloat(prevImpressionsRate)) / parseFloat(prevImpressionsRate) * 100).toFixed(2)}%` : '0%',
            changeType: parseFloat(impressionsRate) > parseFloat(prevImpressionsRate) ? 'positive' : 'negative',
            vsPrev: `VS ${prevImpressionsRate}% (Prev)`,
          },
          {
            title: 'Conversions Rate Avg',
            value: `${conversionRate}%`,
            change: prevConversionRate > 0 ? `${((parseFloat(conversionRate) - parseFloat(prevConversionRate)) / parseFloat(prevConversionRate) * 100).toFixed(2)}%` : '0%',
            changeType: parseFloat(conversionRate) > parseFloat(prevConversionRate) ? 'positive' : 'negative',
            vsPrev: `VS ${prevConversionRate}% (Prev)`,
          },
        ],
      },
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Get franchise owner dashboard data (filtered by their franchise)
 */
export const getFranchiseOwnerDashboard = async (req, res, next) => {
  try {
    // Get franchise ID from the authenticated user
    const franchiseId = req.user.franchiseOwned;
    if (!franchiseId) {
      return res.status(400).json({
        success: false,
        message: 'Franchise owner does not have an associated franchise',
      });
    }

    const franchiseObjectId = new mongoose.Types.ObjectId(franchiseId);

    // Total statistics (filtered by franchise)
    const totalLeads = await Lead.countDocuments({ associated: franchiseObjectId, associatedModel: 'Franchise' });
    const totalAgents = await User.countDocuments({ role: 'agent', franchise: franchiseObjectId, status: 'active' });
    const totalInvoices = await Invoice.countDocuments({ franchise: franchiseObjectId });

    // Revenue statistics (filtered by franchise)
    const commissionAggregation = await Invoice.aggregate([
      { $match: { franchise: franchiseObjectId } },
      { $group: { _id: null, total: { $sum: '$commissionAmount' } } },
    ]);
    const totalCommission = commissionAggregation[0]?.total || 0;

    const payoutAggregation = await Payout.aggregate([
      { $match: { franchise: franchiseObjectId, status: { $in: ['complete', 'payment_received'] } } },
      { $group: { _id: null, total: { $sum: '$netPayable' } } },
    ]);
    const totalPayouts = payoutAggregation[0]?.total || 0;

    // Lead status breakdown (filtered by franchise)
    const leadStatusBreakdown = await Lead.aggregate([
      { $match: { franchise: franchiseObjectId } },
      { $group: { _id: '$status', count: { $sum: 1 } } },
    ]);

    // Loan distribution (filtered by franchise)
    const loanDistributionAggF = await Lead.aggregate([
      { $match: { associated: franchiseObjectId, associatedModel: 'Franchise' } },
      { $group: { _id: '$loanType', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
    ]);
    const totalForLoanF = loanDistributionAggF.reduce((s, i) => s + i.count, 0) || 1;
    const loanTypeLabelsF = {
      personal_loan: 'Personal Loan',
      home_loan: 'Home Loan',
      business_loan: 'Business Loan',
      loan_against_property: 'Loan Against Property',
      education_loan: 'Education Loan',
      car_loan: 'Car Loan',
      gold_loan: 'Gold Loan',
    };
    const loanDistributionColorsF = ['#f97316', '#3b82f6', '#1e40af', '#22c55e', '#84cc16', '#eab308', '#a855f7'];
    const loanDistributionRawF = loanDistributionAggF.map((item, idx) => ({
      name: loanTypeLabelsF[item._id] || item._id,
      value: Math.round((item.count / totalForLoanF) * 100),
      count: item.count,
      color: loanDistributionColorsF[idx % loanDistributionColorsF.length],
    }));
    const sumPctF = loanDistributionRawF.reduce((s, i) => s + i.value, 0);
    const loanDistribution = loanDistributionRawF.map((item, idx) => ({
      ...item,
      value: idx === 0 ? item.value + (100 - sumPctF) : item.value,
    }));

    // Lead conversion funnel (filtered by franchise) - Calculate total amounts instead of counts
    const franchiseFunnelMatch = { associated: franchiseObjectId, associatedModel: 'Franchise' };
    
    const loggedAggF = await Lead.aggregate([
      { $match: { ...franchiseFunnelMatch, status: 'logged' } },
      { $group: { _id: null, totalAmount: { $sum: '$loanAmount' } } }
    ]);
    const sanctionedAggF = await Lead.aggregate([
      { $match: { ...franchiseFunnelMatch, status: 'sanctioned' } },
      { $group: { _id: null, totalAmount: { $sum: '$loanAmount' } } }
    ]);
    const disbursedAggF = await Lead.aggregate([
      { $match: { ...franchiseFunnelMatch, status: { $in: ['partial_disbursed', 'disbursed'] } } },
      { $group: { _id: null, totalAmount: { $sum: '$loanAmount' } } }
    ]);
    const completedAggF = await Lead.aggregate([
      { $match: { ...franchiseFunnelMatch, status: 'completed' } },
      { $group: { _id: null, totalAmount: { $sum: '$loanAmount' } } }
    ]);
    const rejectedAggF = await Lead.aggregate([
      { $match: { ...franchiseFunnelMatch, status: 'rejected' } },
      { $group: { _id: null, totalAmount: { $sum: '$loanAmount' } } }
    ]);
    
    const leadConversionFunnel = [
      { stage: 'Logged', value: loggedAggF[0]?.totalAmount || 0, fill: '#f97316' },
      { stage: 'Sanctioned', value: sanctionedAggF[0]?.totalAmount || 0, fill: '#84cc16' },
      { stage: 'Disbursed', value: disbursedAggF[0]?.totalAmount || 0, fill: '#3b82f6' },
      { stage: 'Completed', value: completedAggF[0]?.totalAmount || 0, fill: '#ea580c' },
      { stage: 'Rejected', value: rejectedAggF[0]?.totalAmount || 0, fill: '#b91c1c' },
    ];

    // Recent related lists (filtered by franchise)
    const recentLeads = await Lead.find({ associated: franchiseObjectId, associatedModel: 'Franchise' })
      .populate('agent', 'name email')
      .populate('associated', 'name')
      .populate('referralFranchise', 'name')
      .populate('bank', 'name')
      .sort({ createdAt: -1 })
      .limit(5);

    const recentAgents = await User.find({ role: 'agent', franchise: franchiseObjectId })
      .select('name email mobile status createdAt')
      .populate('franchise', 'name')
      .sort({ createdAt: -1 })
      .limit(5);

    // Get relationship managers (all active relationship managers)
    let relationshipManagers = [];
    try {
      relationshipManagers = await User.find({ role: 'relationship_manager', status: 'active' })
        .select('name email mobile status createdAt')
        .sort({ createdAt: -1 })
        .limit(5);
    } catch (err) {
      console.error('Error fetching relationship managers:', err);
      // Continue without relationship managers data
    }

    const recentInvoices = await Invoice.find({ franchise: franchiseObjectId })
      .populate('agent', 'name email')
      .populate('franchise', 'name')
      .select('invoiceNumber amount commissionAmount status createdAt')
      .sort({ createdAt: -1 })
      .limit(5);

    const recentPayouts = await Payout.find({ franchise: franchiseObjectId })
      .populate('agent', 'name email')
      .populate('franchise', 'name')
      .select('payoutNumber netPayable status createdAt')
      .sort({ createdAt: -1 })
      .limit(5);

    // Email Statistics (filtered by franchise leads)
    const franchiseLeadIds = await Lead.find({ associated: franchiseObjectId, associatedModel: 'Franchise' }).distinct('_id');
    const totalEmails = await EmailLog.countDocuments({ entityType: 'lead', entityId: { $in: franchiseLeadIds } });
    const sentEmails = await EmailLog.countDocuments({ entityType: 'lead', entityId: { $in: franchiseLeadIds }, status: 'sent' });
    const deliveredEmails = await EmailLog.countDocuments({ entityType: 'lead', entityId: { $in: franchiseLeadIds }, status: 'sent' });
    const bouncedEmails = await EmailLog.countDocuments({ entityType: 'lead', entityId: { $in: franchiseLeadIds }, status: 'bounced' });
    const failedEmails = await EmailLog.countDocuments({ entityType: 'lead', entityId: { $in: franchiseLeadIds }, status: 'failed' });

    const openedEmails = Math.floor(sentEmails * 0.49);
    const clickedEmails = Math.floor(sentEmails * 0.25);

    // Visitor/Lead Data (Monthly aggregation for last 7 months, filtered by franchise)
    const sevenMonthsAgo = new Date();
    sevenMonthsAgo.setMonth(sevenMonthsAgo.getMonth() - 7);

    const visitorData = await Lead.aggregate([
      {
        $match: {
          associated: franchiseObjectId,
          associatedModel: 'Franchise',
          createdAt: { $gte: sevenMonthsAgo }
        }
      },
      {
        $group: {
          _id: {
            year: { $year: '$createdAt' },
            month: { $month: '$createdAt' }
          },
          visitors: { $sum: 1 },
          leads: { $sum: 1 },
          conversions: {
            $sum: {
              $cond: [{ $eq: ['$status', 'completed'] }, 1, 0]
            }
          }
        }
      },
      {
        $sort: { '_id.year': 1, '_id.month': 1 }
      },
      {
        $limit: 7
      }
    ]);

    const monthNames = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
    const formattedVisitorData = visitorData.map(item => ({
      month: `${monthNames[item._id.month - 1]}/${String(item._id.year).slice(-2)}`,
      visitors: item.visitors,
      leads: item.leads,
      conversions: item.conversions
    }));

    // Performance Metrics (filtered by franchise)
    const totalLeadsCount = totalLeads;
    const completedLeadsCount = await Lead.countDocuments({ associated: franchiseObjectId, associatedModel: 'Franchise', status: 'completed' });
    const activeLeadsCount = await Lead.countDocuments({ associated: franchiseObjectId, associatedModel: 'Franchise', status: 'active' });
    const verifiedLeadsCount = await Lead.countDocuments({ associated: franchiseObjectId, associatedModel: 'Franchise', verificationStatus: 'verified' });

    const bounceRate = totalLeadsCount > 0
      ? ((totalLeadsCount - completedLeadsCount) / totalLeadsCount * 100).toFixed(2)
      : 0;

    const pageViewsRate = totalLeadsCount > 0
      ? ((verifiedLeadsCount / totalLeadsCount) * 100).toFixed(2)
      : 0;

    const impressionsRate = totalLeadsCount > 0
      ? ((activeLeadsCount / totalLeadsCount) * 100).toFixed(2)
      : 0;

    const conversionRate = totalLeadsCount > 0
      ? ((completedLeadsCount / totalLeadsCount) * 100).toFixed(2)
      : 0;

    // Get previous period data for comparison
    const previousPeriodStart = new Date(sevenMonthsAgo);
    previousPeriodStart.setMonth(previousPeriodStart.getMonth() - 7);

    const previousPeriodLeads = await Lead.countDocuments({
      associated: franchiseObjectId,
      associatedModel: 'Franchise',
      createdAt: { $gte: previousPeriodStart, $lt: sevenMonthsAgo }
    });
    const previousPeriodCompleted = await Lead.countDocuments({
      associated: franchiseObjectId,
      associatedModel: 'Franchise',
      createdAt: { $gte: previousPeriodStart, $lt: sevenMonthsAgo },
      status: 'completed'
    });
    const previousPeriodVerified = await Lead.countDocuments({
      associated: franchiseObjectId,
      associatedModel: 'Franchise',
      createdAt: { $gte: previousPeriodStart, $lt: sevenMonthsAgo },
      verificationStatus: 'verified'
    });
    const previousPeriodActive = await Lead.countDocuments({
      associated: franchiseObjectId,
      associatedModel: 'Franchise',
      createdAt: { $gte: previousPeriodStart, $lt: sevenMonthsAgo },
      status: 'active'
    });

    const prevBounceRate = previousPeriodLeads > 0
      ? ((previousPeriodLeads - previousPeriodCompleted) / previousPeriodLeads * 100).toFixed(2)
      : 0;

    const prevPageViewsRate = previousPeriodLeads > 0
      ? ((previousPeriodVerified / previousPeriodLeads) * 100).toFixed(2)
      : 0;

    const prevImpressionsRate = previousPeriodLeads > 0
      ? ((previousPeriodActive / previousPeriodLeads) * 100).toFixed(2)
      : 0;

    const prevConversionRate = previousPeriodLeads > 0
      ? ((previousPeriodCompleted / previousPeriodLeads) * 100).toFixed(2)
      : 0;

    const browserData = [
      { name: 'Google Chrome', value: 90, color: '#10b981' },
      { name: 'Mozilla Firefox', value: 76, color: '#3b82f6' },
      { name: 'Apple Safari', value: 50, color: '#f59e0b' },
      { name: 'Edge Browser', value: 20, color: '#10b981' },
      { name: 'Opera Mini', value: 15, color: '#ef4444' },
      { name: 'Internet Explorer', value: 12, color: '#60a5fa' },
      { name: 'Others', value: 6, color: '#9ca3af' },
    ];

    res.status(200).json({
      success: true,
      data: {
        totalLeads,
        totalAgents,
        totalFranchises: 1, // Only their own franchise
        totalInvoices,
        totalCommission,
        totalPayouts,
        totalRevenue: totalCommission,
        leadStatusBreakdown,
        loanDistribution,
        leadConversionFunnel,
        recentLeads,
        recentAgents,
        relationshipManagers, // Relationship managers assigned to handle franchises
        recentInvoices,
        recentPayouts,
        emailStats: {
          total: totalEmails,
          sent: sentEmails,
          delivered: deliveredEmails,
          opened: openedEmails,
          clicked: clickedEmails,
          bounced: bouncedEmails,
        },
        visitorData: formattedVisitorData,
        browserData,
        performanceMetrics: [
          {
            title: 'Bounce Rate Avg',
            value: `${bounceRate}%`,
            change: prevBounceRate > 0 ? `${((parseFloat(bounceRate) - parseFloat(prevBounceRate)) / parseFloat(prevBounceRate) * 100).toFixed(2)}%` : '0%',
            changeType: parseFloat(bounceRate) > parseFloat(prevBounceRate) ? 'positive' : 'negative',
            vsPrev: `VS ${prevBounceRate}% (Prev)`,
          },
          {
            title: 'Page Views Avg',
            value: `${pageViewsRate}%`,
            change: prevPageViewsRate > 0 ? `${((parseFloat(pageViewsRate) - parseFloat(prevPageViewsRate)) / parseFloat(prevPageViewsRate) * 100).toFixed(2)}%` : '0%',
            changeType: parseFloat(pageViewsRate) > parseFloat(prevPageViewsRate) ? 'positive' : 'negative',
            vsPrev: `VS ${prevPageViewsRate}% (Prev)`,
          },
          {
            title: 'Site Impressions Avg',
            value: `${impressionsRate}%`,
            change: prevImpressionsRate > 0 ? `${((parseFloat(impressionsRate) - parseFloat(prevImpressionsRate)) / parseFloat(prevImpressionsRate) * 100).toFixed(2)}%` : '0%',
            changeType: parseFloat(impressionsRate) > parseFloat(prevImpressionsRate) ? 'positive' : 'negative',
            vsPrev: `VS ${prevImpressionsRate}% (Prev)`,
          },
          {
            title: 'Conversions Rate Avg',
            value: `${conversionRate}%`,
            change: prevConversionRate > 0 ? `${((parseFloat(conversionRate) - parseFloat(prevConversionRate)) / parseFloat(prevConversionRate) * 100).toFixed(2)}%` : '0%',
            changeType: parseFloat(conversionRate) > parseFloat(prevConversionRate) ? 'positive' : 'negative',
            vsPrev: `VS ${prevConversionRate}% (Prev)`,
          },
        ],
      },
    });
  } catch (error) {
    next(error);
  }
};
