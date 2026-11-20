// Read-only OFW expense catalog mirror. Does not create, reimburse or edit OFW expenses.
// Raw payload is authoritative where upstream financial data shape varies.
const EXPENSE_PAGE_SIZE=50;
const posInt=(x)=>Number.isSafeInteger(x)&&x>0?x:null;
const record=(x)=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const date=(v)=>{const s=record(v)?v.dateTime:v;return typeof s==='string'&&/^\d{4}-\d{2}-\d{2}/.test(s)?s.slice(0,10):null;};
function fileIds(item){
  const out=new Set();
  for(const key of ['fileIds','files','receipts']){
    if(!Array.isArray(item[key]))continue;
    for(const f of item[key]){
      const n=posInt(typeof f==='number'?f:record(f)?(f.fileId??f.id):null);
      if(n)out.add(n);
    }
  }
  // Real OFW expense lists use a single top-level fileId for receipts.
  // Older clients may expose receiptFileId or arrays instead.
  for(const field of ['fileId','receiptFileId']){
    const single=posInt(typeof item[field]==='number'?item[field]:record(item[field])?(item[field].fileId??item[field].id):null);
    if(single)out.add(single);
  }
  return [...out];
}
function toExpense(item,account,runId){
  if(!record(item))throw new Error('OFW expense response contains a non-object record');
  const id=posInt(item.id??item.expenseId);
  if(!id)throw new Error('OFW expense record missing a stable positive integer id. Import halted before silently dropping an expense.');
  const amount=typeof item.amount==='number'?item.amount:
    record(item.amount)&&typeof item.amount.total==='number'?item.amount.total:null;
  const money=amount!==null&&Number.isFinite(amount)&&amount>=0?amount:null;
  const cat=posInt(item.categoryId??item.category?.id);
  const payer=posInt(item.payerId??item.payer?.userId);
  const files=fileIds(item);
  return {
    row:{
      source_account:account,source_expense_id:id,
      title:typeof item.title==='string'?item.title:null,
      description:typeof item.description==='string'?item.description:null,
      purchase_date:date(item.purchaseDate),
      amount:money,category_id:cat,payer_id:payer,
      status:typeof item.status==='string'?item.status:null,
      is_private:typeof item.isPrivate==='boolean'?item.isPrivate:typeof item.private==='boolean'?item.private:null,
      receipt_file_ids:files,raw_payload:item,last_seen_at:new Date().toISOString(),last_import_run_id:runId
    },
    refs:files.map(source_file_id=>({source_account:account,source_expense_id:id,source_file_id}))
  };
}
export async function importExpenses({mcp,db,account,runId,stats}){
  const [categories,totals]=await Promise.all([
    mcp.call('ofw_list_expense_categories'),
    mcp.call('ofw_get_expense_totals')
  ]);
  // Preserve official category and ledger totals as returned, including custom categories.
  const cats=Array.isArray(categories?.data)?categories.data:Array.isArray(categories)?categories:null;
  if(!cats)throw new Error('OFW categories response is not recognized; expense archive incomplete');
  if(!record(totals))throw new Error('OFW expense totals response is not recognized');
  const categoryRows=cats.map(c=>{
    const id=posInt(c?.id);
    if(!id||!record(c))throw new Error('Invalid OFW expense category; no category silently skipped');
    return {source_account:account,category_id:id,label:typeof c.title==='string'?c.title:typeof c.name==='string'?c.name:null,raw_payload:c,imported_at:new Date().toISOString()};
  });
  await db.upsert('ofw_expense_categories',categoryRows,'source_account,category_id','merge');
  await db.upsert('ofw_expense_summaries',[{source_account:account,totals,last_seen_at:new Date().toISOString()}],'source_account','merge');
  let page=1,exported=0,hasMore=true,expectedTotal=null;
  const seen=new Set();
  while(hasMore){
    if(page>1000)throw new Error('Expense pagination exceeded 1000 pages; refusing to report a complete import');
    const result=await mcp.call('ofw_list_expenses',{page,size:EXPENSE_PAGE_SIZE});
    if(!Array.isArray(result?.data)||typeof result.hasMore!=='boolean'||result.page!==page)
      throw new Error('Unrecognized OFW expense page '+page+'; import not complete');
    const rows=[],refs=[];
    for(const expense of result.data){
      const mapped=toExpense(expense,account,runId);
      if(seen.has(mapped.row.source_expense_id))throw new Error('OFW expense id repeated on different pages: '+mapped.row.source_expense_id);
      seen.add(mapped.row.source_expense_id);
      rows.push(mapped.row);refs.push(...mapped.refs);
    }
    if(Number.isSafeInteger(result.total)){
      if(expectedTotal===null)expectedTotal=result.total;
      if(expectedTotal!==result.total)throw new Error('OFW expenses total changed during import; run again');
    }
    if(result.hasMore && (result.nextPage!==page+1||rows.length===0))
      throw new Error('Invalid OFW expense pagination / empty nonfinal page '+page);
    await db.upsert('ofw_expenses',rows,'source_account,source_expense_id','merge');
    await db.upsert('ofw_expense_attachment_refs',refs,'source_account,source_expense_id,source_file_id','merge');
    exported+=rows.length;
    stats.expenseReceiptLinks=(stats.expenseReceiptLinks||0)+refs.length;
    hasMore=result.hasMore;
    page=result.nextPage;
  }
  if(expectedTotal!==null&&exported!==expectedTotal)
    throw new Error('OFW expense total mismatch: '+exported+' fetched vs '+expectedTotal+' reported');
  // Trust the actual count for this source in the DB as a second completion criterion.
  const result=await db.call('ofw_expenses',{method:'HEAD',
    params:{select:'source_expense_id',source_account:'eq.'+account},prefer:'count=exact'});
  const match=String(result?.range||'').match(/\/(\d+)$/);
  if(!match||Number(match[1])<exported)
    throw new Error('Database does not contain the expected number of expense IDs');
  stats.expenses=exported;
  stats.expenseCategories=categoryRows.length;
  stats.verifiedExpenseCount=Number(match[1]);
  console.log('Imported OFW expenses: '+exported+'; categories: '+categoryRows.length+'; receipt references: '+stats.expenseReceiptLinks);
}
