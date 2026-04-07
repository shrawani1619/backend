/**
 * Resolves a human-facing customer / application id for lists and exports.
 * Order matches lead PDFs: case #, application # from dynamic form, then fallbacks.
 */
export function resolveLeadDisplayCustomerId(lead) {
  if (!lead || typeof lead !== 'object') return null;
  const fv =
    lead.formValues && typeof lead.formValues === 'object' && !Array.isArray(lead.formValues)
      ? lead.formValues
      : {};
  for (const v of [
    lead.caseNumber,
    fv.applicationNumber,
    fv.customerId,
    fv.leadId,
    lead.leadId,
    lead.loanAccountNo,
    lead._id != null ? String(lead._id) : null,
    lead.id != null ? String(lead.id) : null,
  ]) {
    if (v === undefined || v === null) continue;
    const s = String(v).trim();
    if (s !== '') return s;
  }
  return null;
}
