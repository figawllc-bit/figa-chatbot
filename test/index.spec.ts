import { SELF } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import { DeterministicEngine } from '../src/engine';
import type { ChatResponse, ConversationState } from '../src/types';

const engine = new DeterministicEngine();
const turn = (message: string, state?: ConversationState) => engine.respond({ message, state });
async function chat(message: string, state?: ConversationState): Promise<ChatResponse> {
  const response = await SELF.fetch('http://localhost/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message, ...(state ? { state } : {}) }) });
  expect(response.status).toBe(200);
  return response.json<ChatResponse>();
}
describe('Requested messages', () => {
  it('greets without guessing intent', async () => {
    const r = await chat('Hello');
    expect(r.conversationType).toBe('unknown');
    expect(r.assistantResponse).toContain('requesting caregivers');
    expect(r.collectedInformation).toEqual({});
  });
  it('collects a caregiver request for tomorrow', async () => {
    const r = await chat('I need a caregiver tomorrow.');
    expect(r.conversationType).toBe('provider');
    expect(r.collectedInformation).toMatchObject({ position: 'caregiver', count: '1', date: 'tomorrow' });
    expect(r.state.awaiting).toBe('name');
  });
  it('identifies job seekers', async () => {
    const r = await chat('I am looking for a caregiver job.');
    expect(r.conversationType).toBe('caregiver');
    expect(r.collectedInformation).toEqual({ position: 'caregiver' });
  });
  it('extracts multiple details without inventing a state', async () => {
    const r = await chat('I need two caregivers for a night shift in Portland.');
    expect(r.collectedInformation).toMatchObject({ count: '2', shift: 'night shift', city: 'Portland' });
    expect(r.collectedInformation.state).toBeUndefined();
  });
  it('escalates availability without promising it', async () => {
    const r = await chat('Do you have someone available tonight?');
    expect(r.conversationType).toBe('provider');
    expect(r.humanAttentionNeeded).toBe(true);
    expect(r.collectedInformation.date).toBe('tonight');
    expect(r.assistantResponse).toContain('Only FIGA staff can confirm');
  });
});
describe('Multi-turn conversation', () => {
  it('completes a provider intake over real API requests', async () => {
    let r = await chat('I need two caregivers for a night shift in Portland.');
    const original = structuredClone(r.state);
    r = await chat('My name is Alex Morgan from Example Care.', r.state);
    expect(original.collected.name).toBeUndefined();
    expect(r.collectedInformation).toMatchObject({ name: 'Alex Morgan', organization: 'Example Care', count: '2', city: 'Portland' });
    expect(r.state.awaiting).toBe('homeType');
    r = await chat('Adult foster home', r.state);
    expect(r.state.awaiting).toBe('state');
    r = await chat('Oregon', r.state);
    expect(r.state.awaiting).toBe('date');
    r = await chat('Tomorrow', r.state);
    expect(r.complete).toBe(true);
    r = await chat('Urgent', r.state);
    expect(r.state.awaiting).toBeNull();
    expect(r.complete).toBe(true);
    expect(r.humanAttentionNeeded).toBe(true);
    expect(r.assistantResponse).toContain('Nothing has been submitted');
    r = await chat('count: 3', r.state);
    expect(r.collectedInformation.count).toBe('3');
    expect(r.complete).toBe(true);
  });
  it('completes a caregiver intake without re-asking collected details', async () => {
    let r = await chat('I am looking for a caregiver job.');
    for (const message of ['My name is Sam Taylor.', 'I am in Portland, OR.', 'Available Monday through Friday.', 'Night shift', 'Three years of caregiving experience.', 'Not yet applied.']) r = await chat(message, r.state);
    expect(r.collectedInformation).toMatchObject({ name: 'Sam Taylor', city: 'Portland', state: 'OR', position: 'caregiver', applicationStatus: 'Not yet applied' });
    expect(r.complete).toBe(true);
    expect(r.state.awaiting).toBeNull();
    expect(r.humanAttentionNeeded).toBe(true);
  });
  it('keeps intake when asked about rates and preserves escalation', async () => {
    let r = await turn('I need a caregiver tomorrow.');
    r = await turn('What are your rates?', r.state);
    expect(r.collectedInformation.name).toBeUndefined();
    expect(r.state.awaiting).toBe('name');
    expect(r.assistantResponse).toContain('do not have approved FIGA information');
    r = await turn('Jane Doe', r.state);
    expect(r.collectedInformation.name).toBe('Jane Doe');
    expect(r.humanAttentionNeeded).toBe(true);
  });
  it('separates intake types when intent changes', async () => {
    let r = await turn('I need two caregivers in Portland.');
    r = await turn('I am looking for a caregiver job.', r.state);
    expect(r.conversationType).toBe('caregiver');
    expect(r.collectedInformation.count).toBeUndefined();
    expect(r.collectedInformation.city).toBeUndefined();
  });
  it('flags unapproved questions during intake without losing details', async () => {
    const r = await chat('I need a caregiver tomorrow.');
    const next = await chat('Is parking free?', r.state);
    expect(next.collectedInformation).toEqual(r.collectedInformation);
    expect(next.humanAttentionNeeded).toBe(true);
    expect(next.state.awaiting).toBe('name');
    expect(next.assistantResponse).toContain('staff would need to review');
  });
  it('does not store questions or filler as a contact name', async () => {
    const r = await turn('I need a caregiver.');
    for (const message of ['Thanks', 'Can you help?']) {
      const next = await turn(message, r.state);
      expect(next.collectedInformation.name).toBeUndefined();
    }
  });
  it('accepts a bare city/state answer and a word quantity', async () => {
    let r = await chat('I need caregivers.');
    for (const message of ['Jane Doe', 'Group home', 'Portland, OR', 'Tomorrow', 'Night shift', 'Two']) r = await chat(message, r.state);
    expect(r.collectedInformation).toMatchObject({ city: 'Portland', state: 'OR', count: '2' });
    expect(r.complete).toBe(true);
    expect(r.state.awaiting).toBeNull();
  });
  it('preserves the preferred role when experience mentions another role', async () => {
    let r = await chat('I am looking for a CNA job.');
    for (const message of ['Sam Taylor', 'Portland, OR', 'Weekdays, night shift', 'Three years of caregiver experience', 'Not yet applied']) r = await chat(message, r.state);
    expect(r.collectedInformation.position).toBe('CNA');
    expect(r.complete).toBe(true);
  });
});
describe('Safety and FAQs', () => {
  it.each(['What are your rates?', 'What is your service area?', 'How much do you pay?', 'What are your policies?'])('escalates unapproved business information: %s', async message => {
    const r = await chat(message);
    expect(r.humanAttentionNeeded).toBe(true);
    expect(r.assistantResponse).toContain('no notification has been sent');
  });
  it('answers only approved prototype FAQs', async () => {
    const r = await chat('What can you do?');
    expect(r.humanAttentionNeeded).toBe(false);
    expect(r.assistantResponse).toContain('cannot confirm');
  });
  it('flags explicit human requests without claiming a handoff', async () => {
    const r = await chat('I want a human');
    expect(r.humanAttentionNeeded).toBe(true);
    expect(r.assistantResponse).toContain('No staff member has been notified');
  });
  it('does not persist sensitive messages in collected state', async () => {
    const r = await chat('I need a caregiver tomorrow.');
    const next = await chat('Resident name: Jane Doe; diagnosis: dementia', r.state);
    expect(next.collectedInformation).toEqual(r.collectedInformation);
    expect(JSON.stringify(next.state)).not.toContain('dementia');
    expect(next.assistantResponse).toContain('leave out medical');
  });
});
describe('HTTP contract', () => {
  it('serves status, health, and the browser interface', async () => {
    const status = await SELF.fetch('http://localhost/');
    expect(await status.json()).toMatchObject({ status: 'ok', externalServicesConnected: false });
    const health = await SELF.fetch('http://localhost/health');
    expect(await health.json()).toMatchObject({ engine: 'deterministic' });
    const ui = await SELF.fetch('http://localhost/', { headers: { Accept: 'text/html' } });
    expect(ui.headers.get('Content-Type')).toContain('text/html');
    expect(await ui.text()).toContain('Conversation lab');
    expect(ui.headers.get('Cache-Control')).toBe('no-store');
  });
  it.each([{}, { message: '' }, { message: 123 }, { message: 'hi', state: null }, { message: 'hi', state: { version: 999 } }, { message: 'x'.repeat(2001) }])('rejects invalid requests %j', async body => {
    const response = await SELF.fetch('http://localhost/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    expect(response.status).toBe(400);
  });
  it('rejects malformed JSON and wrong media types', async () => {
    const invalid = await SELF.fetch('http://localhost/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' });
    expect(invalid.status).toBe(400);
    const wrong = await SELF.fetch('http://localhost/chat', { method: 'POST', body: 'hello' });
    expect(wrong.status).toBe(415);
  });
  it('bounds request sizes', async () => {
    const response = await SELF.fetch('http://localhost/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: 'x'.repeat(33000) }) });
    expect(response.status).toBe(413);
  });
  it('returns method and path errors', async () => {
    expect((await SELF.fetch('http://localhost/chat')).status).toBe(405);
    expect((await SELF.fetch('http://localhost/missing')).status).toBe(404);
  });
});
