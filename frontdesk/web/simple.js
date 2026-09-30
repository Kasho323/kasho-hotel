'use strict';
const $=s=>document.querySelector(s);
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const yuan=n=>'¥'+(n/100).toLocaleString('zh-CN',{minimumFractionDigits:2,maximumFractionDigits:2});
let state,busy=false,dialogRevision=0,timer,selected;
const addDays=(d,n)=>{const x=new Date(d+'T12:00:00');x.setDate(x.getDate()+n);return `${x.getFullYear()}-${String(x.getMonth()+1).padStart(2,'0')}-${String(x.getDate()).padStart(2,'0')}`;};
const dayCount=(a,b)=>Math.round((new Date(b+'T12:00:00')-new Date(a+'T12:00:00'))/86400000);
const modal=$('#modal');
const notesField=(value='')=>`<label class="notes-label" for="bookingNotes">备注（选填）<textarea id="bookingNotes" name="notes" aria-label="备注（选填）" maxlength="1000" rows="2" placeholder="如：晚到、加一床被子、明早叫醒">${esc(value)}</textarea></label>`;
function current(room){
  return state.bookings.find(b=>b.room===room&&KashoMoney.visible(b,selected));
}
function amount(b){return KashoMoney.charge(state,b);}
function paymentLabel(b){return KashoMoney.paymentStatus(b);}
function paymentField(b){return `<label class="payment-field">房费付款状态<select name="paymentStatus" aria-label="房费付款状态"><option ${!b||paymentLabel(b)==='已付'?'selected':''}>已付</option><option ${b&&paymentLabel(b)==='未付'?'selected':''}>未付</option></select></label>`;}
function roomColor(rows){const stays=rows.filter(b=>b.status!=='停用');if(!stays.length)return '';if(stays.some(b=>b.status!=='预订'&&paymentLabel(b)==='未付'))return 'unpaid';if(stays.some(b=>b.status==='预订'))return 'reserved';return 'paid';}
function dailyAmount(b,d){return KashoMoney.daily(state,b,d);}
function showToast(text){$('#toast').textContent=text;$('#toast').classList.remove('hidden');clearTimeout(timer);timer=setTimeout(()=>$('#toast').classList.add('hidden'),3000);}
async function refresh(){
  try{const r=await fetch('/api/state');if(!r.ok)throw Error();const next=await r.json();const changed=!state||state.revision!==next.revision||state.today!==next.today;if(state&&next.today!==state.today&&selected===state.today)selected=next.today;state=next;$('#offline').classList.add('hidden');$('#connection').textContent='已保存到本机';if(changed&&!modal.open)render();}
  catch{$('#offline').classList.remove('hidden');$('#connection').textContent='未连接';}
}
function render(){
  if(!selected||selected<addDays(state.today,-1)||selected>addDays(state.today,6))selected=state.today;
  let total=0;const moneyReport=KashoMoney.report(state,selected),{online,offline}=moneyReport.display;
  $('#currentDate').textContent=state.today.replaceAll('-',' / ');
  const yesterday=addDays(state.today,-1);$('#yesterdayButton').dataset.date=yesterday;$('#yesterdayButton').innerHTML=`<span>昨天</span><strong>${yesterday.slice(5).replace('-','/')}</strong>`;$('#yesterdayButton').classList.toggle('selected',selected===yesterday);$('#yesterdayButton').setAttribute('aria-pressed',String(selected===yesterday));$('#historyHint').classList.toggle('hidden',!moneyReport.history);
  $('#datePicker').innerHTML=Array.from({length:7},(_,i)=>{const d=addDays(state.today,i);return `<button data-date="${d}" aria-pressed="${d===selected}" class="${d===selected?'selected':''}"><span>${i===0?'今天':i===1?'明天':'周'+'日一二三四五六'[new Date(d+'T12:00:00').getDay()]}</span><strong>${d.slice(5).replace('-','/')}</strong></button>`;}).join('');
  $('#selectedLabel').textContent=selected===state.today?'今天':selected===yesterday?'昨天':selected.slice(5).replace('-','/');
  $('.overview>div>p').textContent=moneyReport.history?'点房号查看昨日记录；空房指当天未登记住宿的房间。':'点房号登记，按日期查看空房。';
  $('#rooms').innerHTML=Object.entries(state.rooms).map(([kind,rooms])=>{
    const free=rooms.filter(r=>!moneyReport.byRoom[r]),inventory=state.inventory?.[selected]?.[kind],netFree=inventory?Math.max(0,inventory.free):free.length;total+=netFree;
    return `<div class="room-group"><div><div class="type-title"><h3>${esc(kind)}</h3><span>剩 <strong>${netFree}</strong> / ${rooms.length} 间</span></div><p class="free-list">${inventory?.unassigned?`平台订单待分房 ${inventory.unassigned} 间。<button class="pending-manage" data-pending-kind="${esc(kind)}">查看 / 取消</button>`:''}${inventory?.free<0?`超订 ${-inventory.free} 间，请立即核对。`:''}${free.length?'可分配房号：'+free.join('、'):'暂无空房'}</p></div><div class="room-list">${rooms.map(room=>{const b=moneyReport.byRoom[room],rows=moneyReport.roomRows[room],fee=KashoMoney.totals(state,rows,selected).total,held=!b&&!moneyReport.history&&inventory?.unassigned>0&&inventory.free<=0,note=rows.find(row=>row.notes)?.notes,pending=b?.autoAssigned&&fee===0;return `<button class="room ${b?'occupied '+roomColor(rows):held?'unassigned-hold':''}" data-room="${room}" aria-label="${room} ${b?esc(b.channel)+' 已占用':held?'待分房':'空房'}${note?'，备注 '+esc(note):''}"><strong>${room}</strong><span>${b?(b.status==='停用'?'停用':rows.length>1?rows.length+' 条记录':esc(b.channel)+' · '+(b.status==='预订'?'已预订':paymentLabel(b))):(moneyReport.history?'无记录':held?'待分房':'空房 ＋')}</span>${note?`<span class="room-note" title="${esc(note)}">${esc(note)}</span>`:''}${b&&b.status!=='停用'?`<small data-cents="${fee}" data-channel="${rows.length===1?esc(b.channel):'混合'}" title="所选日房费（含未付）；点房号查看明细">${pending?'房费待录入':yuan(fee)}</small>${b.status==='预订'?`<span class="payment-sub">${pending?'付款待核对':paymentLabel(b)}</span>`:''}`:''}</button>`;}).join('')}</div></div>`;
  }).join('');
  $('#freeCount').textContent=total;
  $('#onlineTotal').textContent=yuan(online);$('#offlineTotal').textContent=yuan(offline);$('#dailyTotal').textContent=yuan(online+offline);
  const unpriced=Object.values(state.inventory?.[selected]||{}).reduce((sum,item)=>sum+item.unassigned,0);
  $('.overview .money-note').textContent=(moneyReport.history?'昨日登记房费（含已退房与未付）· 与房号相加一致 · 非收款流水':'当日房费（含预订、未付，不含已退房）· 与房号相加一致 · 非收款流水')+(unpriced?` · 平台订单待分房 ${unpriced} 间尚未录入房费`:'');
  $('#moneyScope').textContent=`已付 ${yuan(moneyReport.settled.total)} · 未付 ${yuan(moneyReport.unpaid.total)}；其中预订 ${yuan(KashoMoney.totals(state,moneyReport.shown.filter(b=>b.status==='预订'),selected).total)}${moneyReport.hidden.length?`；另有 ${moneyReport.hidden.length} 条非当前房号记录 ${yuan(moneyReport.hiddenTotals.total)}，见明细`:''}`;
  window.KashoOta?.render(state,selected);
}
function openHistoryRoom(room){
  const rows=KashoMoney.report(state,selected).roomRows[room];modal.classList.add('records-modal');dialogRevision=state.revision;
  $('#modalContent').innerHTML=`<div class="modal-head"><h2 id="dialogTitle">${room} · 昨日记录</h2><button class="close" data-close aria-label="关闭">×</button></div><div class="modal-body"><p class="batch-note">${selected} 住宿记录（按当前数据回看）。金额包含当天已退房记录；付款状态是目前登记状态，不是当时的收款快照。</p>${rows.map(b=>`<div class="record-row history-record"><div class="record-details"><strong>${esc(b.channel)} · ${esc(b.status)} · ${paymentLabel(b)}</strong><small>${esc(b.start)} → ${esc(b.end)} · #${b.id}</small>${b.notes?`<small class="record-note">${esc(b.notes)}</small>`:''}</div><strong>${yuan(dailyAmount(b,selected))}</strong><button data-history-edit="${b.id}">查看 / 编辑</button></div>`).join('')||'<p class="empty-records">昨天没有登记记录</p>'}</div>`;
  $('#modalContent').querySelectorAll('[data-history-edit]').forEach(button=>button.addEventListener('click',()=>openEdit(Number(button.dataset.historyEdit))));if(!modal.open)modal.showModal();
}
function openMoney(date=selected){
  modal.classList.add('records-modal');dialogRevision=state.revision;
  const report=KashoMoney.report(state,date),shownIds=new Set(report.shown.map(b=>b.id));
  const row=(label,value)=>`<tr><th>${label}</th><td>${yuan(value.online)}</td><td>${yuan(value.offline)}</td><td>${yuan(value.total)}</td></tr>`;
  $('#modalContent').innerHTML=`<div class="modal-head"><h2 id="dialogTitle">金额明细 / 对账</h2><button class="close" data-close aria-label="关闭">×</button></div><div class="modal-body"><label class="reconcile-date">核对日期 <input id="moneyDate" type="date" value="${esc(date)}" required></label><p class="batch-note">房号和首页：只加当前显示的房间，每间按所选日期分摊。已退房的钱保留在记录中，不混入首页。</p><div class="money-table-wrap"><table class="money-table"><thead><tr><th>统计范围</th><th>线上</th><th>线下</th><th>合计</th></tr></thead><tbody>${row('当前房号合计',report.display)}${row('其他记录（不计首页）',report.hiddenTotals)}${row('本日全部有效记录',report.all)}</tbody></table></div><details class="status-breakdown" open><summary>按记录状态分开看</summary><div class="money-table-wrap"><table class="money-table"><thead><tr><th>记录状态</th><th>线上</th><th>线下</th><th>合计</th></tr></thead><tbody>${['预订','在住','已退房'].map(s=>row(s,report.groups[s])).join('')}</tbody></table></div></details><p class="batch-note">以下每条均属于 ${esc(date)} 住宿日。取消、删除、停用不计入；金额不是当天实际到账或平台结算款。状态按当前记录显示。</p><div class="money-table-wrap"><table class="money-table money-entries"><thead><tr><th>房号 / 编号</th><th>客源 / 状态</th><th>整单已付</th><th>本日金额</th><th>计入首页</th><th></th></tr></thead><tbody>${report.rows.slice().sort((a,b)=>a.room.localeCompare(b.room)||a.id-b.id).map(b=>`<tr data-money-id="${b.id}"><td>${esc(b.room)}<small>#${b.id}</small></td><td>${esc(b.channel)}<small>${esc(b.status)}</small></td><td>${yuan(amount(b))}</td><td>${yuan(dailyAmount(b,date))}</td><td>${shownIds.has(b.id)?'是':'否'}</td><td><button data-money-edit="${b.id}">查看 / 编辑</button></td></tr>`).join('')||'<tr><td colspan="6">这一天没有有效金额记录</td></tr>'}</tbody></table></div><p class="batch-note">若是误录，请查看对应记录再更正；不要因为退房后不显示房号，就直接删除真实收款记录。</p></div>`;
  $('#moneyDate').addEventListener('change',e=>{if(e.target.value&&e.target.validity.valid)openMoney(e.target.value);});
  $('.modal-body>.batch-note').textContent=report.history?'历史日期按现有住宿记录回看，含当天已退房。以下均为房费（含未付），不是实际到账；付款状态是目前登记状态。':'当前房号只加显示的房间。以下均为房费（含未付），不是实际到账；已退房记录单独保留。';
  $('.money-table tbody').insertAdjacentHTML('beforeend',row('当前房号：已付',report.settled)+row('当前房号：未付',report.unpaid));
  $('.money-entries thead th:nth-child(3)').textContent='整单房费';
  $('.money-entries').querySelectorAll('[data-money-id]').forEach(tr=>{const b=state.bookings.find(x=>x.id===Number(tr.dataset.moneyId)),small=document.createElement('small');small.textContent=paymentLabel(b);tr.cells[1].append(small);});
  $('.money-entries').addEventListener('click',e=>{const button=e.target.closest('[data-money-edit]');if(button&&!busy)openEdit(Number(button.dataset.moneyEdit));});
  if(!modal.open)modal.showModal();
}
function openRoom(room){
  if(selected<state.today){openHistoryRoom(room);return;}
  modal.classList.remove('records-modal');
  const b=current(room),kind=Object.keys(state.rooms).find(k=>state.rooms[k].includes(room));dialogRevision=state.revision;
  const head=`<div class="modal-head"><h2 id="dialogTitle">${room}<small>${esc(kind)}</small></h2><button class="close" type="button" data-close aria-label="关闭">×</button></div>`;
  if(b){
    const actualToday=b.start<=state.today&&!(b.releasedOn&&b.releasedOn<=state.today)&&state.today<b.end;
    $('#modalContent').innerHTML=head+`<div class="modal-body"><div class="stay-info"><span>${b.status==='停用'?'房间停用':esc(b.channel)+' · 整单已付'}</span>${b.status==='停用'?'':`<strong>${b.autoAssigned&&amount(b)===0?'房费待录入':yuan(amount(b))}</strong>`}</div><p class="stay-date">${esc(b.start)} 入住 → ${esc(b.end)} 离店 · ${dayCount(b.start,b.end)} 晚</p><p class="stay-date">${selected} 分摊：${yuan(dailyAmount(b,selected))}</p><div id="formError" class="error hidden" role="alert"></div></div><div class="modal-foot"><button data-close>关闭</button>${b.status==='预订'?`<button id="moveBooking">换房</button><button id="cancelBooking">取消预订</button>${actualToday?'<button id="arrive" class="primary">确认到店</button>':''}`:actualToday?`<button id="checkout" class="checkout">${b.status==='停用'?'恢复空房':'确认退房'}</button>`:''}</div>`;
    $('#moveBooking')?.addEventListener('click',()=>openMove(b.id));
    $('#checkout')?.addEventListener('click',()=>save('quick-out',{bookingId:b.id},room+' 已恢复空房'));
    $('#arrive')?.addEventListener('click',()=>save('quick-arrive',{bookingId:b.id},room+' 已确认到店'));
    $('#cancelBooking')?.addEventListener('click',()=>{if(confirm('取消这笔预订？会同步释放关联平台订单在本机占用的房量；不会取消平台订单或执行退款。'))save('quick-cancel',{bookingId:b.id},room+' 已取消预订');});
    const edit=document.createElement('button');edit.textContent='编辑';edit.id='editBooking';edit.addEventListener('click',()=>openEdit(b.id));$('.modal-foot').firstElementChild.replaceWith(edit);
    if(b.status!=='停用'){$('.stay-info>span').textContent=b.channel+' · 整单房费';const p=document.createElement('p');p.className='payment-summary';p.textContent=b.autoAssigned&&amount(b)===0?'导入后自动分房：请核对房费和实际付款状态':`${paymentLabel(b)} · 客人已付 ${yuan(KashoMoney.paid(state,b))} · 待付 ${yuan(paymentLabel(b)==='未付'?amount(b):0)}`;$('#formError').before(p);}
    if(b.notes){const note=document.createElement('div');note.className='stay-notes';note.innerHTML='<span>备注</span><p></p>';note.querySelector('p').textContent=b.notes;$('#formError').before(note);}
  }else{
    $('#modalContent').innerHTML=head+`<form id="checkinForm"><div class="modal-body"><fieldset class="channels"><legend>客源</legend>${['携程','美团','线下'].map(c=>`<label><input type="radio" name="channel" value="${c}" required><span>${c}</span></label>`).join('')}</fieldset><label for="paidAmount" class="amount-label">客人已付金额</label><div class="amount-wrap"><span>¥</span><input id="paidAmount" name="amount" type="number" min="0" max="1000000" step="0.01" inputmode="decimal" required placeholder="输入金额"></div><div id="formError" class="error hidden" role="alert"></div></div><div class="modal-foot"><button type="button" data-close>取消</button><button type="submit" class="primary">确认入住</button></div></form>`;
    const stay=document.createElement('div');stay.className='stay-picker';stay.innerHTML=`<span>${selected} 入住</span><label>住几晚 <select name="nights" form="checkinForm" aria-label="住几晚">${Array.from({length:7},(_,i)=>`<option value="${i+1}">${i+1} 晚</option>`).join('')}</select></label><small id="checkoutDate"></small>`;$('.channels').before(stay);
    const updateEnd=()=>{$('#checkoutDate').textContent=addDays(selected,Number($('[name=nights]').value))+' 离店';};$('[name=nights]').addEventListener('change',updateEnd);updateEnd();
    if(selected>state.today)$('#checkinForm button[type=submit]').textContent='保存预订';
    $('#formError').insertAdjacentHTML('beforebegin',notesField());
    $('.amount-label').textContent='房费金额（整单）';$('.amount-label').insertAdjacentHTML('beforebegin',paymentField());
    let priceEdited=false;
    const defaultPrice=()=>{if(!priceEdited)$('#paidAmount').value=((state.defaultRates?.[kind]||0)*Number($('[name=nights]').value)/100).toFixed(2);};
    $('#paidAmount').addEventListener('input',()=>{priceEdited=true;});
    $('[name=nights]').addEventListener('change',defaultPrice);defaultPrice();
    window.KashoOta?.decorateCheckin(room,selected,kind);
    $('#checkinForm').addEventListener('submit',e=>{e.preventDefault();const data=Object.fromEntries(new FormData(e.target));save('quick-in',{room,...data,date:selected,nights:Number(data.nights)},room+(selected===state.today?' 入住成功':' 预订已保存'));});
  }
  if(!modal.open)modal.showModal();
}
function openMove(id){
  const original=state.bookings.find(row=>row.id===id);if(!original)return;
  const order=state.otaOrders?.find(o=>o.id===original.otaOrderId&&!o.manualIgnored&&!['已取消','已关闭','已撤销','取消','关闭'].includes(o.status));
  const b=order?{...original,start:order.start,end:order.end}:original;
  const kind=Object.keys(state.rooms).find(name=>state.rooms[name].includes(b.room));
  const choices=state.rooms[kind].filter(room=>room!==b.room&&!state.bookings.some(other=>other.id!==b.id&&!other.deletedAt&&other.status!=='已取消'&&other.room===room&&other.start<b.end&&b.start<(other.releasedOn&&other.releasedOn<other.end?other.releasedOn:other.end)));
  dialogRevision=state.revision;modal.classList.remove('records-modal');
  $('#modalContent').innerHTML=`<div class="modal-head"><h2 id="dialogTitle">${esc(b.room)} 换房</h2><button class="close" data-close aria-label="关闭">×</button></div><div class="modal-body"><p class="batch-note">${esc(b.start)} 至 ${esc(b.end)}，请选择同房型、整段住宿期间都空着的房间。备注、房费和携程订单关联会一起保留。</p><div class="move-options">${choices.map(room=>`<button type="button" data-move-room="${room}">${room}</button>`).join('')||'<p>这段住宿期间没有可换的同房型空房</p>'}</div><div id="formError" class="error hidden" role="alert"></div></div><div class="modal-foot"><button id="backToRoom">返回</button></div>`;
  $('#backToRoom').addEventListener('click',()=>openRoom(b.room));
  $('#modalContent').querySelectorAll('[data-move-room]').forEach(button=>button.addEventListener('click',()=>save('quick-move',{bookingId:id,room:button.dataset.moveRoom},`${b.room} 已换到 ${button.dataset.moveRoom}，原房间可重新分配`)));
}
function openEdit(id){
  const b=state.bookings.find(x=>x.id===id);if(!b||b.deletedAt)return;
  modal.classList.remove('records-modal');dialogRevision=state.revision;
  const nights=dayCount(b.start,b.end),options=Array.from({length:Math.max(7,nights)},(_,i)=>i+1).filter(n=>n<=7||n===nights);
  $('#modalContent').innerHTML=`<div class="modal-head"><h2 id="dialogTitle">编辑 ${esc(b.room)}</h2><button class="close" data-close aria-label="关闭">×</button></div>
  <form id="editForm"><div class="modal-body edit-body">
  <fieldset class="channels"><legend>客源</legend>${['携程','美团','线下'].map(c=>`<label><input type="radio" name="channel" value="${c}" ${b.channel===c?'checked':''} required><span>${c}</span></label>`).join('')}</fieldset>
  <label for="editAmount" class="amount-label">客人已付金额（整单）</label><div class="amount-wrap"><span>¥</span><input id="editAmount" name="amount" type="number" min="0" max="1000000" step="0.01" value="${(amount(b)/100).toFixed(2)}" required></div>
  <div class="edit-grid"><label>房号<select name="room" aria-label="房号">${Object.entries(state.rooms).map(([kind,rooms])=>`<optgroup label="${esc(kind)}">${rooms.map(r=>`<option ${r===b.room?'selected':''}>${r}</option>`).join('')}</optgroup>`).join('')}</select></label>
  <label>状态<select name="status" aria-label="状态">${(b.status==='停用'?['停用','已取消']:['在住','预订','已退房','已取消']).map(s=>`<option ${s===b.status?'selected':''}>${s}</option>`).join('')}</select></label>
  <label>入住日期<input name="date" aria-label="入住日期" type="date" value="${esc(b.start)}" max="${b.start>addDays(state.today,6)?b.start:addDays(state.today,6)}" required></label>
  <label>住几晚<select name="nights" aria-label="住几晚">${options.map(n=>`<option value="${n}" ${n===nights?'selected':''}>${n} 晚</option>`).join('')}</select></label></div>
  <p id="editHint" class="edit-hint"></p><div id="formError" class="error hidden" role="alert"></div>
  </div><div class="modal-foot"><button id="deleteBooking" type="button" class="danger">删除记录</button><button type="button" data-close>取消</button><button class="primary" type="submit">保存修改</button></div></form>`;
  const form=$('#editForm');
  $('.amount-label').textContent='房费金额（整单）';$('.amount-label').insertAdjacentHTML('beforebegin',paymentField(b));
  $('#editHint').insertAdjacentHTML('beforebegin',notesField(b.notes));
  function hint(){const d=form.elements.date.value,n=Number(form.elements.nights.value);$('#editHint').textContent=d?`${addDays(d,n)} 离店 · 修改后重新计算房量和每日金额`:'';}
  form.addEventListener('change',hint);hint();
  form.addEventListener('submit',e=>{e.preventDefault();const data=Object.fromEntries(new FormData(form));save('quick-edit',{...data,bookingId:b.id,nights:Number(data.nights)},'修改已保存，房量和金额已更新');});
  $('#deleteBooking').addEventListener('click',()=>{if(confirm(`删除 ${b.room} 的这条记录？\n将从房量和金额统计中移除，可以在“记录 / 修改 → 已删除”恢复。\n这不会执行实际退款。`))save('quick-delete',{bookingId:b.id},'记录已删除，可在“已删除”中恢复');});
  if(!modal.open)modal.showModal();
}
function openRecords(){
  if(!state)return;dialogRevision=state.revision;modal.classList.add('records-modal');
  $('#modalContent').innerHTML=`<div class="modal-head"><h2 id="dialogTitle">记录 / 修改</h2><button class="close" data-close aria-label="关闭">×</button></div><div class="modal-body"><div class="record-filters"><input id="recordSearch" aria-label="搜索记录" placeholder="搜索房号、日期或客源"><label><input id="showDeleted" type="checkbox"> 已删除</label></div><div id="recordList"></div><div class="record-pages"><button id="previousRecords">上一页</button><span id="recordCount"></span><button id="nextRecords">下一页</button></div><div id="formError" class="error hidden" role="alert"></div></div>`;
  const toolbar=document.createElement('div');toolbar.className='batch-toolbar';toolbar.innerHTML=`<label><input id="selectPage" type="checkbox"> 全选本页</label><span id="selectionCount">已选 0 条</span><button id="clearSelection">清空选择</button><button id="batchEdit">批量编辑</button><button id="batchDelete" class="danger">批量删除</button><button id="batchRestore" class="hidden">批量恢复</button>`;$('#recordList').before(toolbar);
  $('#recordSearch').placeholder='搜索房号、日期、客源或备注';
  let page=0,visible=[];const chosen=new Set();
  function selection(){
    $('#selectionCount').textContent=`已选 ${chosen.size} 条`;
    for(const id of ['batchEdit','batchDelete','batchRestore','clearSelection'])$('#'+id).disabled=!chosen.size;
    const checked=visible.filter(b=>chosen.has(b.id)).length;
    $('#selectPage').checked=visible.length>0&&checked===visible.length;$('#selectPage').indeterminate=checked>0&&checked<visible.length;$('#selectPage').disabled=!visible.length;
    document.querySelectorAll('[data-select-record]').forEach(input=>input.checked=chosen.has(Number(input.dataset.selectRecord)));
  }
  function list(){
    const q=$('#recordSearch').value.trim(),deleted=$('#showDeleted').checked;
    const rows=state.bookings.filter(b=>Boolean(b.deletedAt)===deleted&&`${b.room} ${b.channel} ${b.start} ${b.end} ${b.status} ${b.notes||''}`.includes(q)).sort((a,b)=>b.start.localeCompare(a.start)||b.id-a.id);
    page=Math.min(page,Math.max(0,Math.ceil(rows.length/20)-1));
    visible=rows.slice(page*20,page*20+20);
    $('#recordList').innerHTML=visible.map(b=>`<div class="record-row"><input type="checkbox" data-select-record="${b.id}" aria-label="选择 ${esc(b.room)} ${esc(b.start)} 记录 ${b.id}"><div class="record-details"><strong>${esc(b.room)}</strong><span> ${esc(b.channel)} · ${esc(b.status==='在住'&&b.end<=state.today?'已到离店日':b.status)}</span><small>${esc(b.start)} → ${esc(b.end)}</small>${b.notes?`<small class="record-note" title="${esc(b.notes)}">备注：${esc(b.notes)}</small>`:''}</div><strong>${yuan(amount(b))}</strong><button data-${deleted?'restore':'edit'}="${b.id}">${deleted?'恢复':'编辑'}</button></div>`).join('')||'<p class="empty-records">暂无记录</p>';
    $('#recordCount').textContent=`共 ${rows.length} 条${rows.length?` · 第 ${page+1} 页`:''}`;$('#previousRecords').disabled=page===0;$('#nextRecords').disabled=(page+1)*20>=rows.length;
    $('#recordList').querySelectorAll('.record-row').forEach((tr,i)=>{const small=document.createElement('small');small.textContent='房费 '+paymentLabel(visible[i]);tr.querySelector('.record-details').append(small);});
    $('#batchEdit').classList.toggle('hidden',deleted);$('#batchDelete').classList.toggle('hidden',deleted);$('#batchRestore').classList.toggle('hidden',!deleted);selection();
  }
  $('#recordSearch').addEventListener('input',()=>{page=0;chosen.clear();list();});$('#showDeleted').addEventListener('change',()=>{page=0;chosen.clear();list();});
  $('#previousRecords').addEventListener('click',()=>{page--;list();});$('#nextRecords').addEventListener('click',()=>{page++;list();});
  $('#selectPage').addEventListener('change',e=>{for(const b of visible){if(e.target.checked&&chosen.size<200)chosen.add(b.id);else if(!e.target.checked)chosen.delete(b.id);}selection();});
  $('#clearSelection').addEventListener('click',()=>{chosen.clear();selection();});
  $('#recordList').addEventListener('change',e=>{const input=e.target.closest('[data-select-record]');if(!input)return;const id=Number(input.dataset.selectRecord);if(input.checked&&chosen.size<200)chosen.add(id);else if(!input.checked)chosen.delete(id);else showToast('一次最多选择 200 条记录');selection();});
  $('#batchEdit').addEventListener('click',()=>openBatchEdit([...chosen]));
  $('#batchDelete').addEventListener('click',()=>{if(chosen.size&&confirm(`删除已勾选的 ${chosen.size} 条记录？\n这些记录将从房量和金额中移除，可在“已删除”恢复；不会执行退款。`))save('quick-batch',{operation:'delete',bookingIds:[...chosen]},`已删除 ${chosen.size} 条记录，可恢复`);});
  $('#batchRestore').addEventListener('click',()=>{if(chosen.size&&confirm(`恢复已勾选的 ${chosen.size} 条记录？\n将重新计算房量和金额，任意一条撞房则全部不恢复。`))save('quick-batch',{operation:'restore',bookingIds:[...chosen]},`已恢复 ${chosen.size} 条记录`);});
  $('#recordList').addEventListener('click',e=>{if(busy)return;const edit=e.target.closest('[data-edit]'),restore=e.target.closest('[data-restore]');if(edit)openEdit(Number(edit.dataset.edit));if(restore&&confirm('恢复这条记录？系统将重新计算房量和金额；如与其他记录冲突则不会恢复。'))save('quick-restore',{bookingId:Number(restore.dataset.restore)},'记录已恢复');});
  list();if(!modal.open)modal.showModal();
}
function openBatchEdit(ids){
  if(!ids.length)return;modal.classList.remove('records-modal');
  const labels={channel:'客源',amount:'每条整单房费金额',date:'入住日期',nights:'住几晚',status:'状态',paymentStatus:'房费付款状态'};
  const controls={
    channel:`<select name="channel" disabled>${['携程','美团','线下'].map(c=>`<option>${c}</option>`).join('')}</select>`,
    amount:'<input name="amount" type="number" min="0" max="1000000" step="0.01" placeholder="每条都改为此金额" disabled>',
    date:`<input name="date" type="date" max="${addDays(state.today,6)}" disabled>`,
    nights:`<select name="nights" disabled>${Array.from({length:7},(_,i)=>`<option value="${i+1}">${i+1} 晚</option>`).join('')}</select>`,
    status:`<select name="status" disabled>${['在住','预订','已退房','已取消'].map(c=>`<option>${c}</option>`).join('')}</select>`,
    paymentStatus:'<select name="paymentStatus" disabled><option>已付</option><option>未付</option></select>'
  };
  $('#modalContent').innerHTML=`<div class="modal-head"><h2 id="dialogTitle">批量编辑 ${ids.length} 条</h2><button class="close" data-close aria-label="关闭">×</button></div><form id="batchForm"><div class="modal-body"><p class="batch-note">只改勾选的项目，其余保持原样。金额是每条记录的整单金额，不是总和或补款。</p><details class="batch-preview"><summary>查看选中的 ${ids.length} 条记录</summary>${ids.map(id=>{const b=state.bookings.find(x=>x.id===id);return `<p>${esc(b.room)} · ${esc(b.start)} · ${esc(b.channel)} · ${yuan(amount(b))}</p>`;}).join('')}</details>${Object.entries(labels).map(([key,label])=>`<div class="batch-field"><label><input type="checkbox" data-apply="${key}"> 修改${label}</label><label class="batch-value"><span class="hidden">${label}</span>${controls[key]}</label></div>`).join('')}<p class="batch-note">房号请逐条编辑。任何记录不符合条件或撞房，本次全部不保存。</p><div id="formError" class="error hidden" role="alert"></div></div><div class="modal-foot"><button type="button" id="backToRecords">返回记录</button><button class="primary" type="submit">保存批量修改</button></div></form>`;
  const form=$('#batchForm');
  for(const key of Object.keys(labels))form.elements[key].setAttribute('aria-label',labels[key]);
  form.addEventListener('change',e=>{$('#formError').classList.add('hidden');const check=e.target.closest('[data-apply]');if(check){const control=form.elements[check.dataset.apply];control.disabled=!check.checked;control.required=check.checked;}});
  $('#backToRecords').addEventListener('click',openRecords);
  form.addEventListener('submit',e=>{e.preventDefault();const changes=Object.fromEntries(new FormData(form));if(!Object.keys(changes).length){$('#formError').textContent='请勾选至少一项要修改的内容';$('#formError').classList.remove('hidden');return;}if('nights'in changes)changes.nights=Number(changes.nights);const summary=Object.entries(changes).map(([k,v])=>`${labels[k]} → ${v}${k==='amount'?' 元 / 条':''}`).join('\n');if(confirm(`将修改 ${ids.length} 条记录：\n${summary}\n未勾选的项目不变。确认保存？`))save('quick-batch',{operation:'edit',bookingIds:ids,changes},`已修改 ${ids.length} 条记录，房量和金额已更新`);});
}
async function save(action,data,message){
  if(busy)return;busy=true;const controls=[...modal.querySelectorAll('button,input,select,textarea')].map(element=>({element,disabled:element.disabled}));controls.forEach(({element})=>element.disabled=true);$('#formError').classList.add('hidden');
  try{const r=await fetch('/api/'+action,{method:'POST',headers:{'Content-Type':'application/json','X-Kasho-Request':'frontdesk'},body:JSON.stringify({...data,revision:dialogRevision})});const result=await r.json();if(!r.ok)throw Error(result.error||'保存失败，请重试');state=result;modal.close();render();showToast(message);}
  catch(e){$('#formError').textContent=e.message;$('#formError').classList.remove('hidden');}
  finally{busy=false;controls.forEach(({element,disabled})=>element.disabled=disabled);}
}
document.addEventListener('click',e=>{if(busy)return;const date=e.target.closest('[data-date]');if(date){selected=date.dataset.date;render();return;}const room=e.target.closest('[data-room]');if(room)openRoom(room.dataset.room);if(e.target.closest('[data-close]'))modal.close();});
$('#recordsButton').addEventListener('click',()=>{if(!busy)openRecords();});
$('#moneyDetails').addEventListener('click',()=>{if(state&&!busy)openMoney();});
modal.addEventListener('cancel',e=>{if(busy)e.preventDefault();});
modal.addEventListener('close',()=>{if(!busy)refresh();});
refresh();setInterval(()=>{if(!busy&&!modal.open)refresh();},10000);
