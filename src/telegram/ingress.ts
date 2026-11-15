import { StaffBot } from './bot';
import { BotAPITransport } from './transport';
import { record } from './update';
import type { TelegramEnvironment } from './types';

async function equalSecret(a:string,b:string) {
  const hash=(s:string)=>crypto.subtle.digest('SHA-256',new TextEncoder().encode(s));
  const [x,y]=await Promise.all([hash(a),hash(b)]);
  const left=new Uint8Array(x),right=new Uint8Array(y);let difference=0;
  for(let i=0;i<left.length;i++)difference|=left[i]^right[i];
  return difference===0;
}
export async function telegramWebhook(request:Request,env:TelegramEnvironment,createBot:()=>StaffBot):Promise<Response> {
  const json=(body:unknown,status=200)=>Response.json(body,{status,headers:{'Cache-Control':'no-store'}});
  if(env.TELEGRAM_STAFF_ENABLED!=='true'||env.TELEGRAM_WEBHOOK_ENABLED!=='true')return json({error:'Not found.'},404);
  if(new URL(request.url).protocol!=='https:')return json({error:'HTTPS required.'},403);
  if(request.method!=='POST')return json({error:'Method not allowed.'},405);
  const secret=env.TELEGRAM_WEBHOOK_SECRET??'';
  const received=request.headers.get('X-Telegram-Bot-Api-Secret-Token')??'';
  if(!/^[A-Za-z0-9_-]{32,256}$/.test(secret)||received.length>256||!await equalSecret(secret,received))return json({error:'Unauthorized.'},401);
  if(!request.headers.get('Content-Type')?.toLowerCase().startsWith('application/json'))return json({error:'Use application/json.'},415);
  try {
    const reader=request.body?.getReader();if(!reader)return json({error:'Invalid update.'},400);
    let bytes=0;const parts:Uint8Array[]=[];
    while(true){const {done,value}=await reader.read();if(done)break;bytes+=value.length;if(bytes>16384){await reader.cancel();return json({error:'Update too large.'},413);}parts.push(value);}
    const content=new Uint8Array(bytes);let offset=0;for(const part of parts){content.set(part,offset);offset+=part.length;}
    const raw=JSON.parse(new TextDecoder().decode(content));
    await createBot().handle(raw);
    return json({ok:true});
  } catch(error) {return json({error:error instanceof SyntaxError?'Invalid JSON.':'Staff update unavailable.'},error instanceof SyntaxError?400:503);}
}

// One bounded polling pass. Caller checkpoints the returned offset only on success.
// No polling loop or webhook registration is started by importing this module.
export class TelegramPoller {
  constructor(private readonly source:Pick<BotAPITransport,'updates'>,private readonly bot:StaffBot) {}
  /** onResult receives only the outcome word for each update (ok/denied/ignored...), never content. */
  async once(offset:number,onResult?:(kind:string)=>void):Promise<number> {
    const updates=await this.source.updates(offset);let next=offset;
    for(const raw of updates) {
      const id=record(raw).update_id;
      if(!Number.isSafeInteger(id)||Number(id)<offset||Number(id)>=Number.MAX_SAFE_INTEGER)throw new Error('Invalid polling update.');
      // Always handle first: `onResult?.(await handle())` would skip handling when no callback is given.
      const kind=await this.bot.handle(raw);
      onResult?.(kind);
      next=Math.max(next,Number(id)+1);
    }
    await this.bot.dispatch();
    return next;
  }
}
