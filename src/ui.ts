export function renderUI(): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>FIGA · Conversation lab</title>
<style>
:root{font-family:Inter,ui-sans-serif,system-ui,sans-serif;color:#183830;background:#f2f5f1;font-size:15px}*{box-sizing:border-box}body{margin:0}button,input{font:inherit}button{cursor:pointer}header{background:#153e34;color:#fff;padding:26px max(24px,calc((100vw - 1200px)/2));display:flex;align-items:center;justify-content:space-between;gap:20px}.brand{font-size:28px;font-weight:800;letter-spacing:3px}.brand span{font-size:13px;letter-spacing:0;font-weight:400;display:block;color:#c8d9d1;margin-top:5px}.badge{font-size:11px;font-weight:750;letter-spacing:1px;border:1px solid #759e8d;border-radius:30px;padding:9px 13px;background:#214f41}main{max-width:1250px;margin:36px auto;padding:0 24px}h1{font-size:30px;letter-spacing:-1px;margin:0 0 8px}h2{font-size:15px;margin:0 0 16px}p{line-height:1.6}.intro{margin:0 0 24px;color:#5a6c64}.grid{display:grid;grid-template-columns:minmax(0,1fr) 340px;gap:22px}.panel{border:1px solid #dce5dd;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 5px 20px #193c2905}.toolbar{padding:18px 22px;border-bottom:1px solid #e9ede8;display:flex;justify-content:space-between;align-items:center}.toolbar span{font-weight:700}.textbtn{background:none;border:0;color:#476e5b;text-decoration:underline;padding:6px}.messages{height:430px;overflow:auto;padding:24px;display:flex;flex-direction:column;gap:16px;scroll-behavior:smooth}.bubble{max-width:88%;padding:13px 17px;background:#eef3ec;border-radius:3px 16px 16px 16px;line-height:1.6;white-space:pre-wrap;overflow-wrap:anywhere}.bubble.user{align-self:flex-end;background:#205944;color:#fff;border-radius:16px 3px 16px 16px}.who{font-size:10px;letter-spacing:1px;font-weight:800;display:block;margin-bottom:4px;opacity:.7}form{display:flex;gap:10px;padding:18px 22px;border-top:1px solid #e9ede8}input{width:100%;min-width:0;border:1px solid #ccd8ce;border-radius:9px;padding:13px;background:#fafcf9;color:#183830}input:focus{outline:2px solid #5e9c78;outline-offset:2px}button.primary{background:#205944;color:white;border:0;border-radius:9px;padding:12px 20px;font-weight:650}button:disabled{opacity:.5;cursor:wait}.hint{font-size:12px;color:#68776f;padding:0 22px 16px;margin:0}.side{padding:22px;margin-bottom:18px}.label{font-size:11px;text-transform:uppercase;letter-spacing:1px;color:#697e70;margin:20px 0 7px}.pill{display:inline-block;border-radius:5px;background:#e9f2e9;color:#30583d;padding:6px 10px;font-weight:650}.attention{padding:12px;border-radius:8px;background:#f3f5ef;font-size:13px;line-height:1.5}.attention.active{background:#fff1d3;color:#72500d}.attention ul{margin:8px 0;padding-left:18px}dl{font-size:13px;margin:0}dl div{display:grid;grid-template-columns:42% 58%;padding:10px 0;border-bottom:1px solid #edf0eb;gap:5px}dt{color:#65766b}dd{margin:0;overflow-wrap:anywhere}pre{white-space:pre-wrap;overflow-wrap:anywhere;font-size:11px;background:#f4f6f1;padding:12px;border-radius:8px;max-height:240px;overflow:auto}.demo{display:flex;gap:8px;flex-wrap:wrap}.demo button{border:1px solid #cedbce;color:#315740;background:#f8faf5;border-radius:7px;padding:9px 12px;font-size:13px}.notice{font-size:12px;color:#647566;margin:16px 0 0}.error{color:#a2342a;padding:0 22px;font-size:13px;min-height:18px;margin:0 0 10px}.foot{font-size:12px;color:#6e7f72;margin:20px 0}summary{cursor:pointer;font-size:12px;margin-top:18px} @media(max-width:820px){.grid{grid-template-columns:1fr}main{margin:24px auto}.messages{height:390px}header{padding:20px}.badge{font-size:9px}h1{font-size:26px}}@media(prefers-reduced-motion:reduce){.messages{scroll-behavior:auto}}
</style></head><body>
<header><div class="brand">FIGA<span>Staffing · Hybrid AI Assistant</span></div><div class="badge">LOCAL DEVELOPMENT / DRY RUN</div></header>
<main><h1>Conversation lab</h1><p class="intro">Try a staffing request or a caregiver job inquiry. See what the assistant understands as you talk.</p>
<div class="grid"><section class="panel" aria-label="Chat"><div class="toolbar"><span>Customer conversation</span><button class="textbtn" id="reset">Reset conversation</button></div>
<div style="padding:14px 22px;border-bottom:1px solid #e9ede8"><label for="engine">Conversation engine </label><select id="engine" style="padding:8px;border:1px solid #ccd8ce;border-radius:7px"><option value="deterministic">Deterministic (default)</option><option value="ai" id="ai-option" disabled>AI (not configured)</option></select><p class="notice" id="engine-status" role="status">Checking optional AI configuration…</p><label style="display:block;font-size:12px;margin-top:10px"><input id="synthetic" type="checkbox" style="width:auto"> All messages and collected details in this conversation are fictional test data.</label></div>
<div style="padding:12px 22px"><label><input id="persist" type="checkbox" disabled style="width:auto"> Save fictional conversation to isolated development database (select before chatting)</label><p id="storage-status" class="notice" role="status">Session memory only. Database integration is disabled by default.</p></div>
<div class="messages" id="messages" role="log" aria-live="polite" aria-label="Conversation messages"></div>
<form id="chat"><input id="message" aria-label="Customer message" placeholder="Type a message…" maxlength="2000" required autocomplete="off"><button class="primary" type="submit" id="send">Send</button></form>
<p class="error" id="error" role="alert"></p><p class="hint">Use fictional details. Omit medical, resident, and other sensitive information.</p></section>
<aside><section class="panel side"><h2>Conversation insights</h2><div class="label">Classification</div><span class="pill" id="classification">Awaiting inquiry</span><div class="label">Human attention</div><div class="attention" id="attention">No review flag yet. No notifications are sent.</div><div class="label">Collected information</div><dl id="collected"></dl><p class="notice" id="empty">Details will appear as you chat.</p><div class="label">Next detail</div><span id="next">Inquiry type</span><details><summary>Inspect request-carried state</summary><pre id="state">No state yet</pre></details></section>
<section class="panel side"><h2>Try a complete conversation</h2><div class="demo"><button id="provider">Provider demo</button><button id="caregiver">Caregiver demo</button></div><p class="notice">Runs a fictional multi-turn conversation through the local API. Starting a demo resets this chat.</p></section></aside></div>
<p class="foot">Deterministic by default · Optional AI for fictional tests only · No SMS or Telegram connections · Optional isolated development storage · Nothing submitted</p></main>
<script>
const el=id=>document.getElementById(id);
let state, conversationId, pending;
let busy=false, databaseReady=false;
const labels={name:'Name',homeType:'Home type',organization:'Organization',city:'City',state:'State',position:'Position',date:'Date',shift:'Shift',count:'Caregivers needed',urgency:'Urgency',notes:'Notes',availability:'Availability',experience:'Experience',applicationStatus:'Application status'};
function bubble(text,user=false,turnId){
  if(!text)return;
  if(turnId&&Array.from(el('messages').children).some(b=>b.dataset.turnId===turnId&&b.dataset.side===(user?'user':'assistant')))return;
  const b=document.createElement('div');b.className='bubble'+(user?' user':'');b.dataset.side=user?'user':'assistant';if(turnId)b.dataset.turnId=turnId;
  const who=document.createElement('span');who.className='who';who.textContent=user?'CUSTOMER':'FIGA ASSISTANT';b.append(who,document.createTextNode(text));el('messages').append(b);el('messages').scrollTop=el('messages').scrollHeight;
}
function lock(value){busy=value;['send','reset','provider','caregiver','message','engine','synthetic'].forEach(id=>el(id).disabled=value);el('persist').disabled=value||!databaseReady||!!conversationId||!!state;}
function reset(){
  state=undefined;conversationId=undefined;pending=undefined;localStorage.removeItem('figa.conversationId');sessionStorage.removeItem('figa.pending');
  el('messages').replaceChildren();el('collected').replaceChildren();el('empty').hidden=false;el('classification').textContent='Awaiting inquiry';el('attention').className='attention';el('attention').textContent='No review flag yet. No notifications are sent.';el('next').textContent='Inquiry type';el('state').textContent='No state yet';el('error').textContent='';el('message').value='';el('persist').disabled=!databaseReady;if(!databaseReady)el('persist').checked=false;el('storage-status').textContent='New conversation. Reset clears this browser reference; saved audit history is retained.';
  bubble('Hello! Are you requesting caregivers for an organization, looking for a caregiver job, or asking a general question? This is a local demo; please use fictional details.');
}
function render(data){
  state=data.state;
  if(data.engine){const fallback=data.engine.used==='deterministic'&&data.engine.requested==='ai'&&!['greeting','approved_or_staff_only'].includes(data.engine.reason);const name=data.engine.used==='workers-ai'?'Cloudflare Gemma 4':data.engine.used==='none'?'No automated reply':fallback?'Deterministic fallback':'Deterministic';el('engine-status').textContent='Used: '+name+(data.engine.reason?' · '+data.engine.reason:'')+' · Details are user-reported, unverified.';}
  el('classification').textContent=data.conversationType;el('attention').className='attention'+(data.humanAttentionNeeded?' active':'');el('attention').textContent=data.humanAttentionNeeded?'Human review needed — local flag only. No one has been notified.':'No review flag yet. No notifications are sent.';
  if(data.humanAttentionNeeded){const list=document.createElement('ul');(data.humanAttentionReasons||[]).forEach(reason=>{const li=document.createElement('li');li.textContent=reason;list.append(li);});el('attention').append(list);}
  el('collected').replaceChildren();Object.entries(data.collectedInformation).forEach(([key,value])=>{const row=document.createElement('div');const dt=document.createElement('dt');dt.textContent=labels[key]||key;const dd=document.createElement('dd');dd.textContent=value;row.append(dt,dd);el('collected').append(row);});
  el('empty').hidden=Object.keys(data.collectedInformation).length>0;el('state').textContent=JSON.stringify(state,null,2);el('next').textContent=state.control==='human_takeover'?'Human mode — automated replies paused':state.control==='blocked'?'Conversation blocked':data.complete?'Intake complete · staff review required':labels[state.awaiting]||'Inquiry type';
}
async function request(path,options){const response=await fetch(path,options);const data=await response.json();if(!response.ok){const error=new Error(data.error||'Request failed.');error.status=response.status;throw error;}return data;}
async function ensureConversation(){
  if(!el('persist').checked||conversationId)return;
  if(!el('synthetic').checked)throw new Error('Saving requires confirmation that the entire conversation is fictional.');
  const snapshot=await request('/conversations',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({syntheticData:true})});
  conversationId=snapshot.id;state=snapshot.state;localStorage.setItem('figa.conversationId',conversationId);el('persist').disabled=true;
}
async function send(message){
  el('error').textContent='';
  if((el('engine').value==='ai'||el('persist').checked||conversationId)&&!el('synthetic').checked)throw new Error('AI or persistent testing requires confirmation that the entire conversation is fictional.');
  await ensureConversation();
  if(conversationId){
    if(pending&&(pending.message!==message||pending.engine!==el('engine').value))throw new Error('Retry the pending message with the same engine, or reset to start another conversation.');
    pending=pending||{message,id:crypto.randomUUID(),engine:el('engine').value};sessionStorage.setItem('figa.pending',JSON.stringify(pending));
  }
  let data;
  try{data=await request('/chat',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({message,engine:el('engine').value,syntheticData:el('synthetic').checked,...(conversationId?{conversationId,messageId:pending.id}:state?{state}:{})})});}
  catch(error){if(error.status===400||error.status===422){pending=undefined;sessionStorage.removeItem('figa.pending');}throw error;}
  const turnId=data.persistence?.messageId;bubble(message,true,turnId);bubble(data.assistantResponse,false,turnId);render(data);
  if(data.persistence)el('storage-status').textContent='Saved · Revision '+data.persistence.revision+' · Restores with this browser access cookie. No customer details or access keys are stored in localStorage.';
  pending=undefined;sessionStorage.removeItem('figa.pending');
}
el('chat').addEventListener('submit',async event=>{event.preventDefault();if(busy)return;const message=el('message').value.trim();if(!message)return;lock(true);try{await send(message);el('message').value='';}catch(error){el('error').textContent=error.message+' Your message is still in the input. Persistent failures never switch to an unverified browser state.';}finally{lock(false);el('message').focus();}});
el('reset').addEventListener('click',reset);
const demos={provider:['I need two caregivers for a night shift in Portland.','My name is Alex Morgan from Example Care.','Adult foster home','Oregon','Tomorrow','Urgent'],caregiver:['I am looking for a caregiver job.','My name is Sam Taylor.','I am in Portland, OR.','Available Monday through Friday.','Night shift','Three years of caregiving experience.']};
for(const type of ['provider','caregiver'])el(type).addEventListener('click',async()=>{if(busy)return;reset();lock(true);try{for(const message of demos[type])await send(message);}catch(error){el('error').textContent=error.message;}finally{lock(false);}});
async function initialize(){
  const savedId=localStorage.getItem('figa.conversationId');const savedPending=sessionStorage.getItem('figa.pending');reset();if(savedId){conversationId=savedId;localStorage.setItem('figa.conversationId',savedId);el('persist').checked=true;}lock(true);
  try{
    const health=await request('/health');databaseReady=!!health.database?.configured;
    el('ai-option').disabled=!health.ai.available;el('ai-option').textContent=health.ai.available?'Workers AI / Gemma (fictional data only)':'Workers AI (not configured)';
    el('engine-status').textContent=health.ai.available?'Gemma configured for explicitly enabled fictional-data tests. The response indicator shows the actual engine used.':'Deterministic mode. AI is disabled or awaiting configuration.';
    el('storage-status').textContent=databaseReady?'Development database configured. Select Save and confirm fictional data before starting.':'Database disabled. Chat remains in session memory.';
    if(savedId){
      conversationId=savedId;localStorage.setItem('figa.conversationId',savedId);el('persist').checked=true;
      if(savedPending){pending=JSON.parse(savedPending);sessionStorage.setItem('figa.pending',savedPending);el('message').value=pending.message;el('engine').value=pending.engine;}
      const snapshot=await request('/conversations/'+encodeURIComponent(savedId));
      el('messages').replaceChildren();snapshot.messages.forEach(m=>bubble(m.content,m.direction==='inbound',m.clientMessageId));
      render({state:snapshot.state,conversationType:snapshot.state.type,collectedInformation:snapshot.state.collected,humanAttentionNeeded:snapshot.humanAttentionNeeded||snapshot.mode==='HUMAN'||snapshot.status!=='open',humanAttentionReasons:snapshot.state.humanAttentionReasons});
      el('storage-status').textContent='Restored saved conversation · '+snapshot.mode+' mode · Revision '+snapshot.revision+' · Latest 50 messages.';
    }
  }catch(error){el('error').textContent=error.message+' A saved conversation requires its original cookie. Reset explicitly to start a separate conversation.';}
  finally{lock(false);}
}
initialize();</script></body></html>`;
}
