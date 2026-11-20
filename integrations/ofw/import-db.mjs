// Strict local OFW -> Supabase structured importer, no third-party packages.
// Caller supplies existing restricted MCP connection and verified project Secret key.
// Nothing in this module sends/edits OFW messages or opens unread message bodies.
import { createHash, randomUUID } from 'node:crypto';
import { importExpenses } from './expense-import.mjs';

const SOURCE = 'ourfamilywizard';
const PAGE = 80;
const CALENDAR_START_YEAR = 2010;
const TIMEZONE = 'America/Chicago';

function nonemptyObject(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }
function numberId(v) { return Number.isSafeInteger(v) && v > 0 ? v : null; }
function rawDate(v) {
  if (typeof v === 'string') return v;
  if (nonemptyObject(v) && typeof v.dateTime === 'string') return v.dateTime;
  return null;
}
function timestamp(v) {
  const s = rawDate(v);
  // Never silently reinterpret zone-less OFW wall times as UTC or host local time.
  if (!s || !/(?:Z|[+-]\d{2}:\d{2})$/i.test(s)) return null;
  const n = Date.parse(s);
  return Number.isFinite(n) ? new Date(n).toISOString() : null;
}
function sha(value) { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
function sourceAccount() {
  const id = (process.env.OFW_USERNAME || '').trim().toLowerCase();
  if (!id) throw new Error('OFW_USERNAME missing; refusing import without a stable account identifier.');
  return 'ofw-' + sha(id).slice(0,24);
}
function redact(error, key) {
  return String(error).replaceAll(key, '[REDACTED_KEY]').replace(/sb_secret_[A-Za-z0-9_-]+/g,'[REDACTED_KEY]').slice(0,600);
}
function makeClient(baseUrl, key) {
  if (new URL(baseUrl).hostname !== 'zhnpbajmumsbejyoqysr.supabase.co')
    throw new Error('Unexpected project URL. Refusing to import into a different Supabase project.');
  async function call(table, {method='GET',params={},data,prefer}={}) {
    const url = new URL('/rest/v1/' + table, baseUrl);
    for (const [k,v] of Object.entries(params)) url.searchParams.set(k, String(v));
    const headers = {
      apikey:key,
      Authorization:'Bearer ' + key,
      Accept:'application/json',
      'User-Agent':'CoParentIntel-OFWImporter/1.0 (Node.js backend)',
    };
    if (data !== undefined) headers['Content-Type']='application/json';
    if (prefer) headers.Prefer=prefer;
    let res;
    try {
      res=await fetch(url,{
        method,headers,
        body:data===undefined?undefined:JSON.stringify(data),
        signal:AbortSignal.timeout(120000),
      });
    } catch(e) { throw new Error('Supabase '+table+' network error: '+redact(e?.message||e,key)); }
    if (!res.ok) {
      const err=await res.text();
      throw new Error('Supabase '+table+' '+method+' HTTP '+res.status+': '+redact(err,key));
    }
    if (method==='HEAD') return {range:res.headers.get('content-range')};
    if (res.status===204) return null;
    const txt=await res.text();
    if (!txt.trim()) return null;
    try {return JSON.parse(txt)}catch{throw new Error('Non-JSON API response from '+table)}
  }
  const upsert = async (table,rows,conflict,mode='ignore') => {
    if(!rows.length)return;
    for(let i=0;i<rows.length;i+=PAGE) {
      await call(table,{
        method:'POST',params:{on_conflict:conflict},
        data:rows.slice(i,i+PAGE),
        prefer:'resolution='+ (mode==='merge'?'merge-duplicates':'ignore-duplicates') +',return=minimal'
      });
    }
  };
  return {call,upsert};
}
function mapMessage(m,folder,account,runId) {
  const id=numberId(m?.id);
  if (!id)throw new Error('Message with missing/invalid OFW id; refusing silent data loss.');
  if (!nonemptyObject(m))throw new Error('Unrecognized OFW message record.');
  if(m.folder && m.folder!==folder)throw new Error('OFW message folder inconsistency for id '+id);
  return {
    source_account:account,source_message_id:id,folder,
    subject:typeof m.subject==='string'?m.subject:'',
    sender_name:typeof m.from==='string'?m.from:null,
    sent_at:timestamp(m.sentAt),body:typeof m.body==='string'?m.body:null,
    body_fetched_at:timestamp(m.fetchedBodyAt),
    read_status:typeof m.read==='boolean'?m.read:null,
    replied:typeof m.replied==='boolean'?m.replied:null,
    attachment_count:Number.isInteger(m.files)&&m.files>=0?m.files:null,
    reply_to_id:numberId(m.replyToId),
    chain_root_id:numberId(m.chainRootId),
    recipients:Array.isArray(m.recipients)?m.recipients:[],
    raw_payload:m,last_import_run_id:runId
  };
}
function recipientsFor(m,account) {
  const id=numberId(m.id);
  const recipients=Array.isArray(m.recipients)?m.recipients:[];
  const byUser=new Map();
  for(const r of recipients) {
    if (!nonemptyObject(r))continue;
    const uid=numberId(r.userId);
    if(!uid)continue; // Original recipient remains in raw_payload/recipients.
    byUser.set(uid,{
      source_account:account,source_message_id:id,source_user_id:uid,
      recipient_name:typeof r.name==='string'?r.name:'',
      viewed_at:timestamp(r.viewedAt),
      viewed_at_source:['detail','list'].includes(r.viewedAtSource)?r.viewedAtSource:null,
      viewed_at_checked_at:timestamp(r.viewedAtCheckedAt),
      viewed_placeholder:typeof r.viewedPlaceholder==='string'?r.viewedPlaceholder:null,
      raw_payload:r
    });
  }
  return [...byUser.values()];
}
function attachmentRefsFor(m,account) {
  const id=numberId(m.id);
  // The compact list provides an attachment COUNT only. Never fabricate file IDs.
  const list=Array.isArray(m.attachments)?m.attachments:[];
  const seen=new Map();
  for (const a of list) {
    const n=numberId(a?.fileId);
    if(!n)continue;
    seen.set(n,{
      source_account:account,source_message_id:id,source_file_id:n,
      file_name:typeof a.fileName==='string'?a.fileName:null,
      mime_type:typeof a.mimeType==='string'?a.mimeType:null,
      size_bytes:Number.isSafeInteger(a.sizeBytes)&&a.sizeBytes>=0?a.sizeBytes:null,
      raw_payload:a
    });
  }
  return [...seen.values()];
}
function eventIdentity(item) {
  // OFW custody TRANSITION items can all have numeric id 1.
  // A type + occurrence clock + parent-IDs composite identifies occurrences.
  const start=rawDate(item.startDate);
  const end=rawDate(item.endDate);
  return 'ofw-'+sha([item.type||'',item.id??null,start,end,
    item.eventRecurrenceId??null,
    item.transitionEndParent?.userId??null,
    item.transitionStartParent?.userId??null]).slice(0,48);
}
function mapEvent(item,account,runId) {
  if(!nonemptyObject(item)||typeof item.type!=='string')throw new Error('Calendar response has an item without a type.');
  return {
    source_account:account,event_key:eventIdentity(item),
    source_event_id:item.id==null?null:String(item.id),
    event_type:item.type,title:typeof item.title==='string'?item.title:null,
    starts_at:timestamp(item.startDate),
    ends_at:timestamp(item.endDate),
    timezone:TIMEZONE,raw_payload:item,last_import_run_id:runId
  };
}
async function refreshMessages(mcp) {
  let state;
  // Bounded backfill. A partial sync must NEVER be presented as "all records".
  for(let i=1;i<=20;i++){
    state=await mcp.call('ofw_sync_messages',{
      folders:['inbox','sent'],deep:false,fetchUnreadBodies:false
    });
    if(state?.markedRead?.length)throw new Error('OFW markedRead unexpectedly nonempty! Stop import and investigate.');
    const done=state?.syncComplete===true||state?.done===true;
    const history=state?.historyComplete??state?.freshness?.historyComplete;
    console.log('Read-only OFW message refresh '+i+': '+(done?'complete':'continuing')+', history '+(history===false?'incomplete':'not flagged incomplete'));
    if(done && history!==false)return;
  }
  throw new Error('OFW historical backfill is incomplete after 20 bounded passes. No incomplete import is marked successful.');
}
async function importFolders(mcp,db,account,runId,stats) {
  for(const folder of ['inbox','sent']){
    let total=null, imported=0, page=1;
    while(true){
      const r=await mcp.call('ofw_list_messages',{folderId:folder,page,size:PAGE,view:'compact',autoRefresh:false});
      if(!Number.isInteger(r?.total)||r.total<0||!Array.isArray(r.messages))throw new Error('Unrecognized '+folder+' list response');
      if(total===null)total=r.total;
      if(r.total!==total)throw new Error('OFW '+folder+' changed during import; rerun to reconcile.');
      const expected=Math.min(PAGE,total-imported);
      if(r.messages.length!==expected)throw new Error('OFW '+folder+' page '+page+' expected '+expected+', got '+r.messages.length);
      const rows=r.messages.map(m=>mapMessage(m,folder,account,runId));
      await db.upsert('ofw_messages',rows,'source_account,source_message_id');
      const recipients=r.messages.flatMap(m=>recipientsFor(m,account));
      await db.upsert('ofw_message_recipients',recipients,'source_account,source_message_id,source_user_id');
      const files=r.messages.flatMap(m=>attachmentRefsFor(m,account));
      await db.upsert('ofw_attachment_refs',files,'source_account,source_message_id,source_file_id');
      imported+=rows.length;stats.messages+=rows.length;stats.recipients+=recipients.length;stats.attachmentRefs+=files.length;
      if(page%10===0||imported===total)console.log('Imported '+folder+': '+imported+'/'+total);
      if(imported===total)break;
      page++;
    }
    stats[folder]=total;
  }
}
function months(startYear,endYear) {
  const out=[];
  for(let year=startYear;year<=endYear;year++){
    for(let q=0;q<4;q++){
      const month=q*3;
      const start=new Date(Date.UTC(year,month,1)).toISOString().slice(0,10);
      const end=new Date(Date.UTC(year,month+3,0)).toISOString().slice(0,10);
      out.push({start,end});
    }
  }
  return out;
}
async function importCalendar(mcp,db,account,runId,stats){
  const endYear=new Date().getUTCFullYear()+1;
  for(const {start,end} of months(CALENDAR_START_YEAR,endYear)){
    // Full payload includes guardianData/SCHEDULE custody grid where supplied.
    const data=await mcp.call('ofw_list_events',{startDate:start,endDate:end,detailed:true,timeZone:TIMEZONE,format:'json'});
    if(!nonemptyObject(data)||!Array.isArray(data.calendarItems))
      throw new Error('Unrecognized calendar response for '+start+'..'+end+'; not silently skipping this window.');
    await db.upsert('ofw_calendar_snapshots',[{
      source_account:account,window_start:start,window_end:end,time_zone:TIMEZONE,
      raw_payload:data,item_count:data.calendarItems.length,last_import_run_id:runId
    }],'source_account,window_start,window_end','merge');
    const rows=data.calendarItems.map(item=>mapEvent(item,account,runId));
    await db.upsert('ofw_calendar_items',rows,'source_account,event_key');
    stats.calendarItems+=rows.length;
    stats.calendarWindows++;
    if(stats.calendarWindows%8===0)console.log('Imported calendar windows '+stats.calendarWindows+' (through '+end+')');
  }
}
export async function importToDatabase({mcp,baseUrl,key,remainingOnly=false}) {
  const account=sourceAccount();
  const db=makeClient(baseUrl,key);
  // Ensure the new target schema is installed BEFORE reading any source data.
  await db.call('ofw_messages',{params:{select:'source_message_id',limit:0}});
  await db.call('ofw_calendar_snapshots',{params:{select:'window_start',limit:0}});
  await db.call('ofw_expenses',{params:{select:'source_expense_id',limit:0}});
  console.log('Verified private OFW import tables in target project.');
  await refreshMessages(mcp);
  const rows=await db.call('ofw_import_runs',{
    method:'POST',data:[{
      source_account:account,
      external_run_id:'local-'+randomUUID(),
      status:'started',metadata:{source:SOURCE,mode:'initial-db-import',calendarFromYear:CALENDAR_START_YEAR,unreadBodiesFetched:false}
    }],
    prefer:'return=representation'
  });
  const runId=rows?.[0]?.id;
  if(typeof runId!=='string')throw new Error('Could not create import run audit row');
  const stats={messages:0,inbox:0,sent:0,recipients:0,attachmentRefs:0,calendarItems:0,calendarWindows:0,expenses:0,expenseCategories:0,expenseReceiptLinks:0};
  let error=null;
  try{
    if(remainingOnly) {
      for(const folder of ['inbox','sent']){
        const source=await mcp.call('ofw_list_messages',{folderId:folder,page:1,size:1,view:'compact',autoRefresh:false});
        if(!Number.isSafeInteger(source?.total)||source.total<0) throw new Error('Invalid source count for '+folder);
        const dbCount=await db.call('ofw_messages',{method:'HEAD',
          params:{select:'source_message_id',source_account:'eq.'+account,folder:'eq.'+folder},
          prefer:'count=exact'});
        const countMatch=String(dbCount?.range||'').match(new RegExp('/([0-9]+)$'));
        if(!countMatch||Number(countMatch[1])!==source.total)
          throw new Error('Recovery stopped: '+folder+' database count does not match source. Run full import-db instead.');
        stats[folder]=source.total;
        stats.messages+=source.total;
      }
      console.log('Recovery check passed: '+stats.messages+' existing messages; skipping repeated uploads.');
    } else {
      await importFolders(mcp,db,account,runId,stats);
    }
    // OFW drafts are never read, mirrored or saved here. Outbound draft
    // creation uses the separate "draft" command, with no historic sync.
    await importCalendar(mcp,db,account,runId,stats);
    await importExpenses({mcp,db,account,runId,stats});
    const expected=stats.inbox+stats.sent;
    if(stats.messages!==expected)throw new Error('Inbox + Sent record totals disagree.');
    // Verify the table's actual source-scoped count, not merely successful HTTP writes.
    const range=await db.call('ofw_messages',{method:'HEAD',
      params:{select:'source_message_id',source_account:'eq.'+account},
      prefer:'count=exact'
    });
    const match=/\/(\d+)$/.exec(range?.range||'');
    if(!match)throw new Error('Unable to verify PostgREST message count after insert.');
    const existing=Number(match[1]);
    if(existing<expected)throw new Error('Database contains only '+existing+' of '+expected+' expected OFW message IDs');
    await db.call('ofw_import_runs',{
      method:'PATCH',params:{id:'eq.'+runId},
      data:{status:'completed',completed_at:new Date().toISOString(),expected_messages:expected,imported_messages:stats.messages,
        error_count:0,error_summary:null,
        metadata:{...stats,source:SOURCE,mode:remainingOnly?'recovery-db-import':'initial-db-import',account,calendarFromYear:CALENDAR_START_YEAR,verifiedDatabaseMessageCount:existing,unreadBodiesFetched:false,draftsImported:false,attachmentBytesImported:false}},
      prefer:'return=minimal'
    });
    console.log(JSON.stringify({ok:true,status:'completed',runId,project:'zhnpbajmumsbejyoqysr',stats,verifiedDatabaseMessageCount:existing,
      unreadMessagesOpened:false,ofwMessagesSent:false,lovableDatabaseTouched:false,draftsImported:false,
      note:'Messages, calendar and expenses imported. Drafts deliberately excluded. Binary attachments must be archived separately.'},null,2));
  }catch(e){
    error=e;
    try{
      await db.call('ofw_import_runs',{
        method:'PATCH',params:{id:'eq.'+runId},
        data:{status:'partial',error_count:1,error_summary:String(e?.message||e).slice(0,450),imported_messages:stats.messages,metadata:{...stats,account,unreadBodiesFetched:false}},
        prefer:'return=minimal'
      });
    }catch{}
  }
  if(error)throw error;
}
