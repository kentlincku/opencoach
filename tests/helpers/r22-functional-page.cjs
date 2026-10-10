'use strict';
// NON_NATIVE: exact product UI handlers/route/runtime and exact runner row continuation.
// Doubles: DOM, CDP mouse/file/timers, IPC service and audio sink. No predicate mocks.
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const { settingsUi } = require('../fixtures/desktop-voice-stop-harness.cjs');
const { ElectronRuntime } = require('../../apps/web/runtime/electron-runtime.js');
const html = fs.readFileSync(path.join(__dirname, '../../apps/web/index.html'), 'utf8');
const runnerPath = path.join(__dirname, '../../scripts/run-full-acceptance-r3.cjs');
function section(text, a, b) { const i=text.indexOf(a), j=text.indexOf(b,i+a.length); assert(i>=0&&j>i, a); return text.slice(i,j); }
function node() {
 const e = { dataset:{}, style:{setProperty(k,v){this[k]=v;}}, value:'', disabled:false, children:[], className:'', textContent:'',
  set innerText(v){this.textContent=v;},get innerText(){return this.textContent;},
  append(...children) { children.forEach(c=>{ c.parent=this; this.children.push(c); }); },
  appendChild(c) { this.append(c); return c; }, replaceChildren(...c) { this.children=[]; this.append(...c); },
  getClientRects(){return this.hidden||this.style.display==='none'?[]:[{}];},
  closest() { return this.parent; }, getAttribute(k) { return this[k]||''; },
  querySelector(s) { return this.querySelectorAll(s)[0]||null; },
  querySelectorAll(s) { const all=[]; const walk=p=>p.children.forEach(c=>{all.push(c);walk(c);});walk(this); return all.filter(c=>s.split(',').some(q=>q.trim().split(/\s+/).at(-1).split('.').filter(Boolean).every(k=>c.className.split(' ').includes(k)))); }
 };
 e.classList={contains:k=>e.className.split(' ').includes(k),toggle(k,on){const set=new Set(e.className.split(' '));on?set.add(k):set.delete(k);e.className=[...set].join(' ');}};
 return e;
}
async function page(t, { reply=()=> 'English practice helps us learn. For example, we can talk daily.', afterReply, pending=false, cancel=()=>{}, speechSink, bridge, expectedCleanupError }={}) {
 const payloads=[],speech=[],clicks=[],tasks=[],taskFailures=[],nodes={}; let p;
 function observeTask(work) {
  const task=Promise.resolve(work);tasks.push(task);
  // Observe immediately, while retaining the original rejection for teardown assertions.
  task.catch(error=>{taskFailures.push(error);});return task;
 }
 const api={foundationModelsCapabilities:async()=>({protocol:1,platform:'macos',state:'available',reason:'available',sessionId:'service-session'}),
  foundationModelsGenerate:async payload=>{payloads.push(payload);return {requestId:payload.requestId,text:await reply(payloads.length,payload)};},
  foundationModelsCancel:async()=>{await cancel(payloads.length);return {state:'helper-exited'};},providerOperation(){throw Error('API_MUST_NOT_RUN');}};
 if(bridge)Object.assign(api,bridge);
 const runtime=new ElectronRuntime({api,capabilities:{ready:false}});
 t.after(async()=>{
  let disposeFailure;
  try{await runtime.dispose();}catch(error){disposeFailure=error;}
  let drainTimer;
  try{await Promise.race([Promise.allSettled(tasks),new Promise((_,reject)=>{
   drainTimer=setTimeout(()=>reject(new Error('FIXTURE_HANDLER_DRAIN_TIMEOUT')),2000);
  })]);}finally{clearTimeout(drainTimer);}
  const failures=[...taskFailures,...(disposeFailure?[disposeFailure]:[])];
  if(expectedCleanupError){
   assert.ok(failures.length>0,'fault fixture must retain its expected cleanup failure');
   for(const failure of failures)assert.equal(failure?.message,expectedCleanupError);
  }else if(failures.length)throw failures[0];
 });
 p=settingsUi({storage:{vp_provider:'apple-foundation-models'},electronAPI:api});
 const get=id=>nodes[id] ||= (p.elements[id] || node());
 const document={getElementById:get,createElement:()=>node(),title:'Voice Practice',readyState:'complete',
  querySelectorAll(s){
   if(s.includes('.chat-msg')) { let list=get('chatBox').children; if(s.includes('.assistant')) list=list.filter(n=>n.classList.contains('assistant')); if(s.includes('.user'))list=list.filter(n=>n.classList.contains('user')); return s.includes('.msg-bubble')?list.map(n=>n.children[1]):list; }
   if(s.includes('.coach-choice-item'))return get('coachGrid').children;
   if(s.includes('.lesson-item'))return get('lessonListContainer').children.filter(n=>(!s.includes(':not(.locked)')||!n.classList.contains('locked'))&&(!s.includes('onclick*=')||(n.onclick.match(/'([^']+)'/)?.[1] && s.includes(n.onclick.match(/'([^']+)'/)[1]))));
   if(s.includes('.lesson-badge'))return get('lessonListContainer').querySelectorAll('.lesson-badge').filter(n=>!s.includes('.completed')||n.classList.contains('completed'));
   return [];
  },querySelector(s){if(s.startsWith('#')&&!s.includes(' '))return get(s.slice(1));return this.querySelectorAll(s)[0]||node();}};
 p.context.document=document;
 Object.assign(p.context,{voiceRuntime:runtime,messages:[],currentVoiceId:'af_heart',PERSONAS:{af_heart:{emoji:'H'},af_bella:{emoji:'B'}},
  stopCurrentVoicePlayback(){p.context.voicePlaybackToken++;},
  speakReply:async(text,start)=>{speech.push(text);if(speechSink)await speechSink(text,start);else start?.();if(start)afterReply?.(p);},
  startListeningTurn(){},renderAvatarSVG(){return '';}
 });
 p.context.window.VoiceLessonLibrary=require('../../apps/web/runtime/lesson-library.js');
 p.run(section(html,'const DEFAULT_LESSONS =','const PERSONA_VOICE_CONFIG ='));
 p.run('let currentMode="free", currentLessonId=null; const ENGLISH_COACH_SYSTEM_PROMPT="English practice";');
 p.run(section(html,'function updateCoachUI(','// Conversation Control Loop'));
 for(const [id,klass] of [['coachGrid','coach-choice-item'],['lessonListContainer','lesson-item']]) {
  Object.defineProperty(get(id),'innerHTML',{get(){return this.markup||'';},set(value){
   this.markup=value;this.children=[];
   const re=new RegExp('<div class="('+klass+'[^\"]*)"\\s+onclick="([^\"]*)"','g');
   const matches=[...value.matchAll(re)];
   matches.forEach((m,i)=>{const n=node();n.className=m[1];n.onclick=m[2];n.click=()=>observeTask(p.run(n.onclick));
    const chunk=value.slice(m.index,matches[i+1]?.index);const badge=chunk.match(/<span class="lesson-badge"[^>]*>([^<]*)<\/span>/);
    if(badge){const b=node();b.className='lesson-badge';b.textContent=badge[1];n.appendChild(b);}this.appendChild(n);
   });
  }});
 }
 p.run(section(html,'// Local-first lesson library management','// Connection adapters:'));
 p.context.window.VoiceLanguagePolicy=require('../../apps/web/runtime/language-policy.js');
 p.run(section(html,'async function handleLLMResponse(','function getZeroKeyDemoReply('));
 p.run(section(html,'function formatProviderError(','// --- Kokoro-82M'));
 p.run(section(html,'function appendChat(','// Shadowing Coach'));
 await p.run('refreshFoundationModelsCapability()');
 const client={
  async evaluate(code){await new Promise(setImmediate); return vm.runInContext(code,p.context);},
  async setInputValue(sel,text){get(sel.slice(1)).value=text;},
  async clickSelector(sel){clicks.push(sel);let handler;
   if(sel.includes('sendManualText'))handler='sendManualText()';
   else if(sel==='button.btn-stop')handler=html.match(/class="btn btn-stop" onclick="([^"]+)"/)[1];
   else if(sel==='#tabBtnFree')handler='switchTab("free")';
   else if(sel==='#tabBtnLesson')handler='switchTab("lesson")';
   else if(sel==='button[onclick="openLessonManager()"]')handler='openLessonManager()';
   else if(sel==='button[onclick="closeLessonManager()"]')handler='closeLessonManager()';
   else if(sel.includes('completeCurrentLesson'))handler='completeCurrentLesson()';
   else if(sel==='button.coach-select-trigger')handler='openCoachModal()';
   else if(sel.includes('closeCoachModal'))handler='closeCoachModal()';
   else throw Error('DOM_CLICK_NOT_BOUND:'+sel);
   const work=observeTask(p.run(handler));if(!pending)await work;else await new Promise(setImmediate);
  }
 };
 return {p,runtime,client,nodes,get,document,payloads,speech,clicks,tasks,section,html};
}
async function row(h,id,extra={}) {
 const source=fs.readFileSync(runnerPath,'utf8');
 const numbers={BOOT:[1,2],TEXT:[3,4],COACH:[6,7],LESSON:[8,9],RESTORE:[12,13],STOP:[13,14]};
 const [a,b]=numbers[id];const code=section(source,'  // ROW '+a+':','  // ROW '+b+':');
 const context=vm.createContext({client:h.client,proc:{killed:false,exitCode:null},results:[],require:createRequire(runnerPath),console:{log(){}},
  setTimeout:fn=>setImmediate(fn),takeScreenshot:async()=>({name:'non-native.png',bytes:8,sha256:'0'.repeat(64)}),...extra});
 await vm.runInContext('(async()=>{'+code+'})()',context);
 return context.results[0];
}
module.exports={page,row,section,html,node};
