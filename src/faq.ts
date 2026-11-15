import { approvedKnowledge } from './knowledge';
// One approved-only list shared by both engines and the extraction schema.
export const approvedFaqs = approvedKnowledge.flatMap(entry => entry.status === 'approved' && entry.match ? [{ id: entry.id, match: entry.match, answer: entry.answer }] : []);
