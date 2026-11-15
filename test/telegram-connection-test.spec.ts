import { describe,expect,it,vi } from 'vitest';
import { BotAPITransport,TelegramTransportError } from '../src/telegram/transport';
import { connectionTestMode,runConnectionTest,type SendAttemptGuard } from '../src/telegram/connection-test';
import { CONNECTION_TEST_USER,CONNECTION_TEST_BOT,CONNECTION_TEST_TEXT,connectionTestMessage } from '../src/telegram/connection-test-policy';

const token='123456789:fictional_not_a_real_token_12345';
const bot={id:123456789,is_bot:true as const,username:CONNECTION_TEST_BOT};
function fixture() {
  let reserved=false;
  const commit=vi.fn().mockResolvedValue(undefined);
  const guard={exists:vi.fn(async()=>reserved),reserve:vi.fn(async()=>{if(reserved)throw new Error('Already reserved.');reserved=true;return commit;})} satisfies SendAttemptGuard;
  const api={getMe:vi.fn().mockResolvedValue(bot),sendConnectionTest:vi.fn().mockResolvedValue(undefined)};
  const repository={recipients:vi.fn().mockResolvedValue([{actor:CONNECTION_TEST_USER,chat:CONNECTION_TEST_USER}])};
  return {api,repository,guard,commit};
}
describe('Controlled connection test',()=>{
  it('defaults to dry run; rejects ambiguous or unknown flags before any network operation',()=>{
    expect(connectionTestMode([])).toBe('DRY_RUN');expect(connectionTestMode(['--dry-run'])).toBe('DRY_RUN');expect(connectionTestMode(['--send'])).toBe('SEND');
    for(const flags of [['--send','--dry-run'],['--send','--send'],['--force'],['--chat-id','999']])expect(()=>connectionTestMode(flags)).toThrow();
  });
  it('verifies bot identity and active authorized private roster membership without sending or reserving',async()=>{
    const f=fixture(),report=await runConnectionTest('DRY_RUN',f.api,f.repository,f.guard);
    expect(report).toMatchObject({mode:'DRY_RUN',botIdentityVerified:true,staffAuthorizationVerified:true,readyForSending:true,sendAttempted:false,messageSent:false,errors:[]});
    expect(f.api.getMe).toHaveBeenCalledOnce();expect(f.repository.recipients).toHaveBeenCalledOnce();
    expect(f.api.sendConnectionTest).not.toHaveBeenCalled();expect(f.guard.reserve).not.toHaveBeenCalled();
  });
  it('fails closed on incorrect bot identity and does not expose unexpected bot details',async()=>{
    const f=fixture();f.api.getMe.mockResolvedValue({...bot,username:'unexpected_bot'});
    const report=await runConnectionTest('SEND',f.api,f.repository,f.guard);
    expect(report.botIdentityVerified).toBe(false);expect(f.repository.recipients).not.toHaveBeenCalled();expect(f.api.sendConnectionTest).not.toHaveBeenCalled();
    expect(JSON.stringify(report)).not.toContain('unexpected_bot');
  });
  it.each([{recipients:[]},{recipients:[{actor:CONNECTION_TEST_USER,chat:999}]},{recipients:[{actor:999,chat:CONNECTION_TEST_USER}]}])('rejects absent/inactive/unbound view authorization represented by the roster RPC: %j',async ({recipients})=>{
    const f=fixture();f.repository.recipients.mockResolvedValue(recipients);
    const report=await runConnectionTest('SEND',f.api,f.repository,f.guard);
    expect(report.staffAuthorizationVerified).toBe(false);expect(f.guard.reserve).not.toHaveBeenCalled();expect(f.api.sendConnectionTest).not.toHaveBeenCalled();
  });
  it('never exposes tokens or database error bodies',async()=>{
    for(const stage of ['bot','database']) {
      const f=fixture();if(stage==='bot')f.api.getMe.mockRejectedValue(new Error(token));else f.repository.recipients.mockRejectedValue(new Error('sb_secret_private_fixture'));
      const report=await runConnectionTest('SEND',f.api,f.repository,f.guard);
      expect(JSON.stringify(report)).not.toContain(token);expect(JSON.stringify(report)).not.toContain('sb_secret_private_fixture');expect(f.api.sendConnectionTest).not.toHaveBeenCalled();
    }
  });
  it('sends once only after confirmation and reserves before sending',async()=>{
    const f=fixture();f.api.sendConnectionTest.mockImplementation(async()=>{expect(f.guard.reserve).toHaveBeenCalledOnce();});
    const first=await runConnectionTest('SEND',f.api,f.repository,f.guard);expect(first.messageSent).toBe(true);expect(f.commit).toHaveBeenCalledOnce();
    const second=await runConnectionTest('SEND',f.api,f.repository,f.guard);expect(second.previousAttemptRecorded).toBe(true);expect(second.readyForSending).toBe(false);expect(f.api.sendConnectionTest).toHaveBeenCalledOnce();
  });
  it('reserves atomically against competing sends and never retries uncertain failures',async()=>{
    const f=fixture();f.api.sendConnectionTest.mockRejectedValue(new Error('token-bearing timeout'));
    await Promise.all([runConnectionTest('SEND',f.api,f.repository,f.guard),runConnectionTest('SEND',f.api,f.repository,f.guard)]);
    expect(f.api.sendConnectionTest).toHaveBeenCalledOnce();expect(f.commit).not.toHaveBeenCalled();
    const dry=await runConnectionTest('DRY_RUN',f.api,f.repository,f.guard);expect(dry.previousAttemptRecorded).toBe(true);expect(dry.readyForSending).toBe(false);
  });
});
describe('Scoped existing Bot API transport',()=>{
  it('uses getMe with flags disabled; dry-run transport rejects every messaging/polling path',async()=>{
    const network=vi.fn<typeof fetch>().mockResolvedValue(Response.json({ok:true,result:bot}));
    const api=BotAPITransport.forConnectionTest(token,false,network);
    expect(await api.getMe()).toEqual(bot);expect(network.mock.calls[0][0]).toBe(`https://api.telegram.org/bot${token}/getMe`);
    await expect(api.sendConnectionTest()).rejects.toBeInstanceOf(TelegramTransportError);
    await expect(api.updates(0)).rejects.toBeInstanceOf(TelegramTransportError);
    await expect(api.answer('callback','hello')).rejects.toBeInstanceOf(TelegramTransportError);
    await expect(api.send({...connectionTestMessage(),reply_markup:{inline_keyboard:[]}})).rejects.toBeInstanceOf(TelegramTransportError);
    expect(network).toHaveBeenCalledOnce();
  });
  it('sends exactly the approved fixed text and recipient with no buttons or paid broadcasting',async()=>{
    const network=vi.fn<typeof fetch>().mockResolvedValue(Response.json({ok:true,result:{message_id:42,text:CONNECTION_TEST_TEXT,chat:{id:CONNECTION_TEST_USER,type:'private'}}}));
    const api=BotAPITransport.forConnectionTest(token,true,network);await api.sendConnectionTest();
    const [url,options]=network.mock.calls[0];expect(url).toBe(`https://api.telegram.org/bot${token}/sendMessage`);
    const message=JSON.parse(options?.body as string);expect(message).toEqual(connectionTestMessage());expect(message).not.toHaveProperty('reply_markup');expect(message).not.toHaveProperty('allow_paid_broadcast');expect(options?.redirect).toBe('manual');
    await expect(api.sendConnectionTest()).rejects.toBeInstanceOf(TelegramTransportError);expect(network).toHaveBeenCalledOnce();
  });
  it('burns an attempt on network failure and never exposes the token',async()=>{
    const network=vi.fn<typeof fetch>().mockRejectedValue(new Error(`https://api.telegram.org/bot${token}/sendMessage`));
    const api=BotAPITransport.forConnectionTest(token,true,network);
    for(let i=0;i<2;i++)await expect(api.sendConnectionTest()).rejects.toThrow('Telegram operation unavailable.');
    expect(network).toHaveBeenCalledOnce();
  });
  it('rejects incorrect send receipts rather than claiming successful delivery',async()=>{
    const network=vi.fn<typeof fetch>().mockResolvedValue(Response.json({ok:true,result:{message_id:42,text:CONNECTION_TEST_TEXT,chat:{id:999,type:'private'}}}));
    await expect(BotAPITransport.forConnectionTest(token,true,network).sendConnectionTest()).rejects.toThrow('Telegram operation unavailable.');
  });
  it('keeps the original application transport disabled without its feature flags',async()=>{
    const network=vi.fn<typeof fetch>();const api=new BotAPITransport({TELEGRAM_BOT_TOKEN:token},network);
    await expect(api.getMe()).rejects.toBeInstanceOf(TelegramTransportError);await expect(api.sendConnectionTest()).rejects.toBeInstanceOf(TelegramTransportError);expect(network).not.toHaveBeenCalled();
  });
});
