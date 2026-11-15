import type { RingCentralScope, SmsObservation } from './events';
import { InputError } from '../validation';

// Authored test content, not a caller-provided "synthetic" assertion. Extending
// this catalog requires a code review. Never add captured customer material.
export const fixtureTexts = Object.freeze([
  'My name is Alex Example. I need three caregivers for a group home in Salem, Oregon, starting tonight on the night shift. This is urgent.',
  'My name is Sam Example. I am seeking a CNA job in Portland, Oregon. I have three years of caregiving experience, can work Monday through Friday, and prefer evening shifts.',
  'Fictional group home staffing inquiry', 'Fictional provider inquiry',
  'Changed fictional content', 'Fictional outbound observation',
  'Fictional chatbot observation', 'Fictional claimed staff reply',
  'Fictional inquiry on another business line', 'Fictional independent inquiry',
  'Fictional direct RPC invalid batch', 'Fictional staffing inquiry',
  'STOP', 'START', ' stop ', 'STOPALL', 'Unsubscribe', 'CANCEL', 'END', 'QUIT', 'please stop', 'stop please!',
  'HELP', 'INFO',
] as const);
function reject(): never { throw new InputError('Only authored fictional RingCentral fixtures are accepted.'); }
export function assertFixtureScope(scope: RingCentralScope): void {
  if (scope.accountId !== '100001' || !['200001', '200002'].includes(scope.extensionId) || scope.subscriptionId !== 'fictional-subscription' ||
      !scope.businessNumbers.length || scope.businessNumbers.some(n => !['+15035550100', '+15035550101'].includes(n))) reject();
}
export function assertFixtureMessages(messages: SmsObservation[]): void {
  for (const m of messages) {
    if (m.accountId !== '100001' || !['200001', '200002'].includes(m.extensionId) || !/^3\d{5}$/.test(m.id) ||
        !['+15035550100', '+15035550101'].includes(m.businessNumber) || !/^\+150355501\d{2}$/.test(m.customerNumber) ||
        !(fixtureTexts as readonly string[]).includes(m.text)) reject();
  }
}
export function assertNoFixtureAttachments(event: unknown, records?: unknown[]): void {
  const body = (event as { body?: unknown })?.body;
  for (const candidate of records ?? [body]) {
    if (candidate && typeof candidate === 'object' && 'attachments' in candidate) {
      const attachments = (candidate as { attachments: unknown }).attachments;
      if (!Array.isArray(attachments) || attachments.length) reject();
    }
  }
}
