import mongoose from 'mongoose';

/**
 * Atomic sequence counters (e.g. per financial year for invoice numbers).
 * _id is a string key such as "invoice_2026-2027".
 */
const sequenceCounterSchema = new mongoose.Schema({
  _id: { type: String, required: true },
  seq: { type: Number, default: 0 },
});

export default mongoose.model('SequenceCounter', sequenceCounterSchema);
