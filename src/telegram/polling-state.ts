// Node-only state for the controlled local runner. No tokens or message bodies.
import { mkdir,open,readFile,rename,unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import type { PollCheckpoint } from './controlled-polling';

export async function acquirePollLock(botId:number,folder=resolve(tmpdir(),'figa-telegram-pollers')):Promise<()=>Promise<void>> {
  if(!Number.isSafeInteger(botId)||botId<=0)throw new Error('Invalid bot identity.');
  await mkdir(folder,{recursive:true});
  const filename=resolve(folder,`${botId}.lock`),owner=crypto.randomUUID();
  const file=await open(filename,'wx',0o600); // One host-wide lock per verified bot.
  try {await file.writeFile(JSON.stringify({owner,pid:process.pid,botId,startedAt:new Date().toISOString()}));await file.sync();}
  finally {await file.close();}
  return async()=>{
    const current=JSON.parse(await readFile(filename,'utf8'));
    if(current.owner!==owner)throw new Error('Polling lock ownership changed.');
    await unlink(filename);
  };
}
export function pollCheckpoint(botId:number,folder=resolve('.wrangler','telegram-polling')):PollCheckpoint {
  if(!Number.isSafeInteger(botId)||botId<=0)throw new Error('Invalid bot identity.');
  const filename=resolve(folder,`${botId}.json`);
  return {
    async load(){
      let text:string;
      try{text=await readFile(filename,'utf8');}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return 0;throw error;}
      const data=JSON.parse(text);
      if(data.version!==1||data.botId!==botId||!Number.isSafeInteger(data.offset)||data.offset<0)throw new Error('Invalid polling checkpoint.');
      return data.offset;
    },
    async save(offset:number){
      if(!Number.isSafeInteger(offset)||offset<0)throw new Error('Invalid polling checkpoint.');
      await mkdir(folder,{recursive:true});const temporary=filename+'.'+crypto.randomUUID()+'.tmp';
      const file=await open(temporary,'wx',0o600);
      try{await file.writeFile(JSON.stringify({version:1,botId,offset}));await file.sync();}finally{await file.close();}
      await rename(temporary,filename); // Never unlink the previous checkpoint first.
    },
  };
}
