// Company facts and assistant procedures approved in the Phase 6 user request.
// Edit reviewed wording here; pending topics never enter model context or replies.
export type KnowledgeCategory = 'faq' | 'services' | 'provider_procedures' | 'caregiver_procedures' | 'business_rules' | 'escalation_rules';
interface ApprovedKnowledge {
  id: string; category: KnowledgeCategory; status: 'approved';
  source: 'FIGA Phase 6 user instructions'; answer: string; match?: RegExp;
}
const source = 'FIGA Phase 6 user instructions' as const;
export const approvedKnowledge: readonly ApprovedKnowledge[] = [
  { id: 'services', category: 'services', status: 'approved', source,
    match: /\b(?:what (?:is|does) figa|about figa|figa(?:'s)? services|what services|who (?:do you|does figa) help|what (?:do you|does figa) do)\b/i,
    answer: 'FIGA Staffing helps connect adult foster home and group home providers with caregivers seeking employment opportunities. Are you requesting caregivers or looking for work?' },
  { id: 'provider-intake', category: 'provider_procedures', status: 'approved', source,
    match: /\b(?:how (?:do i|can i|to) (?:request|find) (?:caregivers?|staff)|provider (?:process|procedure))\b/i,
    answer: 'I can collect your name, home type, city and state, caregiver count, position, shift, and requested start date for staff review. FIGA staff must confirm availability and placement. This test does not submit a request or notify staff.' },
  { id: 'caregiver-intake', category: 'caregiver_procedures', status: 'approved', source,
    match: /\b(?:how (?:do i|can i|to) (?:apply|find work)|caregiver (?:process|procedure))\b/i,
    answer: 'I can collect your preferred location, position, experience, availability, and shifts as an employment inquiry for FIGA staff review and follow-up. Employment is not guaranteed. This test does not submit an application or notify staff.' },
  { id: 'assistant-help', category: 'faq', status: 'approved', source,
    match: /\b(what can you do|how does this work|help me)\b/i,
    answer: 'I can collect a staffing request or caregiver job inquiry for staff review. I cannot confirm availability, placement, employment, or rates.' },
  { id: 'assistant-identity', category: 'faq', status: 'approved', source,
    match: /\b(are you (a |an )?(bot|human)|is this (live|a demo)|dry run)\b/i,
    answer: 'I am FIGA\'s local test assistant. Please use fictional details. This chat does not send customer messages or notify staff.' },
  { id: 'privacy', category: 'business_rules', status: 'approved', source,
    match: /\b(what (information|details) (do you need|should i share)|privacy)\b/i,
    answer: 'Share basic work and scheduling details only. Omit resident information, medical details, Social Security numbers, passwords, and identity documents. Use fictional information in this test.' },
  { id: 'staff-review', category: 'escalation_rules', status: 'approved', source,
    answer: 'Urgent staffing, requests for a person, unknown business details, and medical or sensitive inquiries require human attention. Never promise availability, placement, employment, wages, prices, or response times. Respect staff ownership and closed conversations.' },
];

// Approval checklist, never a source of customer-facing facts.
export const approvalNeeded = [
  'Legal company details, contact channels, office hours, and service areas',
  'Provider fees, contracts, payment, cancellation, refund, and replacement policies',
  'Caregiver wages, benefits, employment relationship, and eligibility requirements',
  'Application links, screening, credentials, background checks, and hiring procedures',
  'Placement process, availability checks, response times, and follow-up commitments',
  'Licensing, insurance, training, and compliance claims',
  'Consent, retention, privacy policy, and approved customer messaging procedures',
] as const;

// Restricted topics win even when a message also contains an approved FAQ.
export const approvalQuestion = /\b(?:fees?|rates?|pay|wages?|salary|compensation|benefits|polic(?:y|ies)|prices?|costs?|charges?|free|contracts?|refunds?|cancellations?|replacements?|screening|background checks?|eligib(?:le|ility)|requirements?|licenses?|licensed|insurance|training|service areas?|office hours?|phone|address|contact details|how (?:long|soon)|guarantee|booked|placement)\b|\b(?:do you have|is someone|is anyone|are there|can you|confirm)\b.*\b(?:available|availability|tonight)\b|\b(?:your|figa)\b.*\bavailability\b/i;
export const approvedContext = approvedKnowledge.filter(k => k.status === 'approved').map(k => `${k.category}: ${k.answer}`).join('\n');
