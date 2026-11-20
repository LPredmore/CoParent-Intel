// OFW source-attachment archive -> private Supabase Storage.
// Never marks unread messages read, never uploads files TO OFW.
import { readFile, realpath, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { resolve, relative, isAbsolute, sep } from 'node:path';
import { makeClient, sourceAccount } from './import-db.mjs';

const MAX_BYTES=45*1024*1024; // standard upload safety limit; larger requires resumable upload
const SOURCE_FILE_LIMIT=10000;
const BATCH=200;
const digest=x=>createHash('sha256').update(x).digest('hex');
const positive=x=>Number.isSafeInteger(x)&&x>0?x:null;
const fileName=x=>typeof x==='string'&&x.length<512?x:null;
const record=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
async function stored(db,account,fileId) {
  const rows=await db.call('ofw_saved_files',{params:{
    select:'source_file_id,object_path,sha256,source_account',
    source_account:'eq.'+account,source_file_id:'eq.'+fileId,limit:1
  }});
  return Array.isArray(rows)?rows[0]??null:null;
}
async function allMessageCandidates(db,account) {
  const rows=[];
  for(let offset=0;offset<100000;offset+=BATCH) {
    const page=await db.call('ofw_messages',{params:{
      select:'source_message_id,folder,read_status,attachment_count',source_account:'eq.'+account,
      attachment_count:'gt.0',order:'source_message_id.asc',limit:BATCH,offset
    }});
    if(!Array.isArray(page))throw new Error('Could not list attachment-bearing message rows');
    rows.push(...page);
    if(page.length<BATCH)break;
  }
  return rows;
}
async function allReceiptLinks(db,account) {
  const rows=[];
  for(let offset=0;offset<100000;offset+=BATCH) {
    const page=await db.call('ofw_expense_attachment_refs',{params:{
      select:'source_expense_id,source_file_id',source_account:'eq.'+account,
      order:'source_expense_id.asc',limit:BATCH,offset
    }});
    if(!Array.isArray(page))throw new Error('Could not list expense receipt references');
    rows.push(...page);
    if(page.length<BATCH)break;
  }
  return rows;
}
async function safeReadDownload(p) {
  const requested=resolve(String(p||''));
  const base=resolve(process.env.OFW_ATTACHMENTS_DIR || resolve(homedir(),'Downloads','ofw-mcp'));
  const [root,actual]=await Promise.all([realpath(base),realpath(requested)]);
  const suffix=relative(root,actual);
  if(suffix==='..'||suffix.startsWith('..'+sep)||isAbsolute(suffix))
    throw new Error('OFW attachment path escapes configured local attachment directory');
  const info=await stat(actual);
  if(!info.isFile())throw new Error('OFW download did not produce a regular file');
  if(info.size>MAX_BYTES)throw new Error('Attachment exceeds 45 MiB standard upload limit; requires resumable upload.');
  const bytes=await readFile(actual);
  if(bytes.byteLength!==info.size)throw new Error('Downloaded attachment size changed during read');
  return bytes;
}
function objectUrl(baseUrl,account,id,hash){
  const path='attachments/'+account+'/'+id+'/'+hash;
  const url=new URL('/storage/v1/object/ofw-bridge/'+path,baseUrl);
  return {url,path};
}
async function verifyPrivateBinaryStorage({baseUrl,key}) {
  // Use a fixed harmless object under _checks; never transmit OFW content in the preflight.
  const data=new TextEncoder().encode('coparent-intel-ofw-private-storage-binary-check-v1');
  const path='/storage/v1/object/ofw-bridge/_checks/binary-upload-check.bin';
  const headers={
    apikey:key,Authorization:'Bearer '+key,
    'User-Agent':'CoParentIntel-OFWBridge/1.0 (trusted local backend)',
  };
  const upload=await fetch(new URL(path,baseUrl),{
    method:'POST',
    headers:{...headers,'Content-Type':'application/octet-stream','x-upsert':'true'},
    body:data,signal:AbortSignal.timeout(30000)
  });
  if(!upload.ok)throw new Error('Private Storage binary preflight upload HTTP '+upload.status+'; aborting before contacting OFW for attachments.');
  const download=await fetch(new URL(path.replace('/object/','/object/authenticated/'),baseUrl),{
    headers,signal:AbortSignal.timeout(30000)
  });
  if(!download.ok)throw new Error('Private Storage binary preflight download HTTP '+download.status+'; aborting before contacting OFW for attachments.');
  const actual=new Uint8Array(await download.arrayBuffer());
  if(digest(actual)!==digest(data))throw new Error('Private Storage binary preflight returned different bytes; aborting before OFW attachment downloads.');
  console.log('Private Storage binary write/read verified; starting OFW file archive.');
}

async function archiveFile({mcp,db,account,baseUrl,key,id,stats}) {
  const existing=await stored(db,account,id);
  if(existing){stats.alreadyArchived++;return;}
  const delivered=await mcp.call('ofw_download_attachment',{fileId:id,inline:false,extract:false,force:false});
  if(!delivered||typeof delivered.path!=='string')throw new Error('OFW attachment was not returned as a local downloadable file');
  const bytes=await safeReadDownload(delivered.path);
  const hash=digest(bytes);
  const {url,path}=objectUrl(baseUrl,account,id,hash);
  const mime=typeof delivered.mimeType==='string'&&/^[\w.+-]+\/[\w.+-]+$/.test(delivered.mimeType)
    ?delivered.mimeType:'application/octet-stream';
  const res=await fetch(url,{
    method:'POST',headers:{
      apikey:key,Authorization:'Bearer '+key,'content-type':mime,
      'x-upsert':'true','cache-control':'max-age=0',
      'User-Agent':'CoParentIntel-OFWBridge/1.0 (trusted local backend)',
    },
    body:bytes,signal:AbortSignal.timeout(180000)
  });
  if(!res.ok)throw new Error('Private Supabase Storage binary upload failed (HTTP '+res.status+'): '+(await res.text()).slice(0,180).replaceAll(key,'[REDACTED]'));
  // Only persist a DB receipt after Storage confirms the upload.
  await db.upsert('ofw_saved_files',[{
    source_account:account,source_file_id:id,
    bucket_id:'ofw-bridge',object_path:path,
    file_name:fileName(delivered.fileName)||fileName(delivered.path.split(/[\\/]/).at(-1)),
    mime_type:mime,size_bytes:bytes.length,sha256:hash,
    imported_at:new Date().toISOString()
  }],'source_account,source_file_id','merge');
  stats.archived++;
  stats.bytes+=bytes.length;
}
export async function archiveAttachments({mcp,baseUrl,key,ensureBucket}) {
  const account=sourceAccount();
  const db=makeClient(baseUrl,key);
  const bucket=await ensureBucket(true);
  if(bucket.public!==false)throw new Error('The OFW Storage bucket is not private; refusing uploads.');
  await verifyPrivateBinaryStorage({baseUrl,key});
  const [messages,expenses]=await Promise.all([allMessageCandidates(db,account),allReceiptLinks(db,account)]);
  const ids=new Set();
  const stats={attachmentBearingMessages:messages.length,expenseReceiptReferences:expenses.length,archived:0,alreadyArchived:0,bytes:0,unreadSkipped:0,metadataMissing:0,failed:0,errors:[]};
  for(const row of messages) {
    // Incoming unread messages must NOT be opened to discover file IDs.
    if(row.folder==='inbox'&&row.read_status!==true){stats.unreadSkipped++;continue;}
    let detail;
    try{
      detail=await mcp.call('ofw_get_message',{messageId:String(row.source_message_id),allowMarkRead:false,view:'compact'});
      if(row.folder==='inbox'&&detail?.read===false){stats.unreadSkipped++;continue;}
      const listed=Array.isArray(detail?.attachments)?detail.attachments:[];
      if(!listed.length){stats.metadataMissing++;continue;}
      const refs=[];
      for(const a of listed){
        const id=positive(a?.fileId);
        if(!id)continue;
        ids.add(id);
        refs.push({
          source_account:account,source_message_id:Number(row.source_message_id),source_file_id:id,
          file_name:fileName(a.fileName),
          mime_type:typeof a.mimeType==='string'?a.mimeType:null,
          size_bytes:Number.isSafeInteger(a.sizeBytes)&&a.sizeBytes>=0?a.sizeBytes:null,
          raw_payload:record(a)?a:{fileId:id}
        });
      }
      await db.upsert('ofw_attachment_refs',refs,'source_account,source_message_id,source_file_id','merge');
    }catch(e){
      stats.failed++;
      stats.errors.push('message '+row.source_message_id+': '+String(e.message||e).slice(0,170));
      continue;
    }
  }
  for(const row of expenses) {
    const id=positive(Number(row.source_file_id));
    if(id)ids.add(id);
  }
  if(ids.size>SOURCE_FILE_LIMIT)throw new Error('Attachment set unexpectedly exceeds allowed safety limit');
  let n=0;
  for(const id of ids){
    try{await archiveFile({mcp,db,account,baseUrl,key,id,stats});}
    catch(e){stats.failed++;stats.errors.push('file '+id+': '+String(e.message||e).slice(0,190));}
    n++;
    if(n%20===0||n===ids.size)console.log('Attachment archive: '+n+'/'+ids.size+' checked; '+stats.archived+' newly saved');
  }
  // No claims of complete archive when files are withheld or could not be fetched.
  const complete=stats.failed===0&&stats.unreadSkipped===0&&stats.metadataMissing===0;
  const report={ok:complete,project:'zhnpbajmumsbejyoqysr',privateBucket:true,
    totalUniqueFiles:ids.size,stats:{...stats,errors:stats.errors.slice(0,20)},
    note:complete?'All accessible referenced attachment files archived.':'Some attachment files remain unavailable; re-run safely after investigating the listed exclusions.',
    ofwMessagesSent:false,ofwUnreadMessagesOpened:false,ofwDraftsImported:false};
  console.log(JSON.stringify(report,null,2));
  if(!complete)process.exitCode=1;
  return report;
}
