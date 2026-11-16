import type { TelegramEnvironment, TelegramMessage, TelegramTransport } from './types';
import { record } from './update';
import { connectionTestMessage, CONNECTION_TEST_USER, CONNECTION_TEST_TEXT } from './connection-test-policy';

export class SimulatedTelegramTransport implements TelegramTransport {
  readonly messages:TelegramMessage[]=[];
  readonly answers:{callbackId:string;text:string}[]=[];
  async send(message:TelegramMessage) { this.messages.push(structuredClone(message)); }
  async answer(callbackId:string,text:string) { this.answers.push({callbackId,text}); }
}
export class TelegramTransportError extends Error { constructor() { super('Telegram operation unavailable.'); } }

// Never constructed by default. No credentials are needed for the simulated transport.
export class BotAPITransport implements TelegramTransport {
  private connectionTest?: { allowSend:boolean; attempted:boolean };
  private notificationTest?: { allowSend:boolean; attempted:boolean; body:string };
  constructor(private readonly env:TelegramEnvironment,private readonly transport:typeof fetch=fetch) {}
  // Narrow CLI-only capability. It never enables or changes application feature flags.
  static forConnectionTest(token:string,allowSend=false,transport:typeof fetch=fetch) {
    const api=new BotAPITransport({TELEGRAM_BOT_TOKEN:token},transport);
    api.connectionTest={allowSend,attempted:false};
    return api;
  }
  static forNotificationTest(token:string,message:TelegramMessage,allowSend=false,transport:typeof fetch=fetch) {
    if(message.chat_id!==CONNECTION_TEST_USER||message.protect_content!==true||message.link_preview_options.is_disabled!==true||message.reply_markup.inline_keyboard.length!==0)throw new TelegramTransportError();
    const api=new BotAPITransport({TELEGRAM_BOT_TOKEN:token},transport);
    api.notificationTest={allowSend,attempted:false,body:JSON.stringify(message)};
    return api;
  }
  private async call(method:'sendMessage'|'answerCallbackQuery'|'getUpdates'|'getMe'|'getWebhookInfo'|'setWebhook',body:unknown):Promise<unknown> {
    if(!/^\d{5,20}:[A-Za-z0-9_-]{20,}$/.test(this.env.TELEGRAM_BOT_TOKEN??'')) throw new TelegramTransportError();
    if(this.notificationTest) {
      if(method!=='getMe') {
        if(method!=='sendMessage'||!this.notificationTest.allowSend||this.notificationTest.attempted||JSON.stringify(body)!==this.notificationTest.body)throw new TelegramTransportError();
        this.notificationTest.attempted=true;
      }
    } else if(this.connectionTest) {
      if(method!=='getMe') {
        if(method!=='sendMessage' || !this.connectionTest.allowSend || this.connectionTest.attempted || JSON.stringify(body)!==JSON.stringify(connectionTestMessage()))throw new TelegramTransportError();
        // Burn the single attempt before network I/O, including timeout/failure cases.
        this.connectionTest.attempted=true;
      }
    } else if(this.env.TELEGRAM_STAFF_ENABLED!=='true' || this.env.TELEGRAM_LIVE_ENABLED!=='true') throw new TelegramTransportError();
    try {
      const r=await this.transport.call(globalThis,`https://api.telegram.org/bot${this.env.TELEGRAM_BOT_TOKEN}/${method}`,{
        method:'POST',redirect:'manual',signal:AbortSignal.timeout(10000),headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
      if(!r.ok) { await r.body?.cancel(); throw new TelegramTransportError(); }
      const reader=r.body?.getReader();
      if(!reader) throw new TelegramTransportError();
      const chunks:Uint8Array[]=[];let size=0;
      while(true) { const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>131072){await reader.cancel();throw new TelegramTransportError();}chunks.push(value); }
      const bytes=new Uint8Array(size);let offset=0;for(const part of chunks){bytes.set(part,offset);offset+=part.length;}
      const payload=record(JSON.parse(new TextDecoder().decode(bytes)));
      if(payload.ok!==true) throw new TelegramTransportError();
      return payload.result;
    } catch { throw new TelegramTransportError(); } // Never log token-bearing URLs or Telegram bodies.
  }
  async getMe():Promise<{id:number;username:string;is_bot:true}> {
    const result=record(await this.call('getMe',{}));
    if(!Number.isSafeInteger(result.id)||Number(result.id)<=0||result.is_bot!==true||typeof result.username!=='string')throw new TelegramTransportError();
    return {id:Number(result.id),username:result.username,is_bot:true};
  }
  /** Points Telegram at our webhook; Telegram then sends that secret in X-Telegram-Bot-Api-Secret-Token. */
  async setWebhook(url:string,secret:string):Promise<void> {
    if(!/^https:\/\/[a-z0-9.-]+\/telegram\/webhook$/.test(url)||!/^[A-Za-z0-9_-]{32,256}$/.test(secret))throw new TelegramTransportError();
    if(await this.call('setWebhook',{url,secret_token:secret,allowed_updates:['message','callback_query'],drop_pending_updates:false})!==true)throw new TelegramTransportError();
  }
  async getWebhookInfo():Promise<{url:string}> {
    const result=record(await this.call('getWebhookInfo',{}));
    if(typeof result.url!=='string')throw new TelegramTransportError();
    return {url:result.url};
  }
  async sendConnectionTest():Promise<void> {
    if(!this.connectionTest)throw new TelegramTransportError();
    const result=record(await this.call('sendMessage',connectionTestMessage()));
    const chat=record(result.chat);
    if(!Number.isSafeInteger(result.message_id)||Number(result.message_id)<=0||chat.id!==CONNECTION_TEST_USER||chat.type!=='private'||result.text!==CONNECTION_TEST_TEXT)throw new TelegramTransportError();
  }
  async send(message:TelegramMessage) {
    const result=await this.call('sendMessage',message);
    if(this.notificationTest) {
      const receipt=record(result),chat=record(receipt.chat);
      if(!Number.isSafeInteger(receipt.message_id)||Number(receipt.message_id)<=0||chat.id!==CONNECTION_TEST_USER||chat.type!=='private'||receipt.text!==message.text)throw new TelegramTransportError();
    }
  }
  async answer(callbackId:string,text:string) { await this.call('answerCallbackQuery',{callback_query_id:callbackId,text}); }
  async updates(offset:number,limit=20):Promise<unknown[]> {
    if(!Number.isSafeInteger(offset)||offset<0||!Number.isInteger(limit)||limit<1||limit>20) throw new TelegramTransportError();
    const result=await this.call('getUpdates',{offset,timeout:5,limit,allowed_updates:['message','callback_query']});
    if(!Array.isArray(result)) throw new TelegramTransportError();
    return result;
  }
}
