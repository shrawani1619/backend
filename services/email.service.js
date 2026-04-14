import EmailLog from '../models/emailLog.model.js';
import nodemailer from 'nodemailer';
import { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM } from '../config/env.js';

/**
 * Parse SMTP port — env vars are strings; `SMTP_PORT === 465` was always false, breaking SSL on 465.
 */
function getSmtpPort() {
  const n = parseInt(String(SMTP_PORT || '587'), 10);
  return Number.isFinite(n) && n > 0 ? n : 587;
}

/**
 * Email Service
 * Handles email sending with template support and logging
 */
class EmailService {
  constructor() {
    const port = getSmtpPort();
    // 465 = implicit TLS (SMTPS); 587/25 = STARTTLS (secure: false)
    const secure = port === 465;

    // Initialize nodemailer transporter
    this.transporter = nodemailer.createTransport({
      host: SMTP_HOST,
      port,
      secure,
      auth:
        SMTP_USER && SMTP_PASS
          ? {
              user: SMTP_USER,
              pass: SMTP_PASS,
            }
          : undefined,
      connectionTimeout: 20_000,
      greetingTimeout: 15_000,
    });
  }

  /**
   * Send email with logging
   * @param {Object} emailData - Email data
   * @returns {Promise<Object>} Email log entry
   */
  async sendEmail(emailData) {
    try {
      const { to, cc = [], bcc = [], subject, body, emailType, entityType, entityId } = emailData;

      // Create email log entry
      const emailLog = await EmailLog.create({
        to,
        cc,
        bcc,
        subject,
        body,
        emailType: emailType || 'general',
        entityType,
        entityId,
        status: 'pending',
      });

      try {
        // Send email
        const mailOptions = {
          from: SMTP_FROM || SMTP_USER,
          to,
          cc: cc.length > 0 ? cc : undefined,
          bcc: bcc.length > 0 ? bcc : undefined,
          subject,
          html: body,
        };

        const info = await this.transporter.sendMail(mailOptions);

        // Update email log on success
        emailLog.status = 'sent';
        emailLog.sentAt = new Date();
        emailLog.serviceResponse = {
          messageId: info.messageId,
          response: info.response,
        };

        await emailLog.save();

        return emailLog;
      } catch (error) {
        // Update email log on failure
        emailLog.status = 'failed';
        emailLog.error = error.message;
        emailLog.serviceResponse = {
          error: error.message,
        };

        await emailLog.save();

        throw error;
      }
    } catch (error) {
      throw new Error(`Error sending email: ${error.message}`);
    }
  }

  /**
   * Send bank coordination email
   * @param {Object} bankData - Bank data
   * @param {Object} leadData - Lead data
   * @returns {Promise<Object>} Email log entry
   */
  async sendBankEmail(bankData, leadData) {
    try {
      const subject = `New Lead Submission - ${leadData.loanAccountNo || 'Lead'}`;
      
      const body = `
        <html>
          <body>
            <h2>New Lead Submission</h2>
            <p>Dear ${bankData.name},</p>
            <p>A new lead has been submitted for processing:</p>
            <ul>
              <li><strong>Loan Account No:</strong> ${leadData.loanAccountNo || 'N/A'}</li>
              <li><strong>Loan Type:</strong> ${leadData.loanType}</li>
              <li><strong>Loan Amount:</strong> ₹${leadData.loanAmount.toLocaleString('en-IN')}</li>
              <li><strong>Agent:</strong> ${leadData.agent?.name || 'N/A'}</li>
            </ul>
            <p>Please process this case and update the status in the system.</p>
            <p>Best regards,<br>YKC Financial Services</p>
          </body>
        </html>
      `;

      return await this.sendEmail({
        to: bankData.contactEmail,
        subject,
        body,
        emailType: 'bank_coordination',
        entityType: 'lead',
        entityId: leadData._id,
      });
    } catch (error) {
      throw new Error(`Error sending bank email: ${error.message}`);
    }
  }

  /**
   * Send notification email
   * @param {String} to - Recipient email
   * @param {String} subject - Email subject
   * @param {String} message - Email message
   * @param {String} emailType - Type of email
   * @returns {Promise<Object>} Email log entry
   */
  async sendNotification(to, subject, message, emailType = 'notification') {
    try {
      const body = `
        <html>
          <body>
            <h2>${subject}</h2>
            <p>${message}</p>
            <p>Best regards,<br>YKC Financial Services</p>
          </body>
        </html>
      `;

      return await this.sendEmail({
        to,
        subject,
        body,
        emailType,
      });
    } catch (error) {
      throw new Error(`Error sending notification: ${error.message}`);
    }
  }
}

export default new EmailService();
