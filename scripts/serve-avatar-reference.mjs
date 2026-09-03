import {createServer} from 'vite';
import vue from '@vitejs/plugin-vue';
import {mkdirSync,mkdtempSync,readFileSync,writeFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
const target=resolve(fileURLToPath(new URL('..',import.meta.url))), source=process.env.OPENMAUS_REFERENCE_ROOT || resolve(target,'../OpenMausBot'), root=mkdtempSync(join(tmpdir(),'yaoyao-avatar-reference-'));
mkdirSync(root+'/reference',{recursive:true});mkdirSync(root+'/ported',{recursive:true});
const shapes=['circle','ellipse','square','capsule','triangle','hexagon','cloud','droplet'];
const bodies=['cursor','blob','circle','squircle','capsule','drop','shield','hexagon','diamond','star'];
const expressions=['idle','happy','curious','drowsy','working','thinking','listening','sleeping','suspicious','proud'];
const cases=[...shapes.map(shape=>({id:'shape-'+shape,shape,color:'green',hex:'#00c875',expression:'idle'})),...bodies.map(bodyId=>({id:'body-'+bodyId,shape:'circle',bodyId,color:'blue',hex:'#1488ff',expression:'happy'})),...expressions.map(expression=>({id:'face-'+expression,shape:'circle',color:'pink',hex:'#f52ba5',expression}))];
const html='<html><head><style>body{margin:0;background:white;font:12px Arial}.grid{display:grid;grid-template-columns:repeat(7,128px);gap:12px;padding:12px}.case{display:flex;flex-direction:column;align-items:center;gap:6px;width:128px;height:128px}.inline-flex{display:inline-flex}</style></head><body><div id="app"></div><script type="module" src="/main.tsx"></script></body></html>';
for(const sub of ['reference','ported'])writeFileSync(root+'/'+sub+'/index.html',html);
let cursor=readFileSync(source+'/src/components/CursorAvatar.tsx','utf8');
cursor=cursor.replace('"../../shared/mascot-bodies"',JSON.stringify(source+'/shared/mascot-bodies.ts')).replace('"./cursor-face-data"',JSON.stringify(source+'/src/components/cursor-face-data.ts'));
// Canonical resting-frame capture: settle the spring and hold elapsed time at 0.
// This only controls the test clock; all original geometry/drawing code is unchanged.
cursor=cursor.replace('if (p.paused) {','if (p.paused) { e.morph = 1; e.stateStart = now;');
writeFileSync(root+'/reference/CursorAvatar.tsx',cursor);
let avatar=readFileSync(source+'/src/components/Avatar.tsx','utf8').replace('"../../shared/bot-avatar"',JSON.stringify(source+'/shared/bot-avatar.ts')).replace('"../../shared/mascot-bodies"',JSON.stringify(source+'/shared/mascot-bodies.ts'));
writeFileSync(root+'/reference/Avatar.tsx',avatar);
writeFileSync(root+'/reference/main.tsx',`import React from 'react';import{createRoot}from'react-dom/client';import{MausAvatar}from'./Avatar';const cases=${JSON.stringify(cases)};createRoot(document.getElementById('app')!).render(<div className="grid">{cases.map(c=><div className="case" data-testid={c.id} key={c.id}><MausAvatar color={c.color as any} shape={(c.shape==='ellipse'?'oval':c.shape) as any} bodyId={c.bodyId as any} state={c.expression as any} size={96} animated={false}/><span>{c.id}</span></div>)}</div>);`);
writeFileSync(root+'/ported/main.tsx',`import{createApp,h}from'vue';import AgentAvatar from '${target}/src/client/components/common/AgentAvatar.vue';import{defaultAgentIdentity,encodeAgentAvatar}from'${target}/src/shared/agentIdentity.ts';const cases=${JSON.stringify(cases)};createApp({render:()=>h('div',{class:'grid'},cases.map(c=>h('div',{class:'case','data-testid':c.id},[h(AgentAvatar,{name:c.id,avatar:encodeAgentAvatar({...defaultAgentIdentity(c.id),shape:c.shape,bodyId:c.bodyId??null,color:c.hex,expression:c.expression}),size:96,animated:false,fixedTime:0}),h('span',c.id)])))}).mount('#app');`);
writeFileSync(root+'/cases.json',JSON.stringify(cases));
const servers=[];
for(const [sub,port]of[['reference',18806],['ported',18807]]){
 const server=await createServer({configFile:false,root:root+'/'+sub,plugins:sub==='ported'?[vue()]:[],resolve:{alias:{'@':sub==='reference'?source+'/src':target+'/src/client','@shared':target+'/src/shared',react:source+'/node_modules/react','react-dom':source+'/node_modules/react-dom',vue:target+'/node_modules/vue'}},server:{host:'127.0.0.1',port,strictPort:true,fs:{allow:[root,source,target]}}});
 await server.listen();servers.push(server);console.log(sub,port);
}
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,async()=>{for(const server of servers)await server.close();process.exit()});
