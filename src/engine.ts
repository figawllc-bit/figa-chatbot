import { approvedFaqs } from './faq';
import { countClarification, validCaregiverCount } from './count';
import { businessQuestion, controlledResponse, hasSensitiveInput, humanRequest, injection, medicalQuestion } from './safety';
import { appendHistory } from './history';
import { fields, type ChatRequest, type ChatResponse, type ConversationEngine, type ConversationState, type Field } from './types';

export const required: Record<'provider' | 'caregiver', Field[]> = {
  provider: ['name', 'homeType', 'city', 'state', 'position', 'date', 'shift', 'count'],
  caregiver: ['name', 'city', 'state', 'position', 'availability', 'shift', 'experience'],
};
export const intakeFields: Record<'provider' | 'caregiver', Field[]> = {
  provider: [...required.provider, 'organization', 'urgency', 'notes'],
  caregiver: [...required.caregiver, 'applicationStatus'],
};
export const completionMessage = 'Thank you. Your details are ready for FIGA staff review and follow-up; staffing and employment are not guaranteed. Nothing has been submitted or sent to staff in this test. You can correct any detail.';
export const questions: Record<Field, string> = {
  name: 'What is your name?', organization: 'What organization are you contacting us from?',
  homeType: 'Is this an adult foster home, a group home, or another home type?',
  city: 'Which city is this for?', state: 'Which state is that in?', position: 'What position is needed?',
  date: 'What date is the staffing request for? You can give an exact date or a relative date such as tomorrow.',
  shift: 'Which shift or working hours?', count: 'How many caregivers do you need?',
  urgency: 'How urgent is this request (urgent, routine, or flexible)?',
  notes: 'Any additional work-related notes? Say "none" if there are no more. Please omit resident and medical information.',
  availability: 'What days or dates are you available to work?',
  experience: 'What relevant professional experience do you have? Please omit client and resident details.',
  applicationStatus: 'Have you already applied to FIGA, or is this your first inquiry?',
};
export const isGreeting = (message: string) => /^(?:hello|hi(?: there)?|hey|good (?:morning|afternoon|evening))[!.\s]*$/i.test(message.trim());
function classify(message: string): ConversationState['type'] {
  if (/\b(?:i (?:run|manage|operate)|our)\b.*\b(?:adult foster|group) home\b|\b(?:need|request|require)\b.*\b(?:caregivers?|staff|coverage)\b|\b(?:hiring|recruiting)\b.*\bfor (?:my|our|a)\b/i.test(message)) return 'provider';
  if (/\b(job|employment|hiring|work for|apply|application|looking for work)\b/i.test(message)) return 'caregiver';
  if (/^(?:i am a |i'm a )?provider[.!]?$/i.test(message)) return 'provider';
  if (/\b(need|request|looking for|seeking|require)\b.*\b(caregiver|staff|cna|nurse|coverage)|\b(someone|anyone|caregivers?)\b.*\bavailable|\bstaffing\b/i.test(message)) return 'provider';
  return /^(hello|hi|hey|good (morning|afternoon|evening))[!.\s]*$/i.test(message) ? 'unknown' : 'general';
}
// Relative dates remain verbatim; a state is never inferred from a city.
function extract(message: string, s: ConversationState, allowAnswer: boolean) {
  const c = s.collected;
  const allowed = intakeFields[s.type as 'provider' | 'caregiver'] ?? [];
  const set = (key: Field, value?: string) => { if (value?.trim() && allowed.includes(key)) c[key] = value.trim().replace(/[.!]$/, ''); };
  const touched = new Set<Field>();
  for (const field of fields) {
    const label = field === 'applicationStatus' ? 'application(?: status)?' : field === 'homeType' ? 'home[ ]?type' : field;
    const match = message.match(new RegExp('(?:^|[;\\n])\\s*(?:actually,?\\s*)?' + label + '\\s*:\\s*([^;\\n]+)', 'i'));
    if (match) { set(field, match[1]); touched.add(field); }
  }
  const correction = /\b(actually|instead|change|correction|make that)\b/i.test(message);
  const put = (key: Field, value?: string) => { if (value && !touched.has(key) && allowed.includes(key) && (!c[key] || correction)) { set(key, value); touched.add(key); } };
  put('homeType', message.match(/\b(adult foster home|group home)\b/i)?.[1]);
  put('name', message.match(/\b(?:my name is|name is|i am|i'm)\s+(?!(?:in|looking|available|interested|a|an|from|not)\b)([a-z][a-z'-]+(?:\s+[a-z][a-z'-]+)?)(?=\s+(?:from|at|with)\b|[,.!;]|$)/i)?.[1]);
  put('organization', message.match(/\b(?:from|at|with)\s+([A-Z][\w '&-]+?)(?=[,;.!]|$)/)?.[1]);
  const location = message.match(/\b(?:in|located in|based in)\s+([A-Za-z][A-Za-z .'-]*?)(?:,\s*([A-Za-z]{2}|[A-Z][a-z]+(?:\s+[A-Z][a-z]+)?))?(?=\s+(?:for|on|tomorrow|tonight|today|and|with)\b|,\s*(?:starting|beginning|on)\b|[;.!]|$)/i);
  if (location) { put('city', location[1]); put('state', location[2]); }
  if (s.awaiting === 'city' || s.awaiting === 'state') {
    const bareLocation = message.match(/^([A-Za-z][A-Za-z .'-]+),\s*([A-Za-z][A-Za-z ]+)[.!]?$/);
    if (bareLocation) { put('city', bareLocation[1]); put('state', bareLocation[2]); }
  }
  put('position', message.match(/\b(caregivers?|CNA|LPN|RN|nurses?|home health aides?)\b/i)?.[1]?.replace(/caregivers/i, 'caregiver').replace(/nurses/i, 'nurse'));
  put('date', message.match(/\b(today|tomorrow|tonight|\d{4}-\d{2}-\d{2}|(?:next\s+)?(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday))\b/i)?.[1]);
  put('shift', message.match(/\b(day|night|evening|overnight|morning|afternoon)s?(?:\s+shift)?\b/i)?.[0]);
  const quantity = message.match(/(?:^|[^\w.+-])([-+]?\d+(?:[.,]\d+)*|one|two|three|four|five|six|seven|eight|nine|ten|a|an)\s+(?:more\s+)?(?:caregivers?|CNAs?|nurses?|LPNs?|RNs?)\b/i)?.[1]?.toLowerCase();
  if (quantity) put('count', ({ a: '1', an: '1', one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9', ten: '10' } as Record<string,string>)[quantity] ?? quantity);
  put('urgency', message.match(/\b(urgent|asap|routine|flexible|immediate)\b/i)?.[1]);
  put('experience', message.match(/\b(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s+years?(?:\s+of)?\s+(?:\w+\s+)?experience\b/i)?.[0]);
  put('applicationStatus', message.match(/\b(?:already applied|not (?:yet )?applied|haven't applied|first inquiry|applied|new applicant)\b/i)?.[0]);
  put('availability', message.match(/\b(?:available|availability is|can work)\s+(.+?)(?=,?\s+(?:and\s+)?(?:prefer|preferred|seeking|looking for)\b|[;.!]|$)/i)?.[1]);
  if (s.awaiting === 'availability' && /\b(weekdays|weekends|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i.test(message) && !message.includes('?')) put('availability', message);
  const key = s.awaiting;
  // Do not copy a compound answer into an unrelated pending field.
  if (allowAnswer && key && !touched.size && !/\?/.test(message) && !/^(thanks?|ok(?:ay)?|yes|no|hello|hi)[!.\s]*$/i.test(message)) {
    if (key === 'count') {
      const words: Record<string, string> = { one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9', ten: '10' };
      const n = message.match(/^(\d+)\s*$/)?.[1] ?? words[message.toLowerCase().replace(/[.!]$/, '')];
      set(key, n ?? message);
    } else set(key, message);
  }
  if (key === 'applicationStatus' && /^(yes|no)[.!]?$/i.test(message)) set(key, /^yes/i.test(message) ? 'Already applied' : 'Not yet applied');
  const invalidCount = Object.hasOwn(c, 'count') && !validCaregiverCount(c.count);
  if (invalidCount) delete c.count;
  return invalidCount;
}
export class DeterministicEngine implements ConversationEngine {
  async respond({ message, state }: ChatRequest): Promise<ChatResponse> {
    const controlled = controlledResponse({ message, state });
    if (controlled) return controlled;
    const s: ConversationState = state ? structuredClone(state) : { version: 1, type: 'unknown', collected: {}, awaiting: null, humanAttentionReasons: [] };
    const flag = (reason: string) => { if (!s.humanAttentionReasons.includes(reason)) s.humanAttentionReasons = [...s.humanAttentionReasons, reason].slice(-10); };
    let answer = '';
    if (hasSensitiveInput({ message, state })) {
      for (const key of fields) if (s.collected[key] && hasSensitiveInput({ message: s.collected[key]! })) delete s.collected[key];
      s.history = [];
      flag('Sensitive information requires staff review.');
      answer = 'Please leave out medical, resident, and other sensitive information. I have not added that message to the collected information. Share only basic professional and scheduling details.';
    } else if (injection.test(message) || medicalQuestion.test(message)) {
      flag('Safety or medical inquiry requires staff review.');
      answer = medicalQuestion.test(message) ? 'I cannot give medical advice. Please contact a qualified healthcare professional. This inquiry requires human review; no notification has been sent.' : 'I cannot share credentials, internal staff information, or override conversation controls. Staff review is required; no notification has been sent.';
    } else if (isGreeting(message)) {
      s.history = appendHistory(s.history, message);
      answer = 'Hello! I can help if you are requesting caregivers, looking for a caregiver job, or asking a general question.';
      if (s.type === 'provider' || s.type === 'caregiver') {
        s.awaiting = required[s.type].find(key => !s.collected[key]) ?? null;
        if (s.awaiting) answer += ' ' + (s.awaiting === 'position' && s.type === 'caregiver' ? 'What position are you interested in?' : questions[s.awaiting]);
      } else answer += ' How can I help you today?';
    } else {
      s.history = appendHistory(s.history, message);
      const faq = approvedFaqs.find(f => f.match.test(message));
      const staffQuestion = businessQuestion.test(message);
      const human = humanRequest.test(message);
      const availability = /\b(?:do you have|can you|confirm)\b.*\b(?:available|availability|tonight)\b|\b(?:is|are)\b.*\bavailable\b|\b(?:your|figa)\b.*\bavailability\b/i.test(message);
      // Questions about approved procedures must not reset an existing intake.
      const intent = faq || staffQuestion || human ? availability && s.type !== 'caregiver' ? 'provider' : 'general' : classify(message);
      const previousType = s.type;
      if (intent === 'provider' || intent === 'caregiver') {
        if (s.type !== intent) { s.type = intent; s.awaiting = null; s.collected = {}; }
      } else if (s.type === 'unknown') s.type = intent;
      if (availability) { flag('Staff must confirm staffing availability.'); answer = 'Only FIGA staff can confirm availability or placement. This dry run has not contacted anyone.'; }
      else if (human && faq?.id !== 'assistant-identity') { flag('Human assistance requested.'); answer = 'This conversation needs FIGA staff attention. No staff member has been notified by this test.'; }
      else if (staffQuestion) { flag('Business details require approved staff confirmation.'); answer = 'I do not have approved FIGA information to confirm that. FIGA staff would need to review it; no notification has been sent.'; }
      else if (faq) answer = faq.answer;
      else if ((s.type === 'provider' || s.type === 'caregiver') && intent === 'general' && /\?|^(?:what|where|why|how|do you|does|can you|is there)\b/i.test(message)) {
        flag('General inquiry requires staff confirmation.');
        answer = 'I do not have an approved answer to that question. FIGA staff would need to confirm it. No one has been notified.';
      }
      else if (s.type === 'general') { flag('General inquiry requires staff confirmation.'); answer = 'I do not have an approved answer to that question. It needs FIGA staff confirmation. This is a local flag only; no one has been notified. Are you requesting staff or looking for a caregiver job?'; }
      if (s.type === 'provider' || s.type === 'caregiver') {
        // An availability question is not an answer to an intake field.
        if (availability && s.type === 'provider' && !s.collected.date) {
          const date = message.match(/\b(today|tomorrow|tonight)\b/i)?.[1];
          if (date) s.collected.date = date;
        }
        const invalidCount = !faq && !staffQuestion && !human && !answer && extract(message, s, !!state && previousType === s.type);
        if (/\b(urgent|asap|tonight|immediate(?:ly)?)\b/i.test(message)) flag('Urgent timing requires staff review.');
        const missing = invalidCount ? 'count' : required[s.type].find(key => !s.collected[key]);
        s.awaiting = missing ?? null;
        if (missing) {
          const q = invalidCount ? countClarification : missing === 'position' && s.type === 'caregiver' ? 'What position are you interested in?' : questions[missing];
          answer += (answer ? ' ' : '') + q;
        } else {
          flag('Intake is complete and requires staff review.');
          if (!answer) answer = completionMessage;
        }
        if (!state || previousType !== s.type) answer = 'I can collect the basic details. This does not confirm staffing or employment. ' + answer;
      } else s.awaiting = null;
      if (!answer) answer = 'Hello! Are you requesting caregivers for an organization, looking for a caregiver job, or asking a general question? Please use fictional details and omit medical or resident information.';
    }
    return { mode: 'LOCAL_DEVELOPMENT_DRY_RUN', conversationType: s.type, assistantResponse: answer,
      collectedInformation: s.collected, state: s, humanAttentionNeeded: s.humanAttentionReasons.length > 0,
      humanAttentionReasons: s.humanAttentionReasons,
      complete: (s.type === 'provider' || s.type === 'caregiver') && required[s.type].every(key => !!s.collected[key]) };
  }
}
