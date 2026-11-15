# Texting number registration pack (10DLC / toll-free)

Carriers require business texting numbers to be registered before automated replies are delivered. RingCentral runs this registration (TCR/10DLC for local numbers, verification for toll-free numbers). It can take days to weeks, so **start it first**. Use the texts below in RingCentral's registration form, adjusted to FIGA's real details. Requirements: [RingCentral SMS requirements](https://developers.ringcentral.com/guide/messaging/sms/sms-requirements).

## FIGA must provide (business identity)
- Legal business name exactly as registered with the IRS, EIN, and business address
- Website (with a privacy policy, see below), support email and phone
- The texting number to register (the one customers already text, on extension 101)

## Campaign
- **Use case:** Customer Care. Every message is a reply to a person who texted FIGA first; the assistant never starts conversations or sends marketing.
- **Description:**
  > FIGA Staffing connects adult foster homes and group homes in Oregon with caregivers. People text FIGA's business number to request caregivers or to ask about caregiver jobs. An automated assistant replies to their texts, collects basic details (location, position, shift, availability) and hands the conversation to FIGA staff when needed. FIGA does not send marketing or unsolicited messages.
- **How people opt in (message flow):**
  > Customers start the conversation by texting FIGA's business number, which is published on FIGA's website and materials. FIGA only replies to inbound messages. The first reply identifies the automated assistant and says "Reply STOP to opt out."
- **Opt-out keywords:** STOP, STOPALL, UNSUBSCRIBE, CANCEL, END, QUIT. After STOP the assistant sends nothing more to that number (enforced in the database).
- **Help keywords:** HELP, INFO. Help reply (sent automatically, never AI-generated):
  > FIGA automated assistant for caregiver jobs and provider staffing requests. Text your question here and a FIGA team member can follow up. Msg & data rates may apply. Reply STOP to opt out.
- **Embedded links:** no. **Embedded phone numbers:** no. **Age-gated content:** no. **Direct lending:** no.

## Sample messages (the bot's real replies)
1. Provider asking for help:
   > This is FIGA's automated assistant. I can collect the basic details. This does not confirm staffing or employment. What is your name? Reply STOP to opt out.
2. Question about FIGA:
   > This is FIGA's automated assistant. FIGA Staffing helps connect adult foster home and group home providers with caregivers seeking employment opportunities. Are you requesting caregivers or looking for work? Reply STOP to opt out.
3. Follow-up question during intake:
   > What is your name?
4. Help keyword reply: the HELP text above.

## Website privacy policy (carriers check this)
Include a sentence like: "Mobile numbers and SMS opt-in information are not shared with or sold to third parties for marketing purposes." Also state that message and data rates may apply and that people can reply STOP to opt out or HELP for help.

## Notes
- Register only the one number the bot answers on (`RINGCENTRAL_SMS_FROM_NUMBER`). Voice access to a shared number does not make it SMS-capable.
- Some carriers or RingCentral may also answer STOP/HELP themselves. If you see double help replies once live, tell us and the bot's HELP reply can be turned off.
- These samples come from the rule-based replies; with Gemma approved the wording of follow-up questions stays the same, because the application, not the AI, writes every reply.
