const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {webcrypto} = require('node:crypto');
const root = path.resolve(__dirname, '../../frontend/extension');
function harness() {
 const data={}, listeners=[], requests=[], opened=[];
 const hooks={cookie:null};
 const chrome={storage:{local:{get:async keys=>Object.fromEntries(keys.map(key=>[key,data[key]])),set:async patch=>Object.assign(data,patch)}},runtime:{onMessage:{addListener:fn=>listeners.push(fn)},onInstalled:{addListener:()=>{}}},cookies:{get:async()=>hooks.cookie,onChanged:{addListener:()=>{}}},tabs:{onUpdated:{addListener:()=>{}},create:async tab=>opened.push(tab),query:async()=>[]},scripting:{executeScript:async()=>{}}};
 const ctx=vm.createContext({chrome,URL,TextEncoder,crypto:webcrypto,console,fetch:async(url,options)=>{
  requests.push({url,options});let result={success:true};
  if(url.endsWith('/session'))result={workspace_token:'test-workspace',auth_mode:'moodle'};
  if(url.endsWith('/extension'))result={workspace_url:'/custom/courses/17',summary:{course_id:17}};
  return {ok:true,status:200,json:async()=>result};
 }});
 ctx.importScripts=(...files)=>files.forEach(file=>vm.runInContext(fs.readFileSync(path.join(root,file),'utf8'),ctx));
 vm.runInContext(fs.readFileSync(path.join(root,'background.js'),'utf8'),ctx);
 async function send(message,sender={}) {
  return await new Promise(resolve=>{let handled=false;for(const fn of listeners)handled=fn(message,sender,resolve)||handled;if(!handled)resolve(null);});
 }
 return {ctx,data,hooks,requests,opened,send};
}
test('does not transfer Moodle cookies before explicit connection',async()=>{
 const h=harness();const result=await vm.runInContext("pairMoodleCookie('https://learn.ucu.edu.ua','fake-cookie',null,true)",h.ctx);
 assert.equal(result.success,false);assert.equal(h.requests.length,0);
});
test('bridge rejects untrusted sites and non-Hustle paths',async()=>{
 const h=harness();for(const url of ['https://untrusted.example/hustle/','http://127.0.0.1:8000/other']) {
  assert.equal(await h.send({type:'HUSTLE_CONNECT',moodleOrigin:'https://learn.ucu.edu.ua'},{url,tab:{id:1}}),null);
 }
 assert.equal(h.requests.length,0);assert.equal(h.data.hustleConnections,undefined);
 assert.equal(vm.runInContext("sanitizePortalUrl('https://untrusted.example')",h.ctx),null);
});
test('explicit connection opens Moodle when login is needed',async()=>{
 const h=harness();const result=await h.send({type:'HUSTLE_CONNECT',moodleOrigin:'https://learn.ucu.edu.ua'},{url:'http://127.0.0.1:8000/hustle/connect.html',tab:{id:1}});
 assert.equal(result.requiresLogin,true);assert.equal(result.paired,false);assert.equal(h.opened[0].url,'https://learn.ucu.edu.ua/my/');assert.equal(h.requests.length,0);
});
test('bridge reports connection without exposing session data to page',async()=>{
 const h=harness();h.hooks.cookie={value:'fake-cookie'};
 const result=await h.send({type:'HUSTLE_CONNECT',moodleOrigin:'https://learn.ucu.edu.ua'},{url:'http://localhost:8000/hustle/connect.html',tab:{id:1}});
 assert.deepEqual(JSON.parse(JSON.stringify(result)),{success:true,paired:true});
 assert.equal(h.requests[0].url,'http://localhost:8000/api/auth/extension-pair');
});
test('course sync resolves current owner after pairing and opens Hustle',async()=>{
 const h=harness();h.hooks.cookie={value:'fake-cookie'};h.data.hustleConnections={'https://learn.ucu.edu.ua':'http://127.0.0.1:8000'};
 const result=await h.send({type:'SYNC_COURSE',payload:{moodle_url:'https://learn.ucu.edu.ua',course_id:17,sections:[]}});
 assert.equal(result.success,true);
 assert.deepEqual(h.requests.map(r=>new URL(r.url).pathname),['/api/auth/extension-pair','/api/workspace/session','/api/sync/extension']);
 assert.equal(h.opened[0].url,'http://127.0.0.1:8000/hustle/app.html#course/17');
});
test('bridge refreshes approved session from /prototype/ without leaking unapproved origins',async()=>{
 const h=harness();h.hooks.cookie={value:'fresh-cookie'};
 const denied=await h.send({type:'HUSTLE_REFRESH_SESSION',moodleOrigin:'https://learn.ucu.edu.ua'},{url:'http://127.0.0.1:8000/prototype/app.html',tab:{id:1}});
 assert.equal(denied.paired,false);assert.equal(h.requests.length,0);
 h.data.hustleConnections={'https://learn.ucu.edu.ua':'http://127.0.0.1:8000'};
 const ok=await h.send({type:'HUSTLE_REFRESH_SESSION',moodleOrigin:'https://learn.ucu.edu.ua'},{url:'http://127.0.0.1:8000/prototype/app.html',tab:{id:1}});
 assert.equal(ok.success,true);assert.equal(ok.paired,true);
 assert.equal(h.requests[0].url,'http://127.0.0.1:8000/api/auth/extension-pair');
 assert.equal(h.opened.length,0);
});
test('connect does not loop Moodle login tabs on upstream 502 and SYNC_COURSE still syncs extracted course',async()=>{
 const h=harness();h.hooks.cookie={value:'fake-cookie'};
 h.ctx.fetch=async(url)=>{
  h.requests.push({url});
  if(url.endsWith('/extension-pair'))return {ok:false,status:502,json:async()=>({detail:'Upstream 403'})};
  if(url==='https://learn.ucu.edu.ua/my/')return {ok:true,status:200,url,text:async()=>'<html><script>M={"sesskey":"k1"}</script></html>'};
  if(url.endsWith('/session'))return {ok:true,status:200,json:async()=>({workspace_token:'ws',auth_mode:'moodle'})};
  if(url.endsWith('/extension'))return {ok:true,status:200,json:async()=>({workspace_url:'/custom/courses/17',summary:{course_id:17}})};
  return {ok:true,status:200,json:async()=>({})};
 };
 const conn=await h.send({type:'HUSTLE_CONNECT',moodleOrigin:'https://learn.ucu.edu.ua'},{url:'http://127.0.0.1:8000/hustle/connect.html',tab:{id:1}});
 assert.equal(conn.success,false);assert.equal(conn.status,502);assert.equal(h.opened.length,0);
 const sync=await h.send({type:'SYNC_COURSE',payload:{moodle_url:'https://learn.ucu.edu.ua',course_id:17,sections:[]}});
 assert.equal(sync.success,true);
});
test('extension relays /my/, courses, and course HTML when server gets 502 from Cloudflare',async()=>{
 const h=harness();h.hooks.cookie={value:'fake-cookie'};
 let pairCalls=0;
 h.ctx.fetch=async(url,options)=>{
  h.requests.push({url,options});
  if(url.endsWith('/extension-pair')){
   pairCalls++;
   if(pairCalls===1)return {ok:false,status:502,json:async()=>({detail:'Upstream 403'})};
   const body=JSON.parse(options.body);
   assert.ok(body.browser_my_html.includes('sesskey'));
   return {ok:true,status:200,json:async()=>({success:true,moodle_paired:true})};
  }
  if(url==='https://learn.ucu.edu.ua/my/'){
   return {ok:true,status:200,url,text:async()=>'<html><script>M={"sesskey":"abc123"}</script><a href="/user/profile.php?id=7">Student</a></html>'};
  }
  if(url.includes('/lib/ajax/service.php')){
   return {ok:true,status:200,json:async()=>[{error:false,data:{courses:[{id:42,fullname:'Алгоритми',shortname:'ALG'}]}}]};
  }
  if(url==='https://learn.ucu.edu.ua/course/view.php?id=42'){
   return {ok:true,status:200,url,text:async()=>'<html><li id="section-1"><h3 class="sectionname">Тема 1</h3><a href="/mod/page/view.php?id=99">Сторінка 1</a></li></html>'};
  }
  if(url==='https://learn.ucu.edu.ua/mod/page/view.php?id=99'){
   return {ok:true,status:200,url,headers:{get:()=>'text/html'},text:async()=>'<html><div role="main"><p>Повний текст лекції про алгоритми.</p></div></html>'};
  }
  if(url.endsWith('/sync-moodle')){
   const body=JSON.parse(options.body);
   assert.ok(body.course_html.includes('Тема 1'));
   assert.equal(body.module_contents[0].module_id,99);
   assert.ok(body.module_contents[0].text_excerpt.includes('Повний текст лекції'));
   return {ok:true,status:200,json:async()=>({success:true,course_id:42})};
  }
  return {ok:true,status:200,json:async()=>({})};
 };
 const conn=await h.send({type:'HUSTLE_CONNECT',moodleOrigin:'https://learn.ucu.edu.ua'},{url:'http://127.0.0.1:8000/hustle/connect.html',tab:{id:1}});
 assert.equal(conn.success,true);assert.equal(conn.paired,true);
 const courses=await h.send({type:'HUSTLE_MOODLE_COURSES',moodleOrigin:'https://learn.ucu.edu.ua'},{url:'http://127.0.0.1:8000/prototype/app.html',tab:{id:1}});
 assert.equal(courses.success,true);assert.equal(courses.courses[0].id,42);
 const synced=await h.send({type:'HUSTLE_MOODLE_SYNC_COURSE',moodleOrigin:'https://learn.ucu.edu.ua',courseId:42,courseTitle:'Алгоритми',shortname:'ALG'},{url:'http://127.0.0.1:8000/prototype/app.html',tab:{id:1}});
 assert.equal(synced.success,true);
});
