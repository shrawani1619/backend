import mongoose from 'mongoose';
import './agent.model.js';

/**
 Acciojob
 work exp
 crm dashboard
 event management exp
 */
const leadSchema = new mongoose.Schema(
  {
    // Applicant details
    applicantMobile: {
      type: String,
      index: true,
    },

    applicantEmail: String,

    // Loan details
    // loanType is optional for dynamic/custom forms; keep enum for normalization when present
    loanType: {
      type: String,
      enum: ['personal_loan', 'home_loan', 'business_loan',
        'loan_against_property', 'education_loan', 'car_loan', 'gold_loan'],
    },

    // loanAmount is optional for dynamic/custom forms
    loanAmount: {
      type: Number,
    },

    // loanAccountNo is optional for dynamic/custom forms
    loanAccountNo: {
      type: String,
      index: true,
    },

    // Advance payment flag (true/false)
    advancePayment: {
      type: Boolean,
      default: false,
      index: true,
    },

    // References
    agent: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User', // Changed from 'Agent' to 'User' since agents are now stored in User model
      required: true,
      index: true,
    },

    agentName: {
      type: String,
      trim: true,
    },

    // Sub-agent reference (optional)
    subAgent: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      index: true,
    },

    subAgentName: {
      type: String,
      trim: true,
    },

    // (No direct franchise field — use polymorphic `associated` + `associatedModel`)

    // Polymorphic association: can be a Franchise or a RelationshipManager
    associated: {
      type: mongoose.Schema.Types.ObjectId,
      refPath: 'associatedModel',
      index: true,
    },
    associatedModel: {
      type: String,
      enum: ['Franchise', 'RelationshipManager'],
      index: true,
    },

    // Bank is optional at schema level; client-side flow should set bank when using bank-specific forms.
    bank: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Bank',
      index: true,
    },
    bankName: { type: String },

    // Lead type: 'bank' = bank-specific form, 'new_lead' = generic lead (bank can be added later by RM)
    leadType: {
      type: String,
      enum: ['bank', 'new_lead'],
      default: 'bank',
      index: true,
    },

    // Case status workflow
    status: {
      type: String,
      enum: [
        'logged',
        'sanctioned',
        'partial_disbursed',
        'disbursed',
        'completed',
        'rejected',
      ],
      default: 'logged',
      index: true,
    },

    // Sanction and disbursement details
    sanctionedDate: Date,

    disbursedAmount: {
      type: Number,
      default: 0,
    },

    disbursementDate: Date,

    disbursementType: {
      type: String,
      enum: ['full', 'partial'],
    },

    // Disbursement history for partial disbursements
    disbursementHistory: [
      {
        amount: Number,
        date: Date,
        type: {
          type: String,
          enum: ['full', 'partial'],
        },
        utr: String,
        bankRef: String,
        commission: Number,
        gst: Number,
        netCommission: Number,
        remarks: String,
      },
    ],

    // Commission details
    commissionBasis: {
      type: String,
      enum: ['sanctioned', 'disbursed'],
    },

    commissionPercentage: {
      type: Number,
      default: 0,
    },

    commissionAmount: {
      type: Number,
      default: 0,
    },

    // Agent commission fields (for franchise-created leads)
    agentCommissionPercentage: {
      type: Number,
      default: 0,
    },

    agentCommissionAmount: {
      type: Number,
      default: 0,
    },

    // Sub-agent commission fields (for agent-created leads with sub-agents)
    subAgentCommissionPercentage: {
      type: Number,
      default: 0,
    },

    subAgentCommissionAmount: {
      type: Number,
      default: 0,
    },

    // Referral franchise fields (when a franchise refers lead to another franchise)
    referralFranchise: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Franchise',
      index: true,
    },

    referralFranchiseCommissionPercentage: {
      type: Number,
      default: 0,
    },

    referralFranchiseCommissionAmount: {
      type: Number,
      default: 0,
    },

    // Verification workflow
    verificationStatus: {
      type: String,
      enum: ['pending', 'verified', 'rejected'],
      default: 'pending',
      index: true,
    },

    verifiedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },

    verifiedAt: Date,

    // Invoice reference
    invoice: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Invoice',
    },

    isInvoiceGenerated: {
      type: Boolean,
      default: false,
    },

    // Additional details
    remarks: String,

    // Bank coordination
    sentToBankAt: Date,
    bankResponseReceivedAt: Date,

    // Customer Details Form
    // Customer name is optional for dynamic/custom forms; prefer storing in `formValues`
    customerName: {
      type: String,
      trim: true,
      index: true,
    },

    // SM/BM can be either a Staff (login-able) or a BankManager (contact-only).
    // Use polymorphic ref to support both.
    smBm: {
      type: mongoose.Schema.Types.ObjectId,
      refPath: 'smBmModel',
      index: true,
    },
    smBmModel: {
      type: String,
      enum: ['Staff', 'BankManager'],
      index: true,
    },
    smBmEmail: String,
    smBmMobile: String,

    asmName: String,
    asmEmail: String,
    asmMobile: String,

    dsaCode: String,
    branch: String,

    // Dynamic lead form reference (optional) and values submitted against that form
    leadForm: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'LeadForm',
      index: true,
    },
    // Generic container for custom form data. Use Mixed to allow arbitrary shapes.
    formValues: {
      type: mongoose.Schema.Types.Mixed,
    },

    // Documents submitted with lead when using dynamic forms (array of { documentType, url, uploadedBy, uploadedAt })
    documents: [
      {
        documentType: String,
        url: String,
        uploadedBy: {
          type: mongoose.Schema.Types.ObjectId,
          ref: 'User',
        },
        uploadedAt: Date,
      },
    ],
  },
  // Allow storing arbitrary fields for custom lead forms (they'll be stored in `formValues`).
  // Keep timestamps.
  { timestamps: true, strict: false }
);

// Indexes for efficient queries
leadSchema.index({ agent: 1, status: 1 });
leadSchema.index({ associated: 1, status: 1 });
leadSchema.index({ associatedModel: 1, status: 1 });
leadSchema.index({ bank: 1, status: 1 });
leadSchema.index({ verificationStatus: 1 });

export default mongoose.model('Lead', leadSchema);
