import payoutService from '../services/payout.service.js';
import { getPaginationMeta } from '../utils/helpers.js';
import Payout from '../models/payout.model.js';
import { getRegionalManagerFranchiseIds, regionalManagerCanAccessFranchise } from '../utils/regionalScope.js';
import mongoose from 'mongoose';

/**
 * Get all payouts
 */
export const getPayouts = async (req, res, next) => {
  try {
    const { page = 1, limit = 10, status, agentId, franchiseId } = req.query;
    const skip = (page - 1) * limit;

    const query = {};

    // Role-based filtering
    if (req.user.role === 'agent') {
      // Agents are stored in User model, so use User._id directly
      query.agent = req.user._id;
    } else if (req.user.role === 'franchise') {
      // Franchise owners should only see payouts from their franchise
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
    }

    if (status) query.status = status;
    if (agentId) query.agent = agentId;
    if (franchiseId && req.user.role !== 'regional_manager') query.franchise = franchiseId;

    const payouts = await Payout.find(query)
      .populate('agent', 'name email mobile')
      .populate('franchise', 'name')
      .populate('invoices')
      // Use lean so if populate doesn't find a document, the original id is still present (helps UI avoid N/A)
      .lean()
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(parseInt(limit));

    const total = await Payout.countDocuments(query);
    const pagination = getPaginationMeta(page, limit, total);

    res.status(200).json({
      success: true,
      data: payouts,
      pagination,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Get payout by ID
 */
export const getPayoutById = async (req, res, next) => {
  try {
    const payout = await payoutService.getPayoutById(req.params.id);

    if (!payout) {
      return res.status(404).json({
        success: false,
        message: 'Payout not found',
      });
    }

    // Role-based access control
    if (req.user.role === 'agent' && payout.agent.toString() !== req.user._id.toString()) {
      return res.status(403).json({
        success: false,
        error: 'Access denied. You can only view your own payouts.',
      });
    }

    if (req.user.role === 'franchise') {
      if (!req.user.franchiseOwned) {
        return res.status(400).json({
          success: false,
          message: 'Franchise owner does not have an associated franchise',
        });
      }
      if (payout.franchise?.toString() !== req.user.franchiseOwned.toString()) {
        return res.status(403).json({
          success: false,
          error: 'Access denied. You can only view payouts from your franchise.',
        });
      }
    }
    if (req.user.role === 'regional_manager') {
      const canAccess = await regionalManagerCanAccessFranchise(req, payout.franchise);
      if (!canAccess) {
        return res.status(403).json({
          success: false,
          error: 'Access denied. You can only view payouts from franchises associated with you.',
        });
      }
    }

    res.status(200).json({
      success: true,
      data: payout,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Process payouts for approved invoices
 */
export const processPayouts = async (req, res, next) => {
  try {
    const { invoiceIds } = req.body;

    if (!invoiceIds || !Array.isArray(invoiceIds) || invoiceIds.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'At least one invoice ID is required',
      });
    }

    if (req.user.role === 'regional_manager') {
      const Invoice = (await import('../models/invoice.model.js')).default;
      const franchiseIds = await getRegionalManagerFranchiseIds(req);
      if (franchiseIds?.length) {
        const invoices = await Invoice.find({ _id: { $in: invoiceIds } }).select('franchise').lean();
        for (const inv of invoices) {
          if (!franchiseIds.some((fid) => fid.toString() === (inv.franchise && inv.franchise.toString()))) {
            return res.status(403).json({
              success: false,
              error: 'Access denied. One or more invoices are not in your scope.',
            });
          }
        }
      }
    }

    const payouts = await payoutService.processPayouts(invoiceIds, req.user._id);

    res.status(200).json({
      success: true,
      message: 'Payouts processed successfully',
      data: payouts,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Generate bank CSV file for payout
 */
export const generateBankCsvFile = async (req, res, next) => {
  try {
    if (req.user.role === 'regional_manager') {
      const p = await Payout.findById(req.params.id).select('franchise');
      if (p && !(await regionalManagerCanAccessFranchise(req, p.franchise))) {
        return res.status(403).json({ success: false, error: 'Access denied.' });
      }
    }
    const payout = await payoutService.generateBankCsvFile(req.params.id, req.user._id);

    res.status(200).json({
      success: true,
      message: 'Bank CSV file generated successfully',
      data: payout,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Confirm payment
 */
export const confirmPayment = async (req, res, next) => {
  try {
    if (req.user.role === 'regional_manager') {
      const p = await Payout.findById(req.params.id).select('franchise');
      if (p && !(await regionalManagerCanAccessFranchise(req, p.franchise))) {
        return res.status(403).json({ success: false, error: 'Access denied.' });
      }
    }
    const { transactionId, transactionDate, paymentMethod, uploadedFile } = req.body;

    if (!transactionId) {
      return res.status(400).json({
        success: false,
        message: 'Transaction ID is required',
      });
    }

    const payout = await payoutService.confirmPayment(
      req.params.id,
      {
        transactionId,
        transactionDate,
        paymentMethod,
        uploadedFile,
      },
      req.user._id
    );

    res.status(200).json({
      success: true,
      message: 'Payment confirmed successfully',
      data: payout,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Create Payout
 */
export const createPayout = async (req, res, next) => {
  try {
    // Only Admin and Accountant can create payouts
    if (req.user.role !== 'super_admin' && req.user.role !== 'accounts_manager') {
      return res.status(403).json({
        success: false,
        error: 'Access denied. Only Admin and Accountant can create payouts.',
      });
    }
    
    if (req.user.role === 'regional_manager' && req.body.franchise) {
      const canAccess = await regionalManagerCanAccessFranchise(req, req.body.franchise);
      if (!canAccess) {
        return res.status(403).json({
          success: false,
          error: 'Access denied. You can only create payouts for franchises associated with you.',
        });
      }
    }
    
    // Handle file upload for bank payment receipt
    let bankPaymentReceipt = null;
    if (req.file) {
      const fileUploadService = (await import('../services/fileUpload.service.js')).default;
      try {
        // Document.entityId expects a valid ObjectId. Use a temporary ObjectId and
        // update it to the payout's _id after payout creation.
        const tempEntityId = new mongoose.Types.ObjectId();
        const document = await fileUploadService.processUploadedFile(req.file, {
          entityType: 'payout',
          entityId: tempEntityId,
          documentType: 'bank_payment_receipt',
          description: 'Bank payment receipt',
          uploadedBy: req.user._id,
        });
        
        bankPaymentReceipt = {
          filename: document.originalFileName,
          url: document.url || `/uploads/documents/${document.fileName}`,
          uploadedAt: new Date(),
          uploadedBy: req.user._id,
        };
      } catch (fileError) {
        console.error('Error processing file upload:', fileError);
        return res.status(400).json({
          success: false,
          error: 'Failed to upload bank payment receipt: ' + fileError.message,
        });
      }
    }
    
    // Generate payoutNumber if not provided
    const { generatePayoutNumber } = await import('../utils/helpers.js');
    const payoutData = {
      ...req.body,
      payoutNumber: req.body.payoutNumber || await generatePayoutNumber(),
      ...(bankPaymentReceipt && { bankPaymentReceipt }),
    };
    // Normalize lead field (frontend may send leadId)
    if (req.body.leadId && !payoutData.lead) {
      payoutData.lead = req.body.leadId;
    }
    delete payoutData.leadId;

    // Parse JSON fields if they're strings
    if (typeof payoutData.invoices === 'string') {
      try {
        payoutData.invoices = JSON.parse(payoutData.invoices);
      } catch (e) {
        payoutData.invoices = [];
      }
    }
    if (typeof payoutData.bankDetails === 'string') {
      try {
        payoutData.bankDetails = JSON.parse(payoutData.bankDetails);
      } catch (e) {
        payoutData.bankDetails = {};
      }
    }

    const payout = await Payout.create(payoutData);

    // Update document entityId if file was uploaded
    if (bankPaymentReceipt && req.file) {
      const Document = (await import('../models/document.model.js')).default;
      await Document.updateOne(
        { url: bankPaymentReceipt.url },
        { entityId: payout._id }
      );
    }

    const populatedPayout = await Payout.findById(payout._id)
      .populate('agent', 'name email mobile')
      .populate('franchise', 'name')
      .populate('lead', 'customerName loanAccountNo leadName formValues')
      .populate('invoices');

    res.status(201).json({
      success: true,
      message: 'Payout created successfully',
      data: populatedPayout,
    });
  } catch (error) {
    console.error('Error creating payout:', error);
    next(error);
  }
};

/**
 * Update Payout
 */
export const updatePayout = async (req, res, next) => {
  try {
    // Only Admin and Accountant can edit payouts
    if (req.user.role !== 'super_admin' && req.user.role !== 'accounts_manager') {
      return res.status(403).json({
        success: false,
        error: 'Access denied. Only Admin and Accountant can edit payouts.',
      });
    }
    
    if (req.user.role === 'regional_manager') {
      const existing = await Payout.findById(req.params.id).select('franchise');
      if (existing && !(await regionalManagerCanAccessFranchise(req, existing.franchise))) {
        return res.status(403).json({ success: false, error: 'Access denied.' });
      }
      if (req.body.franchise && !(await regionalManagerCanAccessFranchise(req, req.body.franchise))) {
        return res.status(403).json({ success: false, error: 'Access denied.' });
      }
    }
    
    // Handle file upload for bank payment receipt if new file is provided
    let bankPaymentReceipt = null;
    if (req.file) {
      const fileUploadService = (await import('../services/fileUpload.service.js')).default;
      try {
        const document = await fileUploadService.processUploadedFile(req.file, {
          entityType: 'payout',
          entityId: req.params.id,
          documentType: 'bank_payment_receipt',
          description: 'Bank payment receipt',
          uploadedBy: req.user._id,
        });
        
        bankPaymentReceipt = {
          filename: document.originalFileName,
          url: document.url || `/uploads/documents/${document.fileName}`,
          uploadedAt: new Date(),
          uploadedBy: req.user._id,
        };
      } catch (fileError) {
        console.error('Error processing file upload:', fileError);
        return res.status(400).json({
          success: false,
          error: 'Failed to upload bank payment receipt: ' + fileError.message,
        });
      }
    }
    
    // Prepare update data
    const updateData = { ...req.body };
    if (req.body.leadId && !updateData.lead) {
      updateData.lead = req.body.leadId;
    }
    delete updateData.leadId;
    
    // Parse JSON fields if they're strings
    if (typeof updateData.invoices === 'string') {
      try {
        updateData.invoices = JSON.parse(updateData.invoices);
      } catch (e) {
        updateData.invoices = [];
      }
    }
    if (typeof updateData.bankDetails === 'string') {
      try {
        updateData.bankDetails = JSON.parse(updateData.bankDetails);
      } catch (e) {
        updateData.bankDetails = {};
      }
    }
    
    // Add bank payment receipt if uploaded
    if (bankPaymentReceipt) {
      updateData.bankPaymentReceipt = bankPaymentReceipt;
    }
    
    const payout = await Payout.findByIdAndUpdate(req.params.id, updateData, {
      new: true,
      runValidators: true,
    })
      .populate('agent', 'name email mobile')
      .populate('franchise', 'name')
      .populate('lead', 'customerName loanAccountNo leadName formValues')
      .populate('invoices');

    if (!payout) {
      return res.status(404).json({
        success: false,
        message: 'Payout not found',
      });
    }

    res.status(200).json({
      success: true,
      message: 'Payout updated successfully',
      data: payout,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Delete Payout
 */
export const deletePayout = async (req, res, next) => {
  try {
    // Only Admin and Accountant can delete payouts
    if (req.user.role !== 'super_admin' && req.user.role !== 'accounts_manager') {
      return res.status(403).json({
        success: false,
        error: 'Access denied. Only Admin and Accountant can delete payouts.',
      });
    }
    
    if (req.user.role === 'regional_manager') {
      const p = await Payout.findById(req.params.id).select('franchise');
      if (p && !(await regionalManagerCanAccessFranchise(req, p.franchise))) {
        return res.status(403).json({ success: false, error: 'Access denied.' });
      }
    }
    const payout = await Payout.findByIdAndDelete(req.params.id);

    if (!payout) {
      return res.status(404).json({
        success: false,
        message: 'Payout not found',
      });
    }

    res.status(200).json({
      success: true,
      message: 'Payout deleted successfully',
    });
  } catch (error) {
    next(error);
  }
};
