import mongoose from 'mongoose';

/**
 * Invoice Model
 * Tracks commission invoices generated from completed cases
 * Supports invoice approval workflow with escalation handling
 */
const invoiceSchema = new mongoose.Schema(
  {
    invoiceNumber: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },

    lead: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Lead',
      required: true,
      index: true,
    },

    // Optional: link invoice to a specific disbursement (for partial disbursement invoicing)
    disbursementId: {
      type: mongoose.Schema.Types.Mixed, // can be ObjectId from subdoc _id
      default: null,
      index: true,
    },

    disbursementAmount: {
      type: Number,
      default: null,
    },

    commissionRate: {
      type: Number,
      default: null,
    },

    agent: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },

    // Sub-agent reference (optional, for split invoices)
    subAgent: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      index: true,
    },

    franchise: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Franchise',
      required: true,
    },

    // Flag to identify referral franchise invoices
    isReferralFranchise: {
      type: Boolean,
      default: false,
      index: true,
    },

    // Invoice type: 'agent', 'sub_agent', or 'franchise'
    invoiceType: {
      type: String,
      enum: ['agent', 'sub_agent', 'franchise'],
      default: 'agent',
      index: true,
    },

    // Commission details
    commissionAmount: {
      type: Number,
      required: true,
    },

    tdsAmount: {
      type: Number,
      default: 0,
    },

    tdsPercentage: {
      type: Number,
      default: 2, // 2% TDS
    },

    // GST = 18% of Taxable (commission). Gross = Taxable + GST - TDS
    gstAmount: {
      type: Number,
      default: 0,
    },

    netPayable: {
      type: Number,
      required: true,
    },

    // Invoice status workflow
    status: {
      type: String,
      enum: ['draft', 'pending', 'approved', 'rejected', 'escalated', 'gst_paid', 'paid', 'regular_paid'],
      default: 'pending',
      index: true,
    },

    // Escalation details
    isEscalated: {
      type: Boolean,
      default: false,
    },

    escalationReason: String,
    escalationRemarks: String,
    escalatedAt: Date,
    escalatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },

    // Resolution details
    resolutionRemarks: String,
    resolvedAt: Date,
    resolvedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },

    // Approval details
    approvedAt: Date,
    approvedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },

    // Rejection details
    rejectedAt: Date,
    rejectedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
    rejectionReason: String,

    // Agent acceptance
    acceptedAt: Date,
    agentRemarks: String,

    // Invoice date
    invoiceDate: {
      type: Date,
      default: Date.now,
    },

    // Payout reference
    payout: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Payout',
    },
  },
  { timestamps: true }
);

// Indexes for efficient queries
invoiceSchema.index({ agent: 1, status: 1 });
invoiceSchema.index({ subAgent: 1, status: 1 });
invoiceSchema.index({ franchise: 1, status: 1 });
invoiceSchema.index({ status: 1, createdAt: -1 });
invoiceSchema.index({ isEscalated: 1, status: 1 });
invoiceSchema.index({ lead: 1, disbursementId: 1, invoiceType: 1 });

export default mongoose.model('Invoice', invoiceSchema);
