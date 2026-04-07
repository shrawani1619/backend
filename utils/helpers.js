import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import SequenceCounter from '../models/sequenceCounter.model.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Indian financial year (April → March), e.g. Apr 2026–Mar 2027 → label "2026/27".
 * @param {Date} d
 * @returns {{ label: string, counterKey: string }}
 */
export function getIndianFinancialYearInvoiceParts(d = new Date()) {
  const y = d.getFullYear();
  const m = d.getMonth(); // 0 = Jan
  // FY starts 1 April
  const fyStartYear = m >= 3 ? y : y - 1;
  const fyEndYear = fyStartYear + 1;
  const endShort = String(fyEndYear % 100).padStart(2, '0');
  const label = `${fyStartYear}/${endShort}`;
  const counterKey = `${fyStartYear}-${fyEndYear}`;
  return { label, counterKey };
}

/**
 * Generate unique invoice number (sequential per financial year).
 * Format: YYYY/YY-NNNNNNN (e.g. 2026/27-0000001, 2026/27-0000002)
 * @returns {Promise<String>} Invoice number
 */
export async function generateInvoiceNumber() {
  const { label, counterKey } = getIndianFinancialYearInvoiceParts(new Date());
  const id = `invoice_${counterKey}`;

  const doc = await SequenceCounter.findByIdAndUpdate(
    id,
    { $inc: { seq: 1 } },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  );

  const n = doc.seq;
  return `${label}-${String(n).padStart(7, '0')}`;
}

/**
 * Generate unique payout number
 * Format: PAY-YYYYMMDD-XXXXX
 * @returns {Promise<String>} Payout number
 */
export async function generatePayoutNumber() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  const random = String(Math.floor(Math.random() * 100000)).padStart(5, '0');
  
  return `PAY-${year}${month}${day}-${random}`;
}

/**
 * Generate bank CSV file for payout
 * @param {Object} payout - Payout object
 * @returns {Promise<Object>} CSV file data
 */
export async function generateBankCsv(payout) {
  try {
    // Create exports directory if it doesn't exist
    const exportsDir = path.join(__dirname, '../exports');
    await fs.mkdir(exportsDir, { recursive: true });

    // CSV format: Account Number, IFSC, Account Holder Name, Amount, Remarks
    const csvRows = [];
    csvRows.push('Account Number,IFSC,Account Holder Name,Amount,Remarks');

    const row = [
      payout.bankDetails.accountNumber || '',
      payout.bankDetails.ifsc || '',
      payout.bankDetails.accountHolderName || '',
      payout.netPayable.toString(),
      `Payout ${payout.payoutNumber}`,
    ];

    csvRows.push(row.join(','));

    const csvContent = csvRows.join('\n');
    const filename = `payout_${payout.payoutNumber}_${Date.now()}.csv`;
    const filePath = path.join(exportsDir, filename);

    await fs.writeFile(filePath, csvContent, 'utf8');

    return {
      path: filePath,
      filename: filename,
      content: csvContent,
    };
  } catch (error) {
    throw new Error(`Error generating CSV file: ${error.message}`);
  }
}

/**
 * Calculate pagination metadata
 * @param {Number} page - Current page
 * @param {Number} limit - Items per page
 * @param {Number} total - Total items
 * @returns {Object} Pagination metadata
 */
export function getPaginationMeta(page, limit, total) {
  const currentPage = parseInt(page) || 1;
  const itemsPerPage = parseInt(limit) || 10;
  const totalItems = parseInt(total) || 0;
  const totalPages = Math.ceil(totalItems / itemsPerPage);
  const hasNextPage = currentPage < totalPages;
  const hasPrevPage = currentPage > 1;

  return {
    currentPage,
    itemsPerPage,
    totalItems,
    totalPages,
    hasNextPage,
    hasPrevPage,
  };
}

/**
 * Format error message for API responses
 * @param {Error} error - Error object
 * @returns {Object} Formatted error response
 */
export function formatErrorResponse(error) {
  return {
    success: false,
    message: error.message || 'An error occurred',
    error: process.env.NODE_ENV === 'development' ? error.stack : undefined,
  };
}

/**
 * Sanitize filename for file uploads
 * @param {String} filename - Original filename
 * @returns {String} Sanitized filename
 */
export function sanitizeFilename(filename) {
  return filename
    .replace(/[^a-zA-Z0-9.-]/g, '_')
    .replace(/_{2,}/g, '_')
    .substring(0, 255);
}

/**
 * Validate file type
 * @param {String} mimeType - MIME type
 * @param {Array<String>} allowedTypes - Allowed MIME types
 * @returns {Boolean} Is valid
 */
export function validateFileType(mimeType, allowedTypes) {
  return allowedTypes.includes(mimeType);
}

/**
 * Format date for display
 * @param {Date} date - Date object
 * @returns {String} Formatted date string
 */
export function formatDate(date) {
  if (!date) return '';
  const d = new Date(date);
  return d.toLocaleDateString('en-IN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
}

/**
 * Format currency for display
 * @param {Number} amount - Amount
 * @returns {String} Formatted currency string
 */
export function formatCurrency(amount) {
  if (amount === null || amount === undefined) return '₹0.00';
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
  }).format(amount);
}

/**
 * Extract ObjectId string from value (handles ObjectId, populated objects, or strings)
 * @param {*} value - Value to extract ID from
 * @returns {String|null} ObjectId string or null
 */
function extractObjectId(value) {
  if (!value) return null;
  if (typeof value === 'string') return value;
  if (value._id) return value._id.toString();
  if (value.toString && typeof value.toString === 'function') {
    const str = value.toString();
    // Check if it's a valid ObjectId string (24 hex characters)
    if (/^[0-9a-fA-F]{24}$/.test(str)) {
      return str;
    }
  }
  return null;
}

/**
 * Normalize value for comparison (extract ObjectId from populated objects)
 * @param {*} value - Value to normalize
 * @returns {*} Normalized value
 */
function normalizeValue(value) {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value;
  if (typeof value === 'object' && value._id) {
    return value._id.toString();
  }
  if (typeof value === 'object' && value.toString && typeof value.toString === 'function') {
    const str = value.toString();
    if (/^[0-9a-fA-F]{24}$/.test(str)) {
      return str;
    }
  }
  return value;
}

/**
 * Track changes between old and new lead data
 * @param {Object} oldData - Old lead data
 * @param {Object} newData - New lead data
 * @param {Array} fieldsToCheck - Optional array of field names to check (if not provided, checks all fields)
 * @returns {Array} Array of changes
 */
export function trackLeadChanges(oldData, newData, fieldsToCheck = null) {
  const changes = [];
  const allFieldsToTrack = [
    'applicantMobile',
    'applicantEmail',
    'loanType',
    'loanAmount',
    'loanAccountNo',
    'agent',
    'franchise',
    'bank',
    'status',
    'sanctionedDate',
    'disbursedAmount',
    'disbursementDate',
    'disbursementType',
    'commissionBasis',
    'commissionPercentage',
    'verificationStatus',
    'verifiedBy',
    'verifiedAt',
    'remarks',
    'sentToBankAt',
    'bankResponseReceivedAt',
    'customerName',
    'smBm',
    'smBmEmail',
    'smBmMobile',
    'asmName',
    'asmEmail',
    'asmMobile',
    'dsaCode',
    'branch',
  ];

  const fieldsToTrack = fieldsToCheck || allFieldsToTrack;

  fieldsToTrack.forEach((field) => {
    const oldValue = oldData[field];
    const newValue = newData[field];

    // Normalize values for comparison (extract ObjectIds from populated objects)
    const normalizedOld = normalizeValue(oldValue);
    const normalizedNew = normalizeValue(newValue);

    // Skip if both are null/undefined
    if (normalizedOld === null && normalizedNew === null) {
      return;
    }

    // Handle date comparison
    if (oldValue instanceof Date && newValue instanceof Date) {
      if (oldValue.getTime() !== newValue.getTime()) {
        changes.push({
          field,
          oldValue: oldValue.toISOString(),
          newValue: newValue.toISOString(),
        });
      }
      return;
    }

    // Compare normalized values
    if (normalizedOld !== normalizedNew) {
      // Format display values
      let displayOld = normalizedOld;
      let displayNew = normalizedNew;

      // For ObjectId fields, try to get display name from populated object
      if (['agent', 'bank', 'franchise', 'smBm', 'verifiedBy'].includes(field)) {
        if (oldValue && typeof oldValue === 'object' && oldValue.name) {
          displayOld = oldValue.name;
        } else if (normalizedOld) {
          displayOld = normalizedOld;
        } else {
          displayOld = 'N/A';
        }

        if (newValue && typeof newValue === 'object' && newValue.name) {
          displayNew = newValue.name;
        } else if (normalizedNew) {
          displayNew = normalizedNew;
        } else {
          displayNew = 'N/A';
        }
      } else {
        displayOld = normalizedOld !== null && normalizedOld !== undefined ? normalizedOld : 'N/A';
        displayNew = normalizedNew !== null && normalizedNew !== undefined ? normalizedNew : 'N/A';
      }

      changes.push({
        field,
        oldValue: displayOld,
        newValue: displayNew,
      });
    }
  });

  return changes;
}
