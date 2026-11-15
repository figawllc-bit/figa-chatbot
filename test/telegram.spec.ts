import { describe,expect,it,vi } from 'vitest';
import worker from '../src/index';
import { StaffBot } from '../src/telegram/bot';
import { parseOfficeHours, parseTelegramUpdate } from '../src/telegram/update';
import { formatOfficeHours, modeMessage, staffMessage } from '../src/telegram/summary';
import { SimulatedTelegramTransport,BotAPITransport,TelegramTransportError } from '../src/telegram/transport';
import { telegramWebhook,TelegramPoller } from '../src/telegram/ingress';
import type { StaffRepository,StaffSummary } from '../src/telegram/types';

const id='00000000-0000-4000-8000-000000000001';
const IncomingRequest=Request<unknown,IncomingRequestCfProperties>;
const summary=():StaffSummary=>({id,type:'provider',status:'open',mode:'AI',revision:1,urgent:true,details:{city:'Salem',state:'OR',position:'caregiver',count:'2',date:'tomorrow',shift:'night'}});
const callback=(actor=10001,data=`fg:t:${id}:1`)=>({update_id:5,callback_query:{id:'abc123',from:{id:actor,is_bot:false},message:{chat:{id:actor,type:'private'}},data}});
function fixture() {
  const repository={
    controls:vi.fn<StaffRepository['controls']>().mockResolvedValue({actions:['summary','takeover'],summary:summary()}),
    recipients:vi.fn<StaffRepository['recipients']>().mockResolvedValue([{actor:10001,chat:10001}]),
    process:vi.fn<StaffRepository['process']>().mockResolvedValue({kind:'ok',conversations:[summary()]}),
    summary:vi.fn<StaffRepository['summary']>().mockResolvedValue(summary()),
    pending:vi.fn<StaffRepository['pending']>().mockResolvedValue({kind:'ok',notifications:[{id,leaseToken:id}]}),
    notification:vi.fn<StaffRepository['notification']>().mockResolvedValue({id,kind:'urgent',conversation:summary()}),
    acknowledge:vi.fn<StaffRepository['acknowledge']>().mockResolvedValue(true),
    mode:vi.fn<StaffRepository['mode']>().mockResolvedValue({kind:'ok',mode:'paused',effective:'paused',canChange:true}),
    hours:vi.fn<StaffRepository['hours']>().mockResolvedValue({kind:'ok',mode:'auto',effective:'away',hours:{},canChange:true}),
  };
  const transport=new SimulatedTelegramTransport();return {repository,transport,bot:new StaffBot(repository,transport)};
}

describe('Telegram envelope and privacy boundaries',()=>{
  it('takes actor identity only from the authenticated envelope, never callback/browser fields',()=>{
    const raw={...callback(),staff_user_id:'forged',actor:999,telegram_user_id:999};
    expect(parseTelegramUpdate(raw)).toMatchObject({actor:10001,chat:10001,action:'takeover',conversationId:id,revision:1});
    expect(parseTelegramUpdate(callback(10001,`fg:t:${id}:1:999`))).toBeNull();
  });
  it.each(['group','supergroup','channel'])('ignores %s updates before accessing any conversation',async type=>{
    const f=fixture(),raw=callback();raw.callback_query.message.chat.type=type;
    expect(await f.bot.handle(raw)).toBe('ignored');expect(f.repository.process).not.toHaveBeenCalled();
  });
  it('rejects bot actors, unsafe IDs, mismatched chats and malformed callbacks',()=>{
    const bot=callback();bot.callback_query.from.is_bot=true;expect(parseTelegramUpdate(bot)).toBeNull();
    const wrong=callback();wrong.callback_query.message.chat.id=999;expect(parseTelegramUpdate(wrong)).toBeNull();
    expect(parseTelegramUpdate(callback(Number.MAX_SAFE_INTEGER))).toBeNull();
    expect(parseTelegramUpdate({...callback(),update_id:-1})).toBeNull();
    expect(parseTelegramUpdate(callback(10001,`fg:t:${id}:2147483648`))).toBeNull();
    expect(parseTelegramUpdate({update_id:1,message:{text:'/summary '+id,from:{id:10001,is_bot:false},chat:{id:10001,type:'private'}}})).toMatchObject({action:'summary'});
  });
  it('excludes medical text, names, notes, experience, arbitrary shift/date text and identifiers',()=>{
    const s=summary();s.details={...s.details,city:'Resident dementia',name:'Customer Name',notes:'private note',experience:'medical history',shift:'secret text',date:'secret text',phone:'555-000-1234'};
    const result=staffMessage(s,10001);expect(result.text).toContain('Caregivers needed: 2');
    for(const text of ['dementia','Customer Name','private note','medical history','secret text','555-000-1234'])expect(result.text).not.toContain(text);
    expect(result.protect_content).toBe(true);expect(result.link_preview_options.is_disabled).toBe(true);expect(result).not.toHaveProperty('parse_mode');
    for(const button of result.reply_markup.inline_keyboard.flat())expect(new TextEncoder().encode(button.callback_data).length).toBeLessThanOrEqual(64);
  });
  it('only shows valid actions for AI, human, and closed conversation states',()=>{
    const s=summary(),actions=['summary','takeover','resolve','return_ai'] as const;
    expect(staffMessage(s,1).reply_markup.inline_keyboard).toEqual([]);
    expect(staffMessage(s,1,'Status',actions).reply_markup.inline_keyboard[0].map(b=>b.text)).toEqual(['View Status','Take Over']);
    s.mode='HUMAN';expect(staffMessage(s,1,'Status',actions).reply_markup.inline_keyboard[0].map(b=>b.text)).toEqual(['View Status','Resolve','Return to AI']);
    s.status='closed';expect(staffMessage(s,1,'Status',actions).reply_markup.inline_keyboard[0].map(b=>b.text)).toEqual(['View Status']);
  });
});
describe('Staff service',()=>{
  it.each(['denied','stale','unavailable','conflict'] as const)('does not disclose a summary or send notifications on %s',async kind=>{
    const f=fixture();f.repository.process.mockResolvedValue({kind});
    expect(await f.bot.handle(callback())).toBe(kind);expect(f.transport.messages).toHaveLength(0);expect(f.repository.pending).not.toHaveBeenCalled();
    expect(f.transport.answers[0].text).not.toContain(id);
  });
  it('rechecks authorization before every summary and suppresses a revoked read',async()=>{
    const f=fixture();await f.bot.handle(callback(10001,`fg:s:${id}:1`));expect(f.repository.summary).toHaveBeenCalledWith(10001,10001,id,1);expect(f.transport.messages).toHaveLength(1);
    f.repository.summary.mockResolvedValue(null);await f.bot.handle(callback());expect(f.transport.messages).toHaveLength(1);
  });
  it('uses transactional update IDs and hashes; duplicate updates do not resend action summaries',async()=>{
    const f=fixture();f.repository.process.mockResolvedValue({kind:'duplicate'});f.repository.pending.mockResolvedValue({kind:'ok',notifications:[]});
    await f.bot.handle(callback());expect(f.repository.process.mock.calls[0][1]).toMatch(/^[a-f0-9]{64}$/);expect(f.transport.messages).toHaveLength(0);expect(f.repository.summary).not.toHaveBeenCalled();
  });
  it('dispatches only to roster recipients, reauthorizes each claim, and acknowledges delivery',async()=>{
    const f=fixture();expect(await f.bot.dispatch()).toBe(1);expect(f.transport.messages[0].text).toContain('Urgent staffing alert');expect(f.repository.notification).toHaveBeenCalledWith(10001,10001,{id,leaseToken:id});expect(f.repository.acknowledge).toHaveBeenCalledOnce();
    f.repository.notification.mockResolvedValue(null);expect(await f.bot.dispatch()).toBe(0);expect(f.transport.messages).toHaveLength(1);
  });
  it('does not acknowledge failed transport or disclose anything during database failures',async()=>{
    const f=fixture();vi.spyOn(f.transport,'send').mockRejectedValue(new Error('simulated outage'));
    await expect(f.bot.notify(10001,10001)).rejects.toThrow();expect(f.repository.acknowledge).not.toHaveBeenCalled();
    f.repository.process.mockRejectedValue(new Error('database unavailable'));await expect(f.bot.handle(callback())).rejects.toThrow();expect(f.transport.answers).toHaveLength(0);
  });
  it('still delivers committed action status when a callback acknowledgement has expired',async()=>{
    const f=fixture();f.repository.process.mockResolvedValue({kind:'applied'});
    vi.spyOn(f.transport,'answer').mockRejectedValue(new Error('expired callback'));
    expect(await f.bot.handle(callback())).toBe('applied');expect(f.transport.messages).toHaveLength(1);expect(f.repository.acknowledge).toHaveBeenCalledOnce();
  });
});
describe('Webhook ingress and future polling',()=>{
  const secret='fictional_webhook_secret_1234567890';
  const env={TELEGRAM_STAFF_ENABLED:'true',TELEGRAM_WEBHOOK_ENABLED:'true',TELEGRAM_WEBHOOK_SECRET:secret};
  const request=(url='https://staff.example/telegram/webhook',token=secret,body=JSON.stringify(callback()))=>new Request(url,{method:'POST',headers:{'Content-Type':'application/json','X-Telegram-Bot-Api-Secret-Token':token},body});
  it('is disabled by default and requires HTTPS plus the webhook secret before parsing identities',async()=>{
    const create=vi.fn();expect((await telegramWebhook(request(),{},create)).status).toBe(404);
    expect((await telegramWebhook(request('http://localhost/telegram/webhook'),env,create)).status).toBe(403);
    expect((await telegramWebhook(request(undefined,'wrong'),env,create)).status).toBe(401);expect(create).not.toHaveBeenCalled();
  });
  it('processes authenticated fictional updates, bounds bodies, rejects malformed JSON, and fails closed',async()=>{
    const f=fixture();expect((await telegramWebhook(request(),env,()=>f.bot)).status).toBe(200);
    expect((await telegramWebhook(request(undefined,secret,'x'.repeat(16385)),env,()=>f.bot)).status).toBe(413);
    expect((await telegramWebhook(request(undefined,secret,'{'),env,()=>f.bot)).status).toBe(400);
    f.repository.process.mockRejectedValue(new Error('private database body'));const r=await telegramWebhook(request(),env,()=>f.bot);expect(r.status).toBe(503);expect(await r.text()).not.toContain('private database');
  });
  it('exposes no mock injection or staff administration HTTP endpoints; webhook remains off',async()=>{
    for(const path of ['/telegram/mock','/staff/assign','/staff/roster','/telegram/webhook'])expect((await worker.fetch(new IncomingRequest('http://localhost'+path,{method:'POST'}),{})).status).toBe(404);
    expect((await worker.fetch(new IncomingRequest('https://public.example/',{headers:{Accept:'text/html'}}),{})).status).toBe(404);
  });
  it('advances polling only after successful processing and dispatch; never starts an infinite retry loop',async()=>{
    const f=fixture(),source={updates:vi.fn().mockResolvedValue([callback()])};
    const poller=new TelegramPoller(source,f.bot);expect(await poller.once(0)).toBe(6);
    f.repository.process.mockRejectedValue(new Error('outage'));await expect(poller.once(0)).rejects.toThrow('outage');expect(source.updates).toHaveBeenCalledTimes(2);
  });
});
describe('Official Bot API adapter remains opt in',()=>{
  const token='123456789:fictional_not_a_real_token_12345';
  it('never accesses Telegram when disabled or missing a token',async()=>{
    const transport=vi.fn<typeof fetch>();
    for(const env of [{},{TELEGRAM_BOT_TOKEN:token},{TELEGRAM_LIVE_ENABLED:'true'},{TELEGRAM_LIVE_ENABLED:'true',TELEGRAM_BOT_TOKEN:token}])await expect(new BotAPITransport(env,transport).updates(0)).rejects.toBeInstanceOf(TelegramTransportError);
    expect(transport).not.toHaveBeenCalled();
  });
  it('uses fixed Bot API methods, bounded polling, private messages and manual redirects',async()=>{
    const transport=vi.fn<typeof fetch>().mockResolvedValue(Response.json({ok:true,result:[]}));
    const api=new BotAPITransport({TELEGRAM_STAFF_ENABLED:'true',TELEGRAM_LIVE_ENABLED:'true',TELEGRAM_BOT_TOKEN:token},transport);
    expect(await api.updates(6)).toEqual([]);const [url,options]=transport.mock.calls[0];expect(url).toBe(`https://api.telegram.org/bot${token}/getUpdates`);expect(options?.redirect).toBe('manual');expect(JSON.parse(options?.body as string)).toMatchObject({offset:6,timeout:5,limit:20});
  });
  it.each([302,401,429,500])('does not retry or leak token-bearing upstream errors on HTTP %s',async status=>{
    const transport=vi.fn<typeof fetch>().mockResolvedValue(new Response('private token text',{status}));
    await expect(new BotAPITransport({TELEGRAM_STAFF_ENABLED:'true',TELEGRAM_LIVE_ENABLED:'true',TELEGRAM_BOT_TOKEN:token},transport).updates(0)).rejects.toThrow('Telegram operation unavailable.');expect(transport).toHaveBeenCalledOnce();
  });
});

describe('Telegram global bot mode (Away / On Duty / Pause all)',()=>{
  const text=(t:string,actor=10001)=>({update_id:9,message:{from:{id:actor,is_bot:false},chat:{id:actor,type:'private'},text:t}});
  it.each([['/status',null],['/away','away'],['/resume','away'],['/onduty','on_duty'],['/pause','paused']] as const)('parses %s',(command,mode)=>{
    expect(parseTelegramUpdate(text(command))).toMatchObject({action:'mode',mode,conversationId:null,revision:null});
  });
  it('parses mode buttons and rejects unknown modes',()=>{
    expect(parseTelegramUpdate(callback(10001,'fg:m:paused'))).toMatchObject({action:'mode',mode:'paused',callbackId:'abc123'});
    expect(parseTelegramUpdate(callback(10001,'fg:m:everything'))).toBeNull();
    expect(parseTelegramUpdate(text('/pause now'))).toBeNull();
  });
  it('a change is announced to every roster member; only the changer gets buttons',async()=>{
    const f=fixture();f.repository.mode.mockResolvedValue({kind:'applied',mode:'on_duty',effective:'on_duty',hours:{'1':['08:00','17:00'],'2':['08:00','17:00']},timezone:'America/Los_Angeles',canChange:true});
    f.repository.recipients.mockResolvedValue([{actor:10001,chat:10001},{actor:10002,chat:10002}]);
    expect(await f.bot.handle(text('/onduty'))).toBe('applied');
    expect(f.repository.mode).toHaveBeenCalledWith(expect.objectContaining({mode:'on_duty',actor:10001}),expect.stringMatching(/^[a-f0-9]{64}$/));
    expect(f.repository.process).not.toHaveBeenCalled();
    const [mine,theirs]=f.transport.messages;
    expect(mine.chat_id).toBe(10001);expect(mine.text).toMatch(/ON DUTY/);expect(mine.reply_markup.inline_keyboard.flat().map(b=>b.callback_data)).toEqual(['fg:m:auto','fg:m:away','fg:m:paused']);expect(mine.text).toMatch(/Office hours: Mon-Tue 08:00-17:00 \(America\/Los_Angeles\)/);
    expect(theirs.chat_id).toBe(10002);expect(theirs.text).toMatch(/by a staff member/);expect(theirs.reply_markup.inline_keyboard).toEqual([]);
  });
  it('denied changes send nothing, and a single-conversation test scope can never switch the global mode',async()=>{
    const f=fixture();f.repository.mode.mockResolvedValue({kind:'denied'});
    expect(await f.bot.handle(text('/pause'))).toBe('denied');expect(f.transport.messages).toHaveLength(0);
    expect(await f.bot.handle(text('/pause'),{actor:10001,conversationId:id})).toBe('ignored');expect(f.repository.mode).toHaveBeenCalledTimes(1);
  });
  it('view-only status has no buttons',()=>{
    expect(modeMessage({mode:'paused',effective:'paused'},1,false).reply_markup.inline_keyboard).toEqual([]);
    expect(modeMessage({mode:'paused',effective:'paused'},1,true).text).toMatch(/PAUSED - the bot is off/);
  });
});

describe('Telegram office hours (/auto, /sethours)',()=>{
  const text=(t:string,actor=10001)=>({update_id:11,message:{from:{id:actor,is_bot:false},chat:{id:actor,type:'private'},text:t}});
  it('parses day ranges, lists and multiple windows',()=>{
    expect(parseOfficeHours('mon-fri 08:00-17:00 sat 09:00-12:00')).toEqual({'1':['08:00','17:00'],'2':['08:00','17:00'],'3':['08:00','17:00'],'4':['08:00','17:00'],'5':['08:00','17:00'],'6':['09:00','12:00']});
    expect(parseOfficeHours('Mon,Wed 07:30-24:00')).toEqual({'1':['07:30','24:00'],'3':['07:30','24:00']});
    expect(parseOfficeHours('none')).toEqual({});
  });
  it.each(['mon-fri','mon-fri 17:00-08:00','fri-mon 08:00-17:00','mon 8-5','mon 08:00-17:00 mon 09:00-10:00','funday 08:00-17:00','mon 25:00-26:00'])('rejects %s',spec=>{
    expect(parseOfficeHours(spec)).toBeNull();expect(parseTelegramUpdate(text('/sethours '+spec))).toBeNull();
  });
  it('maps /auto, /hours and the Auto button to the mode action',()=>{
    expect(parseTelegramUpdate(text('/auto'))).toMatchObject({action:'mode',mode:'auto'});
    expect(parseTelegramUpdate(text('/hours'))).toMatchObject({action:'mode',mode:null});
    expect(parseTelegramUpdate(callback(10001,'fg:m:auto'))).toMatchObject({action:'mode',mode:'auto'});
    expect(parseTelegramUpdate(text('/sethours mon-fri 08:00-17:00'))).toMatchObject({action:'hours',hours:{'5':['08:00','17:00']}});
  });
  it('sends /sethours to the hours RPC and announces the change',async()=>{
    const f=fixture();f.repository.hours.mockResolvedValue({kind:'applied',mode:'auto',effective:'on_duty',hours:{'1':['09:00','15:00']},timezone:'America/Los_Angeles',canChange:true});
    expect(await f.bot.handle(text('/sethours mon 09:00-15:00'))).toBe('applied');
    expect(f.repository.hours).toHaveBeenCalledWith(expect.objectContaining({hours:{'1':['09:00','15:00']}}),expect.any(String));expect(f.repository.mode).not.toHaveBeenCalled();
    const msg=f.transport.messages[0];expect(msg.text).toMatch(/^Office hours changed\nAUTO - following office hours\. Right now:\nON DUTY/);expect(msg.text).toMatch(/Mon 09:00-15:00/);
  });
  it('formats grouped hours and refuses an inconsistent manual status',()=>{
    expect(formatOfficeHours({'1':['08:00','17:00'],'2':['08:00','17:00'],'3':['08:00','17:00'],'6':['09:00','12:00']})).toBe('Mon-Wed 08:00-17:00, Sat 09:00-12:00');
    expect(formatOfficeHours({})).toBe('none set');
    expect(()=>modeMessage({mode:'away',effective:'paused'},1,true)).toThrow();
  });
  it('labels hand-reply alerts for staff',async()=>{
    const f=fixture();f.repository.notification.mockResolvedValue({id,kind:'hand_reply',conversation:summary()});
    expect(await f.bot.notify(10001,10001)).toBe(1);expect(f.transport.messages[0].text).toMatch(/^Bot stopped on this conversation: someone replied to the customer by hand/);
  });
});
