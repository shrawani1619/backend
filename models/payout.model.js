import mongoose from 'mongoose';

/**
 * Payout Model
 * Tracks payout processing including bank CSV file generation and payment confirmation
 */
const payoutSchema = new mongoose.Schema(
  {
    payoutNumber: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },

    // Multiple invoices can be included in one payout
    invoices: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Invoice',
        required: true,
      },
    ],

    agent: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User', // Changed from 'Agent' to 'User' since agents are now stored in User model
      required: true,
      index: true,
    },

    franchise: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Franchise',
      required: true,
    },

    // Optional: link payout to a specific lead (manual payouts)
    lead: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Lead',
      index: true,
    },

    // Amount details
    totalAmount: {
      type: Number,
      required: true,
    },

    tdsAmount: {
      type: Number,
      default: 0,
    },

    netPayable: {
      type: Number,
      required: true,
    },

    // Payout status
    status: {
      type: String,
      enum: [
        'pending',
        'gst_pending',
        'gst_received',
        'payment_received',
        'payment_pending',
        'recovery_pending',
        'recovery_received',
        'complete',
      ],
      default: 'pending',
      index: true,
    },

    // Bank CSV file generation
    bankCsvFile: {
      filename: String,
      path: String,
      generatedAt: Date,
      generatedBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
      },
    },

    // Payment confirmation
    paymentConfirmation: {
      transactionId: String,
      transactionDate: Date,
      paymentMethod: String,
      uploadedFile: String,
      confirmedAt: Date,
      confirmedBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
      },
    },

    // Bank details at time of payout
    bankDetails: {
      accountHolderName: String,
      accountNumber: String,
      ifsc: String,
      bankName: String,
    },

    // Recovery tracking
    recoveryAmount: Number,
    recoveryReason: String,
    recoveryStatus: {
      type: String,
      enum: ['none', 'pending', 'completed'],
      default: 'none',
    },

    // Processing details
    processedAt: Date,
    processedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },

    remarks: String,

    // Bank payment receipt (when bank pays to company)
    bankPaymentReceipt: {
      filename: String,
      url: String,
      uploadedAt: Date,
      uploadedBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
      },
    },
  },
  { timestamps: true }
);

// Indexes for efficient queries
payoutSchema.index({ agent: 1, status: 1 });
payoutSchema.index({ franchise: 1, status: 1 });
payoutSchema.index({ status: 1, createdAt: -1 });
payoutSchema.index({ payoutNumber: 1 });

export default mongoose.model('Payout', payoutSchema);
