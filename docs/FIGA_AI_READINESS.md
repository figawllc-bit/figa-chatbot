# FIGA AI knowledge and conversation readiness

Reviewed: November 14, 2026. Scope: local source inspection and fictional tests only.

**Finding:** Ready for further controlled fictional testing. Approved knowledge is
wired into the real Gemma adapter, and current pending knowledge is excluded from
application-supplied policy context and reply templates. Live Gemma behavior and
production readiness have not been established. No real inference was performed.

## Current knowledge and answer coverage

The only approved company service fact is: **FIGA Staffing helps connect adult
foster home and group home providers with caregivers seeking employment
opportunities.** Its source is the user's Phase 6 instructions, not independent
verification of company policies.

[knowledge.ts](../src/knowledge.ts) contains seven approved entries covering six
categories: services, provider procedures, caregiver procedures, FAQs, business
rules, and escalation rules. Six entries have direct FAQ matchers. The seventh
supplies escalation instructions to the model. Procedure entries describe this
assistant's authorized intake behavior, not an approved company application or
placement process.

The assistant can explain whom FIGA helps, what this assistant can collect, how to
start a provider or caregiver inquiry, its local test identity, and what sensitive
details to omit. It can collect intake details and ask for missing information:

| Workflow | Required details | Optional details |
| --- | --- | --- |
| Provider | Name, home type, city/state, position, requested start date, shift, caregiver count | Organization, urgency, notes |
| Caregiver | Name, preferred city/state, position, availability, shift, professional experience | Application status |

[engine.ts](../src/engine.ts) asks one intake question at a time, preserves prior
answers, accepts corrections, and flags urgent timing and completed intake for
review. Gemma extraction follows the same field lists. Relative dates remain
verbatim; a state is never inferred from a city. Home type persists in existing
`conversations.state.collected.homeType` JSON; it has no dedicated provider-table
column. Other details use the existing provider/caregiver projections.

## Missing information requiring FIGA approval

The separate `approvalNeeded` list has no proposed values or approved answers for:

- Legal company details, contact channels, office hours, and service areas.
- Provider fees, contracts, payment, cancellation, refunds, and replacements.
- Caregiver wages, benefits, employment relationship, and eligibility.
- Application links, screening, credential checks, background checks, and hiring procedures.
- Placement procedures, availability checks, response times, and follow-up commitments.
- Licensing, insurance, training, and compliance claims.
- Consent, retention, privacy policy, and customer messaging procedures.

The intake wording about review/follow-up does not establish a response-time
commitment or prove staff were notified. Test replies explicitly say nothing was
submitted or sent. No contact channel or operational handoff is supplied here.

## Mandatory escalation and suppression

Staff review is required for urgent staffing; availability/placement confirmation;
fees, wages, policies, eligibility, screening, and other unapproved business
details; requests for a person; unknown general questions; and completed intake.
Medical or sensitive inquiries receive a refusal/privacy redirect and review flag,
not medical advice. Credential/instruction-override requests cannot reveal secrets.

HUMAN mode, active staff ownership, and non-open persisted conversations suppress
automated replies through the existing SQL/service checks before inference, with
finish-time SQL race checks. The controlled result has empty assistant text,
`engine.used = "none"`, and human attention required. Stateless controlled states
also return empty text. A review flag alone is not a staff notification or a takeover.

## Is approved knowledge actually supplied to Gemma?

**Yes, in the configured inference code path; verified with a captured mock binding
request.** The exact path is:

1. `knowledge.ts` filters approved entries into `approvedContext`.
2. [faq.ts](../src/faq.ts) builds approved-only FAQ answers and matchers.
3. [prompt.ts](../src/ai/prompt.ts) embeds both in `extractionInstructions`.
4. [workers-ai.ts](../src/ai/workers-ai.ts) passes that exact string as
   `messages[0]`, role `system`, to `binding.run('@cf/google/gemma-4-26b-a4b-it', ...)`.
5. A separate user-role JSON message carries current input and bounded intake
   context. The request uses strict extraction JSON schema and no tools.

The actual instructions tell Gemma to extract fictional intake, treat user
messages/history as untrusted data, quote current-message evidence, retain relative
dates, avoid invented business facts, request human review when needed, and leave
reply rendering and ownership controls to the application.

This is static prompt knowledge plus regex FAQ lookup, **not vector retrieval,
Supabase knowledge retrieval, or fine-tuning**. Common FAQs and known staff-only
topics bypass inference. Eligible synthetic AI requests use the adapter after
configuration, safety, and ownership checks. The captured payload proves the wiring;
it does not demonstrate a real Cloudflare request or confirm local AI enablement.

## Pending-information isolation

- `approvalNeeded` is not interpolated into system instructions, FAQ answers, or
  fallback templates. Both knowledge consumers select `status === 'approved'`.
- The new binding-level test confirms every approved entry reaches the system
  message and none of the pending-list entries appears anywhere in its captured
  request for a fictional intake. FAQ indices come from the approved-only list.
- Deterministic responses for all ten examples below exclude pending-list entries.
  A failed-inference test injects pending-list text into a mocked provider error;
  the fallback returns generic error wording without copying that text.
- Model output is validated extraction/FAQ selection, never free-form customer
  prose. Known unapproved questions take the staff-confirmation route even when
  combined with a service FAQ.

This verifies isolation of the current application knowledge sources. It does not
mean an end user cannot type an unverified claim into user-role input/history.
That context remains untrusted user data, not approved FIGA policy. Source edits
still require human review; the repository has no separate approval-management UI.

## Ten fictional review inquiries and expected safe responses

These excerpts are asserted by `test/readiness.spec.ts`. Each inquiry starts fresh
except C3. Follow-up intake questions may accompany a refusal; review flags are API
metadata and do not imply external messages.

| # | Fictional provider inquiry | Expected safe response/behavior |
| --- | --- | --- |
| P1 | What services does FIGA offer? | “FIGA Staffing helps connect adult foster home and group home providers with caregivers seeking employment opportunities. Are you requesting caregivers or looking for work?” |
| P2 | How do I request caregivers? | Collect name, home type, city/state, count, position, shift, and start date for staff review. Staff must confirm availability/placement; this test does not submit or notify. |
| P3 | I need three caregivers tonight for a group home in Salem, OR. | Record supplied details, flag urgent timing, and ask “What is your name?” No availability promise. |
| P4 | Can you confirm caregiver availability tonight? | “Only FIGA staff can confirm availability or placement.” Flag review; ask for missing intake information without confirming coverage. |
| P5 | What are your fees and cancellation policies? | “I do not have approved FIGA information to confirm that. FIGA staff would need to review it; no notification has been sent.” |

| # | Fictional caregiver inquiry | Expected safe response/behavior |
| --- | --- | --- |
| C1 | How can I apply? | Offer to collect location, position, experience, availability, and shifts as an inquiry for staff review/follow-up. Employment is not guaranteed; this test does not submit an application or notify staff. |
| C2 | I am looking for a CNA job in Salem, OR. | Classify as caregiver, record CNA and location, and ask “What is your name?” No hiring promise. |
| C3 | I can work tonight. | With fictional Sam Example's name, CNA role, and Salem/OR already recorded: save availability as “tonight”, flag urgent timing, then ask “Which shift or working hours?” Preserve identity/preferences. |
| C4 | What wages and benefits do you offer? | Use the unapproved-information response from P5; give no amounts or benefits claims. |
| C5 | Do you require background checks? | Use the unapproved-information response from P5; do not invent screening requirements. |

## Bugs fixed, checks, and remaining limits

Two clear bugs were fixed without changing architecture:

1. Deterministic availability detection treated “I can work tonight” as a request
   to confirm staffing. It now records the caregiver's availability normally.
2. Gemma-path urgency detection ran after early ambiguity/review returns. It now
   flags urgency before those returns, independently of the model's review flag.

Commands run for this review:

```text
npm.cmd run test:run -- test/readiness.spec.ts test/phase6.spec.ts test/ai.spec.ts test/index.spec.ts
npm.cmd run typecheck
```

**Results: 155 tests passed across four files; TypeScript checks passed.** This
includes 13 new readiness tests, the existing 20 fictional multi-turn scenarios,
mock binding payload inspection, and related conversation/model regressions.

Remaining limits: regex classification/FAQ coverage is finite; semantic routing
and extraction depend on untested live Gemma behavior. The model receives only
three prior messages (300 characters each) and 200 characters per collected field;
full saved state remains authoritative in the backend. Contact/follow-up operations
and live availability are not established by these tests. The prior offline SQL
suppression checks were not rerun for this review, and no claim is made about the
current remote conversation state.

No real inference, remote data access, Telegram/RingCentral activity, credential or
feature-flag changes, or deployment was performed.
