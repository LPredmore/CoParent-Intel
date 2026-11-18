#!/usr/bin/env node
// Isolated OFW -> Supabase Storage bridge. No existing app tables are accessed.
// Node >=22.5. All OFW calls go through the locally installed, restricted MCP.
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

const URL_BASE = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const KEY = process.env.SUPABASE_SECRET_KEY || '';
const BUCKET = process.env.OFW_BRIDGE_BUCKET || 'ofw-bridge';
const HOME = process.env.LOCALAPPDATA || '';
const MCP_ENTRY = process.env.OFW_MCP_ENTRY || join(HOME, 'CoParentIntel', 'OFW', 'runtime', 'node_modules', 'ofw-mcp', 'dist', 'index.js');
const DEFAULT_TIMEZONE = 'America/Chicago';
const PAGE_SIZE = 100;
const command = process.argv[2] || 'probe';
if (!URL_BASE || !/^https:\/\/[a-z0-9-]+\.supabase\.co$/i.test(URL_BASE)) throw new Error('SUPABASE_URL is missing or invalid');
if (!KEY.startsWith('sb_secret_')) throw new Error('SUPABASE_SECRET_KEY must be a Supabase Secret API key (sb_secret_...). Run the updated Windows bridge setup.');
if (!/^[a-z0-9_-]+$/i.test(BUCKET)) throw new Error('Invalid bucket name');

class Mcp {
  constructor() {
    this.pending = new Map();
    this.nextId = 1;
    this.buffer = '';
    // Never pass privileged Supabase keys into the third-party OFW MCP process.
    const childEnv = { ...process.env };
    delete childEnv.SUPABASE_SECRET_KEY;
    delete childEnv.SUPABASE_SERVICE_ROLE_KEY;
    delete childEnv.SUPABASE_URL;
    delete childEnv.OFW_BRIDGE_BUCKET;
    this.child = spawn(process.execPath, [MCP_ENTRY], {
      env: childEnv, stdio: ['pipe','pipe','pipe'], windowsHide: true
    });
    this.child.stdout.on('data', data => {
      this.buffer += data.toString('utf8');
      let end;
      while ((end = this.buffer.indexOf('\n')) !== -1) {
        const line = this.buffer.slice(0,end).trim();
        this.buffer = this.buffer.slice(end+1);
        if (!line) continue;
        let obj;
        try { obj = JSON.parse(line); }
        catch { continue; } // Any non-JSON output from a shell host is not MCP.
        if (obj.id === undefined) continue;
        const p = this.pending.get(obj.id);
        if (!p) continue;
        clearTimeout(p.timer);
        this.pending.delete(obj.id);
        if (obj.error) p.reject(new Error('OFW MCP error: '+ JSON.stringify(obj.error).slice(0,1000)));
        else p.resolve(obj.result);
      }
    });
    this.child.stderr.on('data', data => {
      const msg = data.toString('utf8').trim();
      if (msg && process.env.OFW_BRIDGE_VERBOSE === '1') console.error('[ofw-mcp]', msg.slice(0,900));
    });
    this.child.on('error', err => this.abort(err));
    this.child.on('exit', code => this.abort(new Error('OFW MCP exited with code '+code)));
  }
  abort(err) {
    for (const [,p] of this.pending) { clearTimeout(p.timer); p.reject(err); }
    this.pending.clear();
  }
  send(method,params) {
    if (!this.child.stdin.writable) throw new Error('OFW MCP is not accepting calls');
    const id = this.nextId++;
    return new Promise((resolve,reject)=>{
      const timer = setTimeout(()=>{
        this.pending.delete(id);
        reject(new Error('OFW MCP timed out on '+method));
      },180000);
      this.pending.set(id,{resolve,reject,timer});
      this.child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');
    });
  }
  async init() {
    await this.send('initialize',{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'coparent-ofw-storage-bridge',version:'0.1.0'}});
    this.child.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})+'\n');
    const capabilities = await this.send('tools/list',{});
    const names = new Set((capabilities.tools||[]).map(t=>t.name));
    for (const t of ['ofw_healthcheck','ofw_sync_messages','ofw_list_messages','ofw_list_events','ofw_save_draft']) {
      if (!names.has(t)) throw new Error('OFW tool unavailable: '+t+' (check pinned MCP installation)');
    }
  }
  async call(name,args={}) {
    const result = await this.send('tools/call',{name,arguments:args});
    if (result?.isError) throw new Error(name+': '+ JSON.stringify(result.content).slice(0,700));
    const text = result?.content?.filter(x=>x.type==='text').map(x=>x.text).join('\n');
    if (!text) throw new Error(name+' returned no text');
    let parsed;
    try { parsed = JSON.parse(text); } catch { throw new Error(name+' returned non-JSON response'); }
    if (parsed?.error || parsed?.result==='UNVERIFIED_EMPTY') throw new Error(name+': '+JSON.stringify(parsed).slice(0,900));
    return parsed;
  }
  close() { this.child.kill(); }
}
async function verifyProjectSecret() {
  // Diagnose whether the encrypted sb_secret_ key belongs to THIS project before
  // touching Storage. Data API gateway validates the api key without any JWT.
  const endpoint = URL_BASE + '/rest/v1/';
  let res;
  try {
    res = await fetch(endpoint, {
      headers: { apikey: KEY, Accept: 'application/openapi+json' },
      signal: AbortSignal.timeout(30000),
    });
  } catch (e) {
    throw new Error('Supabase project key verification could not reach the Data API: '+(e?.cause?.code || e?.message || String(e)));
  }
  if (res.status === 401 || res.status === 403) {
    throw new Error('PROJECT_KEY_MISMATCH: Supabase Data API rejected the saved Secret API key for '+new URL(URL_BASE).hostname+' (HTTP '+res.status+'). Make sure the ofw_bridge key was created under THIS project, not another Supabase project. Rerun setup-bridge.ps1 -ReplaceSecret to save the correct project key. Do not paste the key in chat.');
  }
  if (!res.ok) {
    throw new Error('Data API key check is inconclusive (HTTP '+res.status+'). Check Data API availability for the project before attempting Storage; no data was exported.');
  }
  return { project: new URL(URL_BASE).hostname, status: res.status, verified: true };
}

async function storage(path, method='GET',body,extra={}) {
  const url = URL_BASE+'/storage/v1/'+path.split('/').map(x=>encodeURIComponent(x)).join('/');
  // sb_secret_... is an opaque API key, not a JWT. Never send it in
  // Authorization: Bearer; current Supabase docs require apikey only.
  const headers = { apikey: KEY, ...extra };
  if (body !== undefined) headers['Content-Type']='application/json';
  let res;
  try {
    res = await fetch(url,{method,headers,body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(120000)});
  } catch (e) {
    const cause = e?.cause?.code;
    if (cause === 'ENOTFOUND' || cause === 'EAI_AGAIN') {
      throw new Error('Supabase Project URL hostname could not be resolved: '+new URL(URL_BASE).hostname+'. Copy the correct Project URL from Project Settings > Data API and rerun setup-bridge.ps1. If that URL is correct, check whether the project is paused or DNS is broken.', {cause:e});
    }
    throw e;
  }
  const txt = await res.text();
  let val; try { val=JSON.parse(txt); } catch {val={raw:txt.slice(0,250)};}
  if (!res.ok) {
    const msg = String(val?.message || val?.error || '');
    if (/headers must have required property ['"]authorization['"]/i.test(msg)) {
      throw new Error('STORAGE_AUTH_INCOMPATIBLE: Supabase accepted the project key on the Data API, but Storage requires a JWT Authorization header. The sb_secret_ key cannot be used as a JWT. Do not retry Bearer sb_secret_ or switch to a legacy key; stop and report this Storage compatibility error.');
    }
    if (/Invalid Compact JWS|Invalid JWT/i.test(msg)) {
      throw new Error('STORAGE_JWT_REJECTED: Supabase Storage attempted to validate an invalid JWT. This bridge sends the secret key in apikey only; check for upstream gateway configuration issues.');
    }
    const e=new Error('Supabase Storage '+method+' '+res.status+' '+JSON.stringify(val).slice(0,500));
    e.status=res.status;throw e;
  }
  return val;
}
async function ensureBucket(create=false) {
  let b;
  try { b=await storage('bucket/'+BUCKET); }
  catch(e){
    if(e.status!==404 || !create) throw e;
    await storage('bucket','POST',{id:BUCKET,name:BUCKET,public:false});
    b=await storage('bucket/'+BUCKET);
  }
  if (b.public!==false) throw new Error('Storage bucket is public; refusing to export private OFW data');
  return b;
}
async function put(rel,data) {
  return storage('object/'+BUCKET+'/'+rel,'POST',data,{'x-upsert':'true'});
}
async function get(rel) {
  return storage('object/authenticated/'+BUCKET+'/'+rel);
}
async function probe(mcp) {
  const h=await mcp.call('ofw_healthcheck');
  const keyCheck = await verifyProjectSecret();
  console.log('Supabase Data API secret-key validation: succeeded for '+keyCheck.project);
  const b=await ensureBucket(false).catch(e=>{
    if(e.status===404) return null;
    throw e;
  });
  console.log(JSON.stringify({ofwConnected:true,healthcheck:h,storageBucketReady:!!b,bucket:BUCKET,supabaseProject:URL_BASE.split('//')[1]?.split('.')[0]},null,2));
}
function ymd(d) { return d.toISOString().slice(0,10); }
async function exportMessages(mcp,folder,runId) {
  const first=await mcp.call('ofw_list_messages',{folderId:folder,page:1,size:PAGE_SIZE,view:'compact',autoRefresh:false});
  const total=first.total;
  if(!Number.isInteger(total)||total<0)throw new Error('Invalid '+folder+' count');
  const pages=Math.ceil(total/PAGE_SIZE);
  for(let page=1;page<=pages;page++) {
    const r=page===1?first:await mcp.call('ofw_list_messages',{folderId:folder,page,size:PAGE_SIZE,view:'compact',autoRefresh:false});
    if (r.total!==total || !Array.isArray(r.messages)) throw new Error('Message cache changed during export; retry');
    await put('runs/'+runId+'/messages/'+folder+'/page-'+String(page).padStart(4,'0')+'.json',{
      source:'ourfamilywizard',folder,page,size:PAGE_SIZE,total,exportedAt:new Date().toISOString(),messages:r.messages
    });
    if(page%10===0||page===pages)console.log('Exported '+folder+' page '+page+'/'+pages);
  }
  return {total,pages};
}
async function sync(mcp) {
  await verifyProjectSecret();
  await ensureBucket(true);
  const check=await mcp.call('ofw_sync_messages',{folders:['inbox','sent'],fetchUnreadBodies:false,deep:false});
  if(check.syncComplete!==true && check.done!==true)throw new Error('OFW message cache backfill incomplete: retry sync before export');
  const runId=new Date().toISOString().replace(/[-:.TZ]/g,'')+'-'+randomUUID().slice(0,8);
  const inbox=await exportMessages(mcp,'inbox',runId);
  const sent=await exportMessages(mcp,'sent',runId);
  const now=new Date();
  const start=ymd(new Date(now.getTime()-30*86400000));
  const end=ymd(new Date(now.getTime()+180*86400000));
  const calendar=await mcp.call('ofw_list_events',{startDate:start,endDate:end,detailed:true,timeZone:DEFAULT_TIMEZONE,format:'json'});
  const exportedAt=new Date().toISOString();
  await put('runs/'+runId+'/calendar.json',{source:'ourfamilywizard',exportedAt,startDate:start,endDate:end,timeZone:DEFAULT_TIMEZONE,calendar});
  const manifest={version:1,runId,exportedAt,readOnly:true,inbox,sent,calendar:{startDate:start,endDate:end,path:'runs/'+runId+'/calendar.json'},messagePages:'runs/'+runId+'/messages/{inbox|sent}/page-NNNN.json'};
  // Manifest is committed last so readers see only complete exports.
  await put('manifest/latest.json',manifest);
  console.log(JSON.stringify({ok:true,...manifest},null,2));
}
async function saveDraft(mcp,file) {
  if(!file)throw new Error('Usage: bridge draft C:\\path\\to\\draft.json');
  await verifyProjectSecret();
  await ensureBucket(true);
  const item=JSON.parse(await readFile(file,'utf8'));
  if(typeof item.requestId!=='string'||!/^[a-zA-Z0-9_-]{8,100}$/.test(item.requestId))throw new Error('draft requestId must be 8-100 alphanumeric/underscore/hyphen characters');
  if(typeof item.subject!=='string'||!item.subject.trim()||typeof item.body!=='string'||!item.body.trim())throw new Error('Draft requires nonempty subject and body');
  for(const field of ['messageId','replyToId'])if(item[field]!==undefined&&(!Number.isInteger(item[field])||item[field]<=0))throw new Error('Invalid '+field);
  const receipt='draft-receipts/'+item.requestId+'.json';
  try {
    const existing=await get(receipt);
    throw new Error('Draft request already processed or started; no duplicate created. Receipt: '+JSON.stringify(existing).slice(0,250));
  } catch(e) { if(e.status!==404)throw e; }
  // Reserve the request ID first. An interrupted save must be checked manually;
  // never blindly repeat a non-idempotent OFW create-draft request.
  await storage('object/'+BUCKET+'/'+receipt,'POST',{status:'started',at:new Date().toISOString(),requestId:item.requestId});
  const args={subject:item.subject,body:item.body};
  for(const field of ['messageId','replyToId','expectedRevision']) if(item[field]!==undefined)args[field]=item[field];
  const result=await mcp.call('ofw_save_draft',args);
  await put(receipt,{status:'saved',at:new Date().toISOString(),requestId:item.requestId,result});
  console.log(JSON.stringify({ok:true,requestId:item.requestId,receipt,result},null,2));
}
const mcp=new Mcp();
try {
  await mcp.init();
  if(command==='probe') await probe(mcp);
  else if(command==='sync') await sync(mcp);
  else if(command==='draft') await saveDraft(mcp,process.argv[3]);
  else throw new Error('Usage: bridge.mjs probe | sync | draft <file>');
} finally { mcp.close(); }
