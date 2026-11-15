import { fields, type ConversationState, type ConversationType, type Field } from '../types';
import { approvedFaqs } from '../faq';
const faqIndices = [-1, ...approvedFaqs.map((_, index) => index)];
export interface ExtractionContext { message: string; state?: ConversationState }
// A Gemini adapter can implement this provider-neutral boundary.
export interface ExtractionProvider { extract(context: ExtractionContext, signal: AbortSignal): Promise<unknown> }
export interface Extraction {
  intent: ConversationType;
  intentEvidence: string;
  ambiguous: boolean;
  needsHumanReview: boolean;
  faqIndex: number;
  updates: { field: Field; quote: string }[];
}
export const extractionSchema = {
  type: 'object', additionalProperties: false,
  properties: {
    intent: { type: 'string', enum: ['unknown', 'provider', 'caregiver', 'general'] },
    intentEvidence: { type: 'string' }, ambiguous: { type: 'boolean' }, needsHumanReview: { type: 'boolean' },
    faqIndex: { type: 'integer', enum: faqIndices },
    updates: { type: 'array', items: { type: 'object', additionalProperties: false,
      properties: { field: { type: 'string', enum: [...fields] }, quote: { type: 'string' } }, required: ['field', 'quote'] } },
  }, required: ['intent', 'intentEvidence', 'ambiguous', 'needsHumanReview', 'faqIndex', 'updates'],
};
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
export function validateExtraction(value: unknown, message: string): Extraction {
  if (!object(value) || Object.keys(value).sort().join(',') !== 'ambiguous,faqIndex,intent,intentEvidence,needsHumanReview,updates' ||
      !['unknown', 'provider', 'caregiver', 'general'].includes(String(value.intent)) ||
      typeof value.intentEvidence !== 'string' || value.intentEvidence.length > 2000 ||
      (value.intentEvidence !== '' && !message.includes(value.intentEvidence)) ||
      typeof value.ambiguous !== 'boolean' || typeof value.needsHumanReview !== 'boolean' ||
      !faqIndices.includes(value.faqIndex as number) || !Array.isArray(value.updates) || value.updates.length > fields.length) throw new Error('invalid_extraction');
  const seen = new Set<string>();
  for (const item of value.updates) {
    if (!object(item) || Object.keys(item).sort().join(',') !== 'field,quote' || !fields.includes(item.field as Field) ||
        typeof item.quote !== 'string' || !item.quote.trim() || item.quote.length > 500 || !message.includes(item.quote) || seen.has(String(item.field))) throw new Error('ungrounded_extraction');
    seen.add(String(item.field));
  }
  return value as unknown as Extraction;
}
