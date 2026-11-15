import type { Extraction } from '../../src/ai/extraction';
import type { CollectedInformation, Field } from '../../src/types';

export interface QualityTurn {
  message: string;
  extraction?: Extraction;
  expected: CollectedInformation;
  awaiting: Field | null;
  complete?: boolean;
  urgent?: boolean;
}
export interface QualityScenario { id: string; type: 'provider' | 'caregiver'; turns: QualityTurn[] }
const examples = [
  ['Alex Example', 'Salem', 'Oregon', 'group home', 'night', 'tomorrow', 'two', '2'],
  ['Blair Example', 'Portland', 'OR', 'adult foster home', 'evening', 'Monday', 'three', '3'],
  ['Casey Example', 'Eugene', 'Oregon', 'group home', 'day', 'Tuesday', 'one', '1'],
  ['Drew Example', 'Bend', 'OR', 'adult foster home', 'overnight', 'Wednesday', 'four', '4'],
  ['Ellis Example', 'Medford', 'Oregon', 'group home', 'morning', 'Thursday', 'five', '5'],
  ['Finley Example', 'Albany', 'OR', 'adult foster home', 'afternoon', 'Friday', 'two', '2'],
  ['Gray Example', 'Corvallis', 'Oregon', 'group home', 'night', 'Saturday', 'three', '3'],
  ['Harper Example', 'Ashland', 'OR', 'adult foster home', 'evening', 'Sunday', 'one', '1'],
  ['Indigo Example', 'Beaverton', 'Oregon', 'group home', 'day', 'today', 'six', '6'],
  ['Jules Example', 'Hillsboro', 'OR', 'adult foster home', 'morning', 'tonight', 'two', '2'],
] as const;
const proposal = (intent: Extraction['intent'], intentEvidence: string, updates: Extraction['updates'], review: boolean): Extraction => ({ intent, intentEvidence, updates, ambiguous: false, needsHumanReview: review, faqIndex: -1 });

// Explicit fictional evidence/expected facts. No model, parser, database or network
// is used to derive proposals; the same scripts run via HTTP and local SQL.
export const conversationScenarios: QualityScenario[] = examples.flatMap(([name, city, region, homeType, shift, date, word, count], index) => {
  const base: CollectedInformation = { position: 'caregivers', city, state: region, shift: `${shift} shift`, count };
  const named = { ...base, name };
  const home = { ...named, homeType };
  const full = { ...home, date };
  const corrected = { ...full, count: '4', city: 'Fictional Springs' };
  const urgent = { ...corrected, urgency: 'urgent' };
  const provider: QualityScenario = { id: `provider-${index + 1}`, type: 'provider', turns: [
    { message: 'Hello', expected: {}, awaiting: null },
    { message: `I need ${word} caregivers for a ${shift} shift in ${city}, ${region}.`, extraction: proposal('provider', `I need ${word} caregivers`, [{ field: 'position', quote: 'caregivers' }, { field: 'city', quote: city }, { field: 'state', quote: region }, { field: 'shift', quote: `${shift} shift` }, { field: 'count', quote: word }], index % 2 === 0), expected: base, awaiting: 'name' },
    { message: 'What services does FIGA offer?', expected: base, awaiting: 'name' },
    { message: `My name is ${name}.`, extraction: proposal('provider', '', [{ field: 'name', quote: name }], true), expected: named, awaiting: 'homeType' },
    { message: `${homeType}.`, extraction: proposal('provider', '', [{ field: 'homeType', quote: homeType }], false), expected: home, awaiting: 'date' },
    { message: `${date}.`, extraction: proposal('provider', '', [{ field: 'date', quote: date }], true), expected: full, awaiting: null, complete: true, urgent: date === 'tonight' },
    { message: 'Actually, make that four caregivers in Fictional Springs instead.', extraction: proposal('provider', '', [{ field: 'count', quote: 'four' }, { field: 'city', quote: 'Fictional Springs' }], true), expected: corrected, awaiting: null, complete: true },
    { message: 'This is urgent; we need coverage ASAP.', extraction: proposal('provider', '', [{ field: 'urgency', quote: 'urgent' }], true), expected: urgent, awaiting: null, complete: true, urgent: true },
    { message: 'What are your fees and can you guarantee placement?', expected: urgent, awaiting: null, complete: true, urgent: true },
  ] };
  const jobBase: CollectedInformation = { position: index % 2 === 0 ? 'CNA' : 'caregiver', city, state: region };
  const jobNamed = { ...jobBase, name };
  const available = { ...jobNamed, availability: 'Monday through Friday' };
  const shifted = { ...available, shift };
  const experienced = { ...shifted, experience: 'three years of caregiving experience' };
  const changed = { ...experienced, availability: 'weekends', shift: 'evening' };
  const caregiver: QualityScenario = { id: `caregiver-${index + 1}`, type: 'caregiver', turns: [
    { message: 'Hi', expected: {}, awaiting: null },
    { message: `I am seeking a ${jobBase.position} job in ${city}, ${region}.`, extraction: proposal('caregiver', `seeking a ${jobBase.position} job`, [{ field: 'position', quote: jobBase.position! }, { field: 'city', quote: city }, { field: 'state', quote: region }], index % 2 !== 0), expected: jobBase, awaiting: 'name' },
    { message: 'What services does FIGA offer?', expected: jobBase, awaiting: 'name' },
    { message: `My name is ${name}.`, extraction: proposal('caregiver', '', [{ field: 'name', quote: name }], true), expected: jobNamed, awaiting: 'availability' },
    { message: 'I can work Monday through Friday.', extraction: proposal('caregiver', '', [{ field: 'availability', quote: 'Monday through Friday' }], false), expected: available, awaiting: 'shift' },
    { message: `${shift} shifts.`, extraction: proposal('caregiver', '', [{ field: 'shift', quote: shift }], true), expected: shifted, awaiting: 'experience' },
    { message: 'I have three years of caregiving experience.', extraction: proposal('caregiver', '', [{ field: 'experience', quote: 'three years of caregiving experience' }], true), expected: experienced, awaiting: null, complete: true },
    { message: 'Actually, I can work weekends and prefer evening shifts.', extraction: proposal('caregiver', '', [{ field: 'availability', quote: 'weekends' }, { field: 'shift', quote: 'evening' }], true), expected: changed, awaiting: null, complete: true },
    { message: 'What wages and benefits can you guarantee?', expected: changed, awaiting: null, complete: true },
  ] };
  return [provider, caregiver];
});
