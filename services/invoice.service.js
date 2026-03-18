import Invoice from '../models/invoice.model.js';
import Lead from '../models/lead.model.js';
import Franchise from '../models/franchise.model.js';
import FranchiseCommissionLimit from '../models/franchiseCommissionLimit.model.js';
import User from '../models/user.model.js';
import { generateInvoiceNumber } from '../utils/helpers.js';

// Invoice amount formula: Commission (Taxable) = Loan Amount × Rate%; GST = 18% of Taxable; TDS = 2% of Taxable; Gross = Taxable + GST - TDS
const GST_RATE = 18;
const TDS_RATE = 2;

function computeInvoiceAmounts(taxable, tdsPercentage = TDS_RATE) {
  const gstAmount = (taxable * GST_RATE) / 100;
  const tdsAmount = (taxable * tdsPercentage) / 100;
  const netPayable = taxable + gstAmount - tdsAmount; // Gross amount
  return { gstAmount, tdsAmount, netPayable };
}

/**
 * Invoice Service
 * Handles invoice generation, approval workflow, and TDS calculation
 */
class InvoiceService {
  /**
   * Generate invoice for a lead based on status
   * - If status = "disbursed": Generate Agent Invoice
   * - If status = "completed": Generate Franchise Invoice
   * @param {ObjectId} leadId - Lead ID
   * @returns {Promise<Object>} Created invoice
   */
  async generateInvoice(leadId) {
    try {
      const lead = await Lead.findById(leadId)
        .populate({
          path: 'agent',
          populate: {
            path: 'managedBy',
            // managedBy can be either Franchise or RelationshipManager
            // We'll handle both cases in the logic below
          }
        })
        .populate('subAgent', 'name email')
        .populate('associated')
        .populate('referralFranchise')
        .populate('bank', 'name');

      if (!lead) {
        throw new Error('Lead not found');
      }

      // Only allow invoice generation for "disbursed" or "completed" status
      if (lead.status !== 'disbursed' && lead.status !== 'completed') {
        throw new Error(`Invoice can only be generated for leads with status "disbursed" or "completed". Current status: ${lead.status}`);
      }

      // Get franchise from associated field (polymorphic)
      let franchiseId = null;
      let franchise = null;
      
      if (lead.associatedModel === 'Franchise' && lead.associated) {
        // Lead is directly associated with a Franchise
        franchiseId = lead.associated._id || lead.associated;
        franchise = await Franchise.findById(franchiseId);
      } else if (lead.agent && lead.agent.managedByModel === 'Franchise' && lead.agent.managedBy) {
        // Agent is directly managed by a Franchise
        franchiseId = lead.agent.managedBy._id || lead.agent.managedBy;
        franchise = await Franchise.findById(franchiseId);
      } else if (lead.agent && lead.agent.managedByModel === 'RelationshipManager' && lead.agent.managedBy) {
        // Agent is managed by a RelationshipManager - find franchise through regional manager
        const RelationshipManager = (await import('../models/relationship.model.js')).default;
        const rm = await RelationshipManager.findById(lead.agent.managedBy).select('regionalManager').lean();
        
        if (rm && rm.regionalManager) {
          // Find franchises under this regional manager
          const franchises = await Franchise.find({ regionalManager: rm.regionalManager }).limit(1);
          if (franchises.length > 0) {
            franchise = franchises[0];
            franchiseId = franchise._id;
          }
        }
      } else if (lead.associatedModel === 'RelationshipManager' && lead.associated) {
        // Lead is associated with a RelationshipManager - find franchise through regional manager
        const RelationshipManager = (await import('../models/relationship.model.js')).default;
        const rm = await RelationshipManager.findById(lead.associated._id || lead.associated).select('regionalManager').lean();
        
        if (rm && rm.regionalManager) {
          // Find franchises under this regional manager
          const franchises = await Franchise.find({ regionalManager: rm.regionalManager }).limit(1);
          if (franchises.length > 0) {
            franchise = franchises[0];
            franchiseId = franchise._id;
          }
        }
      }

      if (!franchise) {
        throw new Error('Franchise information not found for this lead. Please ensure the lead is associated with a franchise or the agent is managed by a franchise.');
      }

      let invoiceType = 'agent';
      let commissionAmount = 0;
      const loanAmount = lead.loanAmount || 0;

      if (lead.status === 'disbursed') {
        // Check if lead has subAgent - if yes, generate split invoices
        // Check both subAgent (ObjectId or populated) and subAgentName for robustness
        // Also check the raw document in case subAgent is set but populated as null
        const rawLead = await Lead.findById(leadId).select('subAgent subAgentName').lean();
        const hasSubAgent = !!(lead.subAgent || lead.subAgentName || rawLead?.subAgent || rawLead?.subAgentName);
        
        if (hasSubAgent) {
          // Generate split invoices: one for Agent, one for SubAgent
          // Use the commission rate decided by the agent when creating the lead
          const agentCommissionPercentage = lead.agentCommissionPercentage || 0;
          const subAgentCommissionPercentage = lead.subAgentCommissionPercentage || 0;
          
          console.log('🔍 Split Invoice Debug - Using Agent-Decided Commission Rates:', {
            hasSubAgent: !!hasSubAgent,
            subAgent: lead.subAgent,
            subAgentName: lead.subAgentName,
            rawSubAgent: rawLead?.subAgent,
            rawSubAgentName: rawLead?.subAgentName,
            agentCommissionPercentage: `${agentCommissionPercentage}% (set by agent)`,
            subAgentCommissionPercentage: `${subAgentCommissionPercentage}% (decided by agent)`,
            loanAmount,
            note: 'SubAgent invoice will use the commission rate decided by the agent when creating the lead'
          });
          
          if (agentCommissionPercentage <= 0) {
            throw new Error('Partner commission percentage is not set or is zero. Cannot generate split invoices.');
          }

          if (subAgentCommissionPercentage <= 0) {
            throw new Error('Sub-agent commission percentage is not set or is zero. Cannot generate split invoices. Please ensure the agent set a commission rate for the sub-agent when creating the lead.');
          }

          // Calculate Agent's remaining commission (total - subAgent's share)
          const agentRemainingPercentage = agentCommissionPercentage - subAgentCommissionPercentage;
          
          if (agentRemainingPercentage <= 0) {
            throw new Error(`Agent remaining commission percentage is zero or negative. Agent: ${agentCommissionPercentage}%, SubAgent: ${subAgentCommissionPercentage}%.`);
          }

          // Check for existing invoices
          const existingAgentInvoice = await Invoice.findOne({
            lead: leadId,
            invoiceType: 'agent'
          });

          const existingSubAgentInvoice = await Invoice.findOne({
            lead: leadId,
            invoiceType: 'sub_agent'
          });

          if (existingAgentInvoice || existingSubAgentInvoice) {
            throw new Error('Invoices already exist for this lead. Duplicate invoice generation prevented.');
          }

          // Calculate commission amounts
          // SubAgent commission uses the rate decided by the agent (subAgentCommissionPercentage)
          const agentCommissionAmount = (loanAmount * agentRemainingPercentage) / 100;
          const subAgentCommissionAmount = (loanAmount * subAgentCommissionPercentage) / 100;
          
          console.log('💰 Commission Calculation:', {
            loanAmount,
            agentTotalCommission: `${agentCommissionPercentage}%`,
            subAgentCommission: `${subAgentCommissionPercentage}% (agent-decided rate)`,
            agentRemainingCommission: `${agentRemainingPercentage}%`,
            agentCommissionAmount: `₹${agentCommissionAmount.toLocaleString()}`,
            subAgentCommissionAmount: `₹${subAgentCommissionAmount.toLocaleString()} (using agent-decided rate)`
          });

          if (agentCommissionAmount <= 0 || subAgentCommissionAmount <= 0) {
            throw new Error('Calculated commission amounts are zero. Cannot generate invoices.');
          }

          // Gross = Taxable + GST - TDS (GST 18%, TDS 2%)
          const tdsPercentage = TDS_RATE;
          const agentAmounts = computeInvoiceAmounts(agentCommissionAmount, tdsPercentage);
          const subAgentAmounts = computeInvoiceAmounts(subAgentCommissionAmount, tdsPercentage);
          const agentTdsAmount = agentAmounts.tdsAmount;
          const subAgentTdsAmount = subAgentAmounts.tdsAmount;
          const agentNetPayable = agentAmounts.netPayable;
          const subAgentNetPayable = subAgentAmounts.netPayable;
          const agentGstAmount = agentAmounts.gstAmount;
          const subAgentGstAmount = subAgentAmounts.gstAmount;

          // Generate invoice numbers
          const agentInvoiceNumber = await generateInvoiceNumber();
          const subAgentInvoiceNumber = await generateInvoiceNumber();

          // Create Agent Invoice
          const agentInvoice = await Invoice.create({
            invoiceNumber: agentInvoiceNumber,
            lead: leadId,
            agent: lead.agent._id || lead.agent,
            franchise: franchiseId,
            invoiceType: 'agent',
            commissionAmount: agentCommissionAmount,
            gstAmount: agentGstAmount,
            tdsAmount: agentTdsAmount,
            tdsPercentage,
            netPayable: agentNetPayable,
            status: 'pending',
            invoiceDate: new Date(),
          });

          // Get subAgent ID - handle both populated and unpopulated cases
          let subAgentId = null;
          
          // First try to get from populated subAgent
          if (lead.subAgent) {
            // Handle both populated object and ObjectId
            if (typeof lead.subAgent === 'object' && lead.subAgent._id) {
              subAgentId = lead.subAgent._id;
            } else {
              subAgentId = lead.subAgent;
            }
          }
          
          // If not found, try from raw document
          if (!subAgentId && rawLead?.subAgent) {
            subAgentId = rawLead.subAgent;
          }
          
          // If still not found, try to find by name
          if (!subAgentId && (lead.subAgentName || rawLead?.subAgentName)) {
            const subAgentName = lead.subAgentName || rawLead.subAgentName;
            const subAgentUser = await User.findOne({ 
              name: subAgentName,
              parentAgent: lead.agent._id || lead.agent,
              role: 'agent'
            });
            if (subAgentUser) {
              subAgentId = subAgentUser._id;
            } else {
              throw new Error(`Sub-agent "${subAgentName}" not found for this agent. Cannot generate sub-agent invoice.`);
            }
          }
          
          if (!subAgentId) {
            throw new Error('Sub-agent ID could not be determined. Please ensure the lead has a valid sub-agent assigned.');
          }

          // Create SubAgent Invoice
          // Note: commissionAmount is calculated using subAgentCommissionPercentage 
          // which was decided by the agent when creating the lead
          const subAgentInvoice = await Invoice.create({
            invoiceNumber: subAgentInvoiceNumber,
            lead: leadId,
            agent: lead.agent._id || lead.agent, // Keep agent reference for tracking
            subAgent: subAgentId,
            franchise: franchiseId,
            invoiceType: 'sub_agent',
            commissionAmount: subAgentCommissionAmount, // Uses agent-decided subAgentCommissionPercentage from lead
            gstAmount: subAgentGstAmount,
            tdsAmount: subAgentTdsAmount,
            tdsPercentage,
            netPayable: subAgentNetPayable,
            status: 'pending',
            invoiceDate: new Date(),
          });
          
          console.log('✅ Split invoices created:', {
            agentInvoice: agentInvoice._id,
            subAgentInvoice: subAgentInvoice._id
          });

          // Update lead - mark as invoice generated
          if (!lead.invoice) {
            lead.invoice = agentInvoice._id; // Store agent invoice as primary reference
          }
          lead.isInvoiceGenerated = true;
          await lead.save();

          // Return both invoices (return agent invoice as primary, but both are created)
          return { agentInvoice, subAgentInvoice, isSplit: true };
        } else {
          // Generate single Agent Invoice (no subAgent)
          invoiceType = 'agent';
          
          // Use Agent (Partner) Commission % set while creating the Lead.
          // For RM-created leads, commission might be stored in generic commissionPercentage
          // while agentCommissionPercentage is 0. Mirror frontend mapping logic.
          const rawAgentPct = Number(lead.agentCommissionPercentage) || 0;
          const rawGenericPct = Number(lead.commissionPercentage) || 0;
          const hasAssociatedName = !!(lead.associated && lead.associated.name);
          const hasSubAgent = !!(lead.subAgent || lead.subAgentName);

          let agentCommissionPercentage = rawAgentPct;
          if (agentCommissionPercentage === 0 && rawGenericPct > 0 && hasAssociatedName && !hasSubAgent) {
            agentCommissionPercentage = rawGenericPct;
          }
          
          if (agentCommissionPercentage <= 0) {
            throw new Error('Agent commission percentage is not set or is zero. Please set the commission percentage for this lead before generating an invoice.');
          }

          // Calculate: Agent Commission Amount = (Loan Amount × Agent Commission %) / 100
          commissionAmount = (loanAmount * agentCommissionPercentage) / 100;

          if (commissionAmount <= 0) {
            throw new Error('Calculated agent commission amount is zero. Cannot generate invoice.');
          }

          // Check for duplicate agent invoice
          const existingAgentInvoice = await Invoice.findOne({
            lead: leadId,
            invoiceType: 'agent'
          });

          if (existingAgentInvoice) {
            throw new Error('Partner invoice already exists for this lead. Duplicate invoice generation prevented.');
          }

          // Gross = Taxable + GST - TDS (GST 18%, TDS 2%)
          const tdsPercentage = TDS_RATE;
          const amounts = computeInvoiceAmounts(commissionAmount, tdsPercentage);

          // Generate invoice number
          const invoiceNumber = await generateInvoiceNumber();

          // Create invoice
          const invoice = await Invoice.create({
            invoiceNumber,
            lead: leadId,
            agent: lead.agent._id || lead.agent,
            franchise: franchiseId,
            invoiceType,
            commissionAmount,
            gstAmount: amounts.gstAmount,
            tdsAmount: amounts.tdsAmount,
            tdsPercentage,
            netPayable: amounts.netPayable,
            status: 'pending',
            invoiceDate: new Date(),
          });

          // Update lead - mark as invoice generated (but don't overwrite if invoice field already exists)
          if (!lead.invoice) {
            lead.invoice = invoice._id;
          }
          lead.isInvoiceGenerated = true;
          await lead.save();

          return invoice;
        }

      } else if (lead.status === 'completed') {
        // Generate Franchise Invoice
        invoiceType = 'franchise';
        
        // Get Franchise Commission % from FranchiseCommissionLimit (set by Admin per bank)
        // This is the default commission percentage for the franchise for this specific bank
        let franchiseCommissionPercentage = 0;
        
        // Get bank ID from lead
        const bankId = lead.bank?._id || lead.bank;
        if (!bankId) {
          throw new Error('Bank information not found for this lead. Cannot determine franchise commission percentage.');
        }
        
        // Get Franchise Commission Limit for this bank (set by Admin)
        const franchiseCommissionLimit = await FranchiseCommissionLimit.findOne({ bank: bankId });
        
        if (!franchiseCommissionLimit) {
          throw new Error(`Franchise commission limit is not set for this bank. Please set the commission limit for this bank in the Franchise Commission settings.`);
        }
        
        // Use the maxCommissionValue as franchise commission percentage
        // Note: This assumes limitType is 'percentage' (which is the standard)
        if (franchiseCommissionLimit.limitType === 'percentage') {
          franchiseCommissionPercentage = parseFloat(franchiseCommissionLimit.maxCommissionValue) || 0;
        } else {
          // If it's amount-based, we can't use it as percentage
          throw new Error(`Franchise commission limit for this bank is set as amount (₹${franchiseCommissionLimit.maxCommissionValue}), not percentage. Please configure it as percentage in Franchise Commission settings.`);
        }
        
        if (franchiseCommissionPercentage <= 0) {
          throw new Error(`Franchise commission percentage is zero for this bank. Please set a valid commission percentage in the Franchise Commission settings.`);
        }

        // Get Agent Commission % from lead
        const agentCommissionPercentage = lead.agentCommissionPercentage || 0;
        
        // Get Referral Franchise Commission % from lead (if exists)
        const referralFranchiseCommissionPercentage = lead.referralFranchiseCommissionPercentage || 0;

        // Calculate remaining commission: Franchise Commission % - Agent Commission % - Referral Franchise Commission %
        const remainingCommissionPercentage = franchiseCommissionPercentage - agentCommissionPercentage - referralFranchiseCommissionPercentage;

        // If remaining commission is zero or negative
        if (remainingCommissionPercentage <= 0) {
          throw new Error(`Franchise commission is zero or negative. Total commission: ${franchiseCommissionPercentage}%, Agent commission: ${agentCommissionPercentage}%, Referral franchise commission: ${referralFranchiseCommissionPercentage}%. The sum of agent and referral franchise commissions equals or exceeds the total franchise commission.`);
        }

        // Calculate: Franchise Commission Amount = (Loan Amount × Remaining Commission %) / 100
        commissionAmount = (loanAmount * remainingCommissionPercentage) / 100;

        if (commissionAmount <= 0) {
          throw new Error(`Calculated franchise commission amount is zero. Loan Amount: ${loanAmount}, Remaining Commission %: ${remainingCommissionPercentage}%.`);
        }

        // Check for duplicate main franchise invoice (not referral)
        const existingFranchiseInvoice = await Invoice.findOne({
          lead: leadId,
          invoiceType: 'franchise',
          $or: [
            { isReferralFranchise: { $exists: false } },
            { isReferralFranchise: false }
          ]
        });

        if (existingFranchiseInvoice) {
          throw new Error('Main franchise invoice already exists for this lead. Duplicate invoice generation prevented.');
        }

        // Gross = Taxable + GST - TDS (GST 18%, TDS 2%)
        const tdsPercentage = TDS_RATE;
        const amounts = computeInvoiceAmounts(commissionAmount, tdsPercentage);

        // Generate invoice number
        const invoiceNumber = await generateInvoiceNumber();

        // Create invoice
        const invoice = await Invoice.create({
          invoiceNumber,
          lead: leadId,
          agent: lead.agent._id || lead.agent,
          franchise: franchiseId,
          invoiceType,
          commissionAmount,
          gstAmount: amounts.gstAmount,
          tdsAmount: amounts.tdsAmount,
          tdsPercentage,
          netPayable: amounts.netPayable,
          status: 'pending',
          invoiceDate: new Date(),
        });

        // Update lead - mark as invoice generated (but don't overwrite if invoice field already exists)
        if (!lead.invoice) {
          lead.invoice = invoice._id;
        }
        lead.isInvoiceGenerated = true;
        await lead.save();

        // If referral franchise exists, create a second invoice for the referral franchise
        if (lead.referralFranchise) {
          const referralFranchiseId = lead.referralFranchise._id || lead.referralFranchise;
          
          // Get referral franchise commission from lead
          const referralCommissionPercentage = lead.referralFranchiseCommissionPercentage || 0;
          const referralCommissionAmount = lead.referralFranchiseCommissionAmount || 0;

          if (referralCommissionAmount > 0) {
            // Check for duplicate referral franchise invoice
            const existingReferralInvoice = await Invoice.findOne({
              lead: leadId,
              invoiceType: 'franchise',
              franchise: referralFranchiseId,
              isReferralFranchise: true
            });

            if (!existingReferralInvoice) {
              // Gross = Taxable + GST - TDS for referral franchise
              const referralAmounts = computeInvoiceAmounts(referralCommissionAmount, TDS_RATE);

              // Generate invoice number for referral franchise
              const referralInvoiceNumber = await generateInvoiceNumber();

              // Create invoice for referral franchise (with isReferralFranchise flag)
              const referralInvoice = await Invoice.create({
                invoiceNumber: referralInvoiceNumber,
                lead: leadId,
                agent: lead.agent._id || lead.agent,
                franchise: referralFranchiseId,
                invoiceType: 'franchise',
                isReferralFranchise: true, // Mark as referral franchise invoice
                commissionAmount: referralCommissionAmount,
                gstAmount: referralAmounts.gstAmount,
                tdsAmount: referralAmounts.tdsAmount,
                tdsPercentage: TDS_RATE,
                netPayable: referralAmounts.netPayable,
                status: 'pending',
                invoiceDate: new Date(),
              });

              // Return both invoices (main invoice and referral invoice)
              return {
                mainInvoice: invoice,
                referralInvoice: referralInvoice
              };
            }
          }
        }

        return invoice;
      }

    } catch (error) {
      throw new Error(`Error generating invoice: ${error.message}`);
    }
  }

  /**
   * Resolve franchise ID from lead (used by generateInvoicesForDisbursement)
   * @param {Object} lead - Populated lead
   * @returns {Promise<ObjectId|null>} franchiseId
   */
  async _resolveFranchiseFromLead(lead) {
    let franchiseId = null;
    if (lead.associatedModel === 'Franchise' && lead.associated) {
      franchiseId = lead.associated._id || lead.associated;
    } else if (lead.agent?.managedByModel === 'Franchise' && lead.agent?.managedBy) {
      franchiseId = lead.agent.managedBy._id || lead.agent.managedBy;
    } else if (lead.agent?.managedByModel === 'RelationshipManager' && lead.agent?.managedBy) {
      const RelationshipManager = (await import('../models/relationship.model.js')).default;
      const rm = await RelationshipManager.findById(lead.agent.managedBy).select('regionalManager').lean();
      if (rm?.regionalManager) {
        const franchises = await Franchise.find({ regionalManager: rm.regionalManager }).limit(1);
        if (franchises.length > 0) franchiseId = franchises[0]._id;
      }
    } else if (lead.associatedModel === 'RelationshipManager' && lead.associated) {
      const RelationshipManager = (await import('../models/relationship.model.js')).default;
      const rm = await RelationshipManager.findById(lead.associated._id || lead.associated).select('regionalManager').lean();
      if (rm?.regionalManager) {
        const franchises = await Franchise.find({ regionalManager: rm.regionalManager }).limit(1);
        if (franchises.length > 0) franchiseId = franchises[0]._id;
      }
    }
    return franchiseId;
  }

  /**
   * Generate Agent and Sub-Agent invoices for a single disbursement (partial disbursement).
   * Uses disbursement amount for commission calculation. No franchise invoice.
   * Duplicate prevention: do not create if invoices already exist for leadId + disbursementId + invoiceType.
   * @param {ObjectId} leadId - Lead ID
   * @param {string|ObjectId} disbursementId - Disbursement subdoc _id from lead.disbursementHistory
   * @returns {Promise<{ agentInvoice: Object, subAgentInvoice?: Object }>}
   */
  async generateInvoicesForDisbursement(leadId, disbursementId) {
    try {
      if (!leadId || !disbursementId) {
        throw new Error('leadId and disbursementId are required');
      }

      const lead = await Lead.findById(leadId)
        .populate('agent')
        .populate('subAgent', 'name email')
        .populate('associated');

      if (!lead) throw new Error('Lead not found');

      const history = lead.disbursementHistory || [];
      const dispIdStr = String(disbursementId);
      const disbursement = history.find(
        (d) => d._id && (String(d._id) === dispIdStr || d._id.toString() === dispIdStr)
      );
      if (!disbursement) throw new Error('Disbursement not found for this lead');

      const disbursementAmount = Number(disbursement.amount) || 0;
      if (disbursementAmount <= 0) throw new Error('Disbursement amount must be greater than zero');

      const franchiseId = await this._resolveFranchiseFromLead(lead);
      if (!franchiseId) {
        throw new Error('Franchise information not found for this lead.');
      }

      const rawLead = await Lead.findById(leadId).select('subAgent subAgentName associated associatedName').lean();
      const hasSubAgent = !!(lead.subAgent || lead.subAgentName || rawLead?.subAgent || rawLead?.subAgentName);

      const rawAgentPct = Number(lead.agentCommissionPercentage) || 0;
      const rawGenericPct = Number(lead.commissionPercentage) || 0;
      const hasAssociatedName =
        !!(lead.associated && lead.associated.name) ||
        !!rawLead?.associatedName;

      let agentCommissionPercentage = rawAgentPct;
      if (agentCommissionPercentage === 0 && rawGenericPct > 0 && hasAssociatedName && !hasSubAgent) {
        agentCommissionPercentage = rawGenericPct;
      }
      const subAgentCommissionPercentage = lead.subAgentCommissionPercentage ?? 0;

      if (agentCommissionPercentage <= 0) {
        throw new Error('Agent commission percentage is not set or is zero for this lead.');
      }

      // Prevent duplicate: check existing invoices for this lead + disbursement
      const existingAgent = await Invoice.findOne({
        lead: leadId,
        disbursementId: disbursement._id,
        invoiceType: 'agent',
      });
      const existingSubAgent = await Invoice.findOne({
        lead: leadId,
        disbursementId: disbursement._id,
        invoiceType: 'sub_agent',
      });

      if (existingAgent || existingSubAgent) {
        throw new Error('Invoices already exist for this disbursement. Duplicate generation prevented.');
      }

      const tdsPercentage = TDS_RATE;
      let subAgentId = null;
      if (hasSubAgent && subAgentCommissionPercentage > 0) {
        if (lead.subAgent) {
          subAgentId = typeof lead.subAgent === 'object' && lead.subAgent._id ? lead.subAgent._id : lead.subAgent;
        } else if (rawLead?.subAgent) {
          subAgentId = rawLead.subAgent;
        } else if (lead.subAgentName || rawLead?.subAgentName) {
          const subAgentUser = await User.findOne({
            name: lead.subAgentName || rawLead.subAgentName,
            parentAgent: lead.agent._id || lead.agent,
            role: 'agent',
          });
          if (subAgentUser) subAgentId = subAgentUser._id;
        }
        if (!subAgentId) throw new Error('Sub-agent could not be determined for this lead.');
      }

      const result = { agentInvoice: null, subAgentInvoice: null };

      if (hasSubAgent && subAgentId && subAgentCommissionPercentage > 0) {
        const agentRemainingPercentage = agentCommissionPercentage - subAgentCommissionPercentage;
        if (agentRemainingPercentage <= 0) {
          throw new Error('Agent remaining commission percentage is zero or negative. Cannot generate split invoices.');
        }
        const agentCommissionAmount = (disbursementAmount * agentRemainingPercentage) / 100;
        const subAgentCommissionAmount = (disbursementAmount * subAgentCommissionPercentage) / 100;

        const agentAmounts = computeInvoiceAmounts(agentCommissionAmount, tdsPercentage);
        const subAgentAmounts = computeInvoiceAmounts(subAgentCommissionAmount, tdsPercentage);

        const agentInvoiceNumber = await generateInvoiceNumber();
        const subAgentInvoiceNumber = await generateInvoiceNumber();

        result.agentInvoice = await Invoice.create({
          invoiceNumber: agentInvoiceNumber,
          lead: leadId,
          disbursementId: disbursement._id,
          disbursementAmount,
          commissionRate: agentRemainingPercentage,
          agent: lead.agent._id || lead.agent,
          franchise: franchiseId,
          invoiceType: 'agent',
          commissionAmount: agentCommissionAmount,
          gstAmount: agentAmounts.gstAmount,
          tdsAmount: agentAmounts.tdsAmount,
          tdsPercentage,
          netPayable: agentAmounts.netPayable,
          status: 'pending',
          invoiceDate: new Date(),
        });

        result.subAgentInvoice = await Invoice.create({
          invoiceNumber: subAgentInvoiceNumber,
          lead: leadId,
          disbursementId: disbursement._id,
          disbursementAmount,
          commissionRate: subAgentCommissionPercentage,
          agent: lead.agent._id || lead.agent,
          subAgent: subAgentId,
          franchise: franchiseId,
          invoiceType: 'sub_agent',
          commissionAmount: subAgentCommissionAmount,
          gstAmount: subAgentAmounts.gstAmount,
          tdsAmount: subAgentAmounts.tdsAmount,
          tdsPercentage,
          netPayable: subAgentAmounts.netPayable,
          status: 'pending',
          invoiceDate: new Date(),
        });
      } else {
        const agentCommissionAmount = (disbursementAmount * agentCommissionPercentage) / 100;
        const amounts = computeInvoiceAmounts(agentCommissionAmount, tdsPercentage);
        const invoiceNumber = await generateInvoiceNumber();

        result.agentInvoice = await Invoice.create({
          invoiceNumber,
          lead: leadId,
          disbursementId: disbursement._id,
          disbursementAmount,
          commissionRate: agentCommissionPercentage,
          agent: lead.agent._id || lead.agent,
          franchise: franchiseId,
          invoiceType: 'agent',
          commissionAmount: agentCommissionAmount,
          gstAmount: amounts.gstAmount,
          tdsAmount: amounts.tdsAmount,
          tdsPercentage,
          netPayable: amounts.netPayable,
          status: 'pending',
          invoiceDate: new Date(),
        });
      }

      return result;
    } catch (error) {
      throw new Error(error.message || 'Error generating invoices for disbursement');
    }
  }

  /**
   * Agent accepts invoice
   * @param {ObjectId} invoiceId - Invoice ID
   * @param {String} remarks - Optional remarks from agent
   * @returns {Promise<Object>} Updated invoice
   */
  async acceptInvoice(invoiceId, remarks = '') {
    try {
      const invoice = await Invoice.findById(invoiceId);
      if (!invoice) {
        throw new Error('Invoice not found');
      }

      if (invoice.status !== 'pending') {
        throw new Error('Invoice is not in pending status');
      }

      invoice.status = 'approved';
      invoice.acceptedAt = new Date();
      invoice.agentRemarks = remarks;

      await invoice.save();

      return invoice;
    } catch (error) {
      throw new Error(`Error accepting invoice: ${error.message}`);
    }
  }

  /**
   * Agent escalates invoice
   * @param {ObjectId} invoiceId - Invoice ID
   * @param {String} reason - Escalation reason
   * @param {String} remarks - Escalation remarks
   * @param {ObjectId} userId - User ID who escalated
   * @returns {Promise<Object>} Updated invoice
   */
  async escalateInvoice(invoiceId, reason, remarks, userId) {
    try {
      const invoice = await Invoice.findById(invoiceId);
      if (!invoice) {
        throw new Error('Invoice not found');
      }

      if (invoice.status !== 'pending') {
        throw new Error('Only pending invoices can be escalated');
      }

      invoice.status = 'escalated';
      invoice.isEscalated = true;
      invoice.escalationReason = reason;
      invoice.escalationRemarks = remarks;
      invoice.escalatedAt = new Date();
      invoice.escalatedBy = userId;

      await invoice.save();

      return invoice;
    } catch (error) {
      throw new Error(`Error escalating invoice: ${error.message}`);
    }
  }

  /**
   * Staff resolves escalated invoice
   * @param {ObjectId} invoiceId - Invoice ID
   * @param {String} resolutionRemarks - Resolution remarks
   * @param {ObjectId} userId - User ID who resolved
   * @param {Object} adjustments - Optional commission adjustments
   * @returns {Promise<Object>} Updated invoice
   */
  async resolveEscalation(invoiceId, resolutionRemarks, userId, adjustments = {}) {
    try {
      const invoice = await Invoice.findById(invoiceId);
      if (!invoice) {
        throw new Error('Invoice not found');
      }

      if (invoice.status !== 'escalated') {
        throw new Error('Invoice is not in escalated status');
      }

      // Apply adjustments if provided (Gross = Taxable + GST - TDS)
      if (adjustments.commissionAmount) {
        invoice.commissionAmount = adjustments.commissionAmount;
        const amounts = computeInvoiceAmounts(adjustments.commissionAmount, invoice.tdsPercentage || TDS_RATE);
        invoice.gstAmount = amounts.gstAmount;
        invoice.tdsAmount = amounts.tdsAmount;
        invoice.netPayable = amounts.netPayable;
      }

      invoice.status = 'pending';
      invoice.resolutionRemarks = resolutionRemarks;
      invoice.resolvedAt = new Date();
      invoice.resolvedBy = userId;

      await invoice.save();

      return invoice;
    } catch (error) {
      throw new Error(`Error resolving escalation: ${error.message}`);
    }
  }

  /**
   * Approve invoice (staff/accounts)
   * @param {ObjectId} invoiceId - Invoice ID
   * @param {ObjectId} userId - User ID who approved
   * @returns {Promise<Object>} Updated invoice
   */
  async approveInvoice(invoiceId, userId) {
    try {
      const invoice = await Invoice.findById(invoiceId);
      if (!invoice) {
        throw new Error('Invoice not found');
      }

      if (!['pending', 'escalated'].includes(invoice.status)) {
        throw new Error('Invoice cannot be approved in current status');
      }

      invoice.status = 'approved';
      invoice.approvedAt = new Date();
      invoice.approvedBy = userId;

      // If it was escalated, mark as resolved
      if (invoice.isEscalated && !invoice.resolvedAt) {
        invoice.resolvedAt = new Date();
        invoice.resolvedBy = userId;
      }

      await invoice.save();

      return invoice;
    } catch (error) {
      throw new Error(`Error approving invoice: ${error.message}`);
    }
  }

  /**
   * Reject invoice
   * @param {ObjectId} invoiceId - Invoice ID
   * @param {String} rejectionReason - Reason for rejection
   * @param {ObjectId} userId - User ID who rejected
   * @returns {Promise<Object>} Updated invoice
   */
  async rejectInvoice(invoiceId, rejectionReason, userId) {
    try {
      const invoice = await Invoice.findById(invoiceId);
      if (!invoice) {
        throw new Error('Invoice not found');
      }

      invoice.status = 'rejected';
      invoice.rejectionReason = rejectionReason;
      invoice.rejectedAt = new Date();
      invoice.rejectedBy = userId;

      await invoice.save();

      return invoice;
    } catch (error) {
      throw new Error(`Error rejecting invoice: ${error.message}`);
    }
  }

  /**
   * Get invoice by ID with all related data
   * @param {ObjectId} invoiceId - Invoice ID
   * @returns {Promise<Object>} Invoice with populated fields
   */
  async getInvoiceById(invoiceId) {
    try {
      const invoice = await Invoice.findById(invoiceId)
        .populate({
          path: 'lead',
          populate: {
            path: 'bank',
            select: 'name'
          }
        })
        .populate('agent', 'name email mobile city address kyc bankDetails agentType gst')
        .populate('subAgent', 'name email mobile city address kyc bankDetails agentType gst')
        .populate('franchise', 'name email mobile address kyc bankDetails franchiseType gst')
        .populate('payout')
        .populate('approvedBy', 'name email')
        .populate('rejectedBy', 'name email')
        .populate('escalatedBy', 'name email')
        .populate('resolvedBy', 'name email');

      return invoice;
    } catch (error) {
      throw new Error(`Error fetching invoice: ${error.message}`);
    }
  }
}

export default new InvoiceService();
