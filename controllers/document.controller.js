import fileUploadService from '../services/fileUpload.service.js';
import Document from '../models/document.model.js';
import { getPaginationMeta } from '../utils/helpers.js';
import User from '../models/user.model.js';
import Lead from '../models/lead.model.js';
import Franchise from '../models/franchise.model.js';
import RelationshipManager from '../models/relationship.model.js';
import { v2 as cloudinary } from 'cloudinary';
import path from 'path';
import fs from 'fs';
import https from 'https';
import AdmZip from 'adm-zip';
import { accountantCanAccessLead } from '../utils/accountantScope.js';

/**
 * Authorization helper - determines if a user can view documents for an entity
 * @param {object|null} req - Express request (required for accounts_manager lead scope)
 */
const canViewEntity = async (user, entityType, entityId, req = null) => {
  if (!user) return false;
  if (user.role === 'super_admin') return true;

  // Any authenticated user can view invoice documents (attachments visible to all roles)
  if (entityType === 'invoice') {
    return true;
  }

  // Agent: can view documents of leads he created
  if (user.role === 'agent') {
    if (entityType === 'lead') {
      const lead = await Lead.findById(entityId).select('agent');
      return !!lead && lead.agent && lead.agent.toString() === user._id.toString();
    }
    return false;
  }

  // Relationship manager or Franchise: can view docs of their agents and leads
  if (user.role === 'relationship_manager' || user.role === 'franchise') {
    // User (agent) documents
    if (entityType === 'user') {
      const agent = await User.findById(entityId).select('managedBy managedByModel');
      if (!agent) return false;
      if (agent.managedByModel === 'RelationshipManager') {
        const rm = await RelationshipManager.findById(agent.managedBy).select('owner');
        if (rm && rm.owner && rm.owner.toString() === user._id.toString()) return true;
      } else if (agent.managedByModel === 'Franchise') {
        const franchiseId = user.franchiseOwned || user.franchise;
        if (agent.managedBy && franchiseId && agent.managedBy.toString() === franchiseId.toString()) return true;
      }
      return false;
    }

    // Lead documents
    if (entityType === 'lead') {
      const lead = await Lead.findById(entityId).select('agent associated associatedModel');
      if (!lead) return false;
      const agent = await User.findById(lead.agent).select('managedBy managedByModel');
      if (!agent) return false;
      if (agent.managedByModel === 'RelationshipManager') {
        const rm = await RelationshipManager.findById(agent.managedBy).select('owner');
        if (rm && rm.owner && rm.owner.toString() === user._id.toString()) return true;
      } else if (agent.managedByModel === 'Franchise') {
        const franchiseId = user.franchiseOwned || user.franchise;
        if (agent.managedBy && franchiseId && agent.managedBy.toString() === franchiseId.toString()) return true;
      }
      return false;
    }

    // Franchise owners can view their own franchise documents
    if (entityType === 'franchise' && user.role === 'franchise') {
      const franchiseId = user.franchiseOwned || user.franchise;
      return franchiseId && franchiseId.toString() === entityId.toString();
    }

    return false;
  }

  // Regional manager: can view docs for entities under their region
  if (user.role === 'regional_manager') {
    if (entityType === 'franchise') {
      const franchise = await Franchise.findById(entityId).select('regionalManager');
      return !!franchise && franchise.regionalManager && franchise.regionalManager.toString() === user._id.toString();
    }
    if (entityType === 'relationship_manager') {
      const rm = await RelationshipManager.findById(entityId).select('regionalManager');
      return !!rm && rm.regionalManager && rm.regionalManager.toString() === user._id.toString();
    }
    if (entityType === 'user') {
      const agent = await User.findById(entityId).select('managedBy managedByModel');
      if (!agent) return false;
      if (agent.managedByModel === 'Franchise') {
        const franchise = await Franchise.findById(agent.managedBy).select('regionalManager');
        return !!franchise && franchise.regionalManager && franchise.regionalManager.toString() === user._id.toString();
      } else if (agent.managedByModel === 'RelationshipManager') {
        const rm = await RelationshipManager.findById(agent.managedBy).select('regionalManager');
        return !!rm && rm.regionalManager && rm.regionalManager.toString() === user._id.toString();
      }
      return false;
    }
    if (entityType === 'lead') {
      const lead = await Lead.findById(entityId).select('agent');
      if (!lead) return false;
      const agent = await User.findById(lead.agent).select('managedBy managedByModel');
      if (!agent) return false;
      if (agent.managedByModel === 'Franchise') {
        const franchise = await Franchise.findById(agent.managedBy).select('regionalManager');
        return !!franchise && franchise.regionalManager && franchise.regionalManager.toString() === user._id.toString();
      } else if (agent.managedByModel === 'RelationshipManager') {
        const rm = await RelationshipManager.findById(agent.managedBy).select('regionalManager');
        return !!rm && rm.regionalManager && rm.regionalManager.toString() === user._id.toString();
      }
      return false;
    }
    if (entityType === 'invoice') {
      const Invoice = (await import('../models/invoice.model.js')).default;
      const inv = await Invoice.findById(entityId).select('franchise').populate('franchise', 'regionalManager');
      if (!inv || !inv.franchise) return false;
      const franchiseId = inv.franchise._id || inv.franchise;
      const franchise = await Franchise.findById(franchiseId).select('regionalManager');
      return !!franchise && franchise.regionalManager && franchise.regionalManager.toString() === user._id.toString();
    }
  }

  // Accounts manager (accountant): same lead scope as accountant dashboard — agents under assigned RMs
  if (user.role === 'accounts_manager' && entityType === 'lead') {
    if (!req) return false;
    const lead = await Lead.findById(entityId).select('agent');
    if (!lead) return false;
    return accountantCanAccessLead(req, lead);
  }

  return false;
};

/**
 * Upload document
 */
export const uploadDocument = async (req, res, next) => {
  try {
    // Accept any file field names (handles multiple named inputs like pan, aadhaar, gst)
    const upload = fileUploadService.getAnyUploadMiddleware();

    upload(req, res, async (err) => {
      if (err) {
        return res.status(400).json({
          success: false,
          message: err.message,
        });
      }

      // Support both single-file (req.file) and any-field uploads (req.files)
      const incomingFile = req.file || (Array.isArray(req.files) && req.files.length > 0 ? req.files[0] : null);
      if (!incomingFile) {
        return res.status(400).json({
          success: false,
          message: 'No file uploaded',
        });
      }

      // Debug log of incoming files
      if (req.files && req.files.length > 0) {
        console.log(`Received ${req.files.length} file(s) on upload endpoint. Using first file:`, {
          fieldname: incomingFile.fieldname,
          originalname: incomingFile.originalname,
          mimetype: incomingFile.mimetype,
          size: incomingFile.size,
        });
      } else {
        console.log('Received single file upload:', {
          fieldname: incomingFile.fieldname,
          originalname: incomingFile.originalname,
          mimetype: incomingFile.mimetype,
          size: incomingFile.size,
        });
      }

      const { entityType, entityId, documentType, description } = req.body;

      if (!entityType || !entityId || !documentType) {
        return res.status(400).json({
          success: false,
          message: 'Entity type, entity ID, and document type are required',
        });
      }
      // Process the uploaded file (upload to Cloudinary if configured, else save locally)
      const document = await fileUploadService.processUploadedFile(incomingFile, {
        entityType,
        entityId,
        documentType,
        description,
        uploadedBy: req.user._id,
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
 * Get documents for an entity
 */
export const getDocuments = async (req, res, next) => {
  try {
    const { entityType, entityId } = req.params;
    const { page = 1, limit = 10, verificationStatus } = req.query;
    const skip = (page - 1) * limit;

    const allowed = await canViewEntity(req.user, entityType, entityId, req);
    if (!allowed) {
      return res.status(403).json({ success: false, message: 'Access denied' });
    }

    const query = { entityType, entityId };
    if (verificationStatus) query.verificationStatus = verificationStatus;

    const documents = await Document.find(query)
      .populate('uploadedBy', 'name email')
      .populate('verifiedBy', 'name email')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(parseInt(limit));

    const total = await Document.countDocuments(query);
    const pagination = getPaginationMeta(page, limit, total);

    res.status(200).json({
      success: true,
      data: documents,
      pagination,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Get document by ID
 */
export const getDocumentById = async (req, res, next) => {
  try {
    const document = await Document.findById(req.params.id)
      .populate('uploadedBy', 'name email')
      .populate('verifiedBy', 'name email');

    if (!document) {
      return res.status(404).json({
        success: false,
        message: 'Document not found',
      });
    }
    // Authorization: ensure user can view this document based on its entity
    const allowed = await canViewEntity(req.user, document.entityType, document.entityId, req);
    if (!allowed) {
      return res.status(403).json({ success: false, message: 'Access denied' });
    }

    res.status(200).json({
      success: true,
      data: document,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Verify document
 */
export const verifyDocument = async (req, res, next) => {
  try {
    const { status, remarks } = req.body;

    if (!['verified', 'rejected'].includes(status)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid verification status',
      });
    }

    const document = await fileUploadService.verifyDocument(
      req.params.id,
      status,
      req.user._id,
      remarks
    );

    res.status(200).json({
      success: true,
      message: 'Document verified successfully',
      data: document,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Delete document
 */
export const deleteDocument = async (req, res, next) => {
  try {
    await fileUploadService.deleteDocument(req.params.id);

    res.status(200).json({
      success: true,
      message: 'Document deleted successfully',
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Download / view document file
 * - PDFs: stream inline so they open in browser (no forced download)
 * - Other types:
 *   - Cloudinary: redirect to signed URL
 *   - Local: download from disk
 */
export const downloadDocument = async (req, res, next) => {
  try {
    const document = await Document.findById(req.params.id);

    if (!document) {
      return res.status(404).json({
        success: false,
        message: 'Document not found',
      });
    }

    const allowed = await canViewEntity(req.user, document.entityType, document.entityId, req);
    if (!allowed) {
      return res.status(403).json({ success: false, message: 'Access denied' });
    }

    // Resolve the actual cloud URL — some older records have provider='local'
    // but filePath is a Cloudinary HTTPS URL. Normalise both cases.
    const cloudUrl =
      document.url ||
      (document.filePath?.startsWith('https://') || document.filePath?.startsWith('http://')
        ? document.filePath
        : null);

    const isCloudinary =
      document.provider === 'cloudinary' ||
      cloudUrl?.includes('cloudinary.com') ||
      cloudUrl?.includes('res.cloudinary');

    // --- Cloud-stored document: download via Cloudinary generate_archive, unzip, stream ---
    // Cloudinary blocks public delivery of PDFs on free accounts (401).
    // generate_archive is the only authenticated download endpoint that works.
    // We buffer the ZIP response, extract the single file, and stream it to the client.
    if (isCloudinary && cloudUrl) {
      const { CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET } = process.env;

      if (!CLOUDINARY_CLOUD_NAME || !CLOUDINARY_API_KEY || !CLOUDINARY_API_SECRET) {
        return res.status(500).json({ success: false, message: 'Storage configuration missing' });
      }

      cloudinary.config({
        cloud_name: CLOUDINARY_CLOUD_NAME,
        api_key: CLOUDINARY_API_KEY,
        api_secret: CLOUDINARY_API_SECRET,
      });

      // Extract public_id from stored record or parse from URL
      const publicId = document.publicId || (() => {
        const match = cloudUrl.match(/\/upload\/(?:v\d+\/)?(.+?)(?:\.[^/.]+)?$/);
        return match ? match[1] : null;
      })();

      const resourceType = document.resourceType ||
        (document.mimeType?.startsWith('image/') ? 'image' : 'raw');

      if (!publicId) {
        console.error(`Cannot determine public_id for document ${document._id}`);
        return res.status(500).json({ success: false, message: 'Cannot locate file in storage' });
      }

      // Build signed archive download URL (the only Cloudinary endpoint that bypasses PDF restriction)
      const archiveUrl = cloudinary.utils.download_archive_url({
        public_ids: [publicId],
        resource_type: resourceType,
        flatten_folders: true,
        use_original_filename: false,
      });

      const mimeType = document.mimeType || 'application/octet-stream';
      const filename = document.originalFileName || document.fileName || 'file';

      console.log(`Downloading Cloudinary archive for: ${publicId} (${resourceType})`);

      // Buffer the entire ZIP response, then extract and stream the file
      return https.get(archiveUrl, (archiveRes) => {
        if (archiveRes.statusCode >= 400) {
          console.error(`Cloudinary archive download failed (${archiveRes.statusCode})`);
          return res.status(502).json({ success: false, message: 'Could not fetch file from storage' });
        }

        const chunks = [];
        archiveRes.on('data', chunk => chunks.push(chunk));
        archiveRes.on('end', () => {
          try {
            const zipBuffer = Buffer.concat(chunks);
            const zip = new AdmZip(zipBuffer);
            const entries = zip.getEntries();

            if (!entries.length) {
              return res.status(502).json({ success: false, message: 'Archive from storage was empty' });
            }

            // Get the first (only) file in the archive
            const fileBuffer = entries[0].getData();

            res.setHeader('Content-Type', mimeType);
            res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(filename)}"`);
            res.setHeader('Content-Length', fileBuffer.length);
            res.end(fileBuffer);
          } catch (zipErr) {
            console.error(`ZIP extraction error: ${zipErr.message}`);
            res.status(502).json({ success: false, message: 'Failed to extract file from storage archive' });
          }
        });
        archiveRes.on('error', (err) => {
          console.error(`Archive stream error: ${err.message}`);
          res.status(502).json({ success: false, message: 'Could not read file from storage' });
        });
      }).on('error', (err) => {
        console.error(`Cloudinary archive request error: ${err.message}`);
        res.status(502).json({ success: false, message: 'Could not reach storage service' });
      });
    }

    // --- Local file ---
    const filePath = document.filePath;
    if (!filePath || filePath.startsWith('http://') || filePath.startsWith('https://')) {
      console.error(`Document ${document._id} has no valid local file path: ${filePath}`);
      return res.status(500).json({
        success: false,
        message: 'File not available for download',
      });
    }

    if (!fs.existsSync(filePath)) {
      console.error(`Local file not found on disk: ${filePath}`);
      return res.status(500).json({
        success: false,
        message: 'File not found on server',
      });
    }

    const stream = fs.createReadStream(filePath);
    stream.on('error', (err) => {
      console.error(`Error reading local file: ${err.message}`);
      res.status(500).json({ success: false, message: 'Error reading file from disk' });
    });
    return stream.pipe(res);

  } catch (error) {
    next(error);
  }
};
