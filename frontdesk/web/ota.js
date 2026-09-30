'use strict';
(function(){
  const labels={ctrip:'携程/去哪儿',meituan:'美团'};
  const kinds=['标准间','大床房','高级观景','舒适观景'];
  const get=s=>document.querySelector(s);
  const active=o=>!o.manualIgnored&&!['已取消','已关闭','已撤销','取消','关闭'].includes(o.status);
  const quantity=o=>active(o)?Math.min(o.quantity,o.localQuantityCap??o.quantity):0;
  const shortId=id=>String(id).slice(-6);
  const linked=o=>state.bookings.filter(b=>b.otaOrderId===o.id&&!b.deletedAt&&b.status!=='已取消'&&b.start===o.start&&b.end===o.end&&state.rooms[o.kind].includes(b.room));
  const open=html=>{modal.classList.add('records-modal');dialogRevision=state.revision;get('#modalContent').innerHTML=html;if(!modal.open)modal.showModal();};
  const head=title=>`<div class="modal-head"><h2 id="dialogTitle">${title}</h2><button class="close" data-close aria-label="关闭">×</button></div>`;
  const message=value=>{const el=get('#otaError');if(el){el.textContent=value;el.classList.remove('hidden');}else showToast(value);};
  async function api(action,data){
    const response=await fetch('/api/'+action,{method:'POST',headers:{'Content-Type':'application/json','X-Kasho-Request':'frontdesk'},body:JSON.stringify({...data,revision:state.revision})});
    const result=await response.json();
    if(!response.ok)throw Error(result.error||'操作失败，请重试');
    return result;
  }
  async function change(action,data,after){
    if(busy)return;
    busy=true;
    try{state=await api(action,data);render();after?.();}
    catch(error){message(error.message);}
    finally{busy=false;}
  }
  function alertText(a){
    const condition=a.mode==='review-open'?`重新有 ${a.free} 间可售`:a.free<0?`超订 ${-a.free} 间`:`已满 ${a.capacity}/${a.capacity}`;
    return `<strong>${esc(a.date.slice(5))} · ${esc(a.kind)}</strong><span>${condition}${a.unassigned?` · 待分房 ${a.unassigned}`:''}</span>`;
  }
  function renderAlerts(){
    document.querySelectorAll('[data-pending-kind]').forEach(button=>button.addEventListener('click',()=>openOrders(button.dataset.pendingKind)));
    const alerts=state.closureAlerts||[],pending=alerts.filter(a=>Object.values(a.platforms).some(value=>value===false));
    get('#otaFreshness').textContent=state.otaLastImportAt?`携程订单上次导入：${state.otaLastImportAt.replace('T',' ')}`:'尚未导入携程订单；提醒按本机登记及手工美团订单计算';
    get('#allAlertsButton').textContent=`全部提醒${pending.length?`（${pending.length} 待处理）`:''}`;
    get('#closureSection').classList.toggle('has-pending',pending.length>0);
    get('#closurePreview').innerHTML=alerts.length?alerts.slice(0,4).map(a=>`<button class="closure-tile ${a.free<0?'overbook':''}" data-alert-open>${alertText(a)}<small>${Object.entries(a.platforms).filter(([,v])=>v!==null).map(([platform,done])=>`${labels[platform]}${done?'已核对':'待处理'}`).join(' · ')}</small></button>`).join(''):'<p class="closure-ok">未来暂未发现满房日期。</p>';
  }
  function platformButtons(a){
    return Object.entries(a.platforms).filter(([,value])=>value!==null).map(([platform,done])=>`<button type="button" class="platform-check ${done?'done':''}" data-platform="${platform}" data-date="${a.date}" data-kind="${esc(a.kind)}" data-mode="${a.mode}" data-fingerprint="${a.fingerprint}" ${done?'disabled':''}>${labels[platform]}${done?'已核对':a.mode==='close'?'已关房':'已核对重新开房'}</button>`).join('');
  }
  function openAlerts(){
    const rows=state.closureAlerts||[];
    open(head('未来关房提醒')+`<div class="modal-body"><p class="batch-note">根据系统中已登记的房号与导入订单，按房型、按住宿日计算。请先在平台实际操作，再点下方按钮留记录。没有导入的美团订单须手工登记。</p><div id="otaError" class="error hidden"></div>${rows.map(a=>`<div class="closure-alert-row ${a.free<0?'overbook':''}">${alertText(a)}<div class="closure-platforms">${platformButtons(a)}</div></div>`).join('')||'<p class="empty-records">未来没有需要关房或重新开房的提醒</p>'}<p class="batch-note">关房后若订单变动，系统会要求重新核对；导出文件不是实时平台连接。</p></div>`);
    get('#modalContent').querySelectorAll('[data-platform]').forEach(button=>button.addEventListener('click',()=>change('platform-check',{date:button.dataset.date,kind:button.dataset.kind,platform:button.dataset.platform,mode:button.dataset.mode,fingerprint:button.dataset.fingerprint},openAlerts)));
  }
  function suggested(product){
    if(product.includes('观景舒适'))return '舒适观景';
    if(product.includes('观景高级'))return '高级观景';
    if(product.includes('大床'))return '大床房';
    if(product.includes('标准'))return '标准间';
    return '';
  }
  function openImport(){
    open(head('导入携程订单')+`<div class="modal-body"><p class="batch-note">选择携程 eBooking 导出的原始 .xls 文件。先核对房型，再导入并自动分配可用房号。姓名会写在房间备注上；同一订单号重复导入不会新增占房。</p><label class="ota-file">订单文件 <input id="otaFile" type="file" accept=".xls" aria-label="携程订单文件"></label><div id="otaError" class="error hidden"></div><div id="otaImportPreview"></div></div>`);
    get('#otaFile').addEventListener('change',async e=>{
      const file=e.target.files[0];if(!file)return;
      if(file.size>10_000_000){message('订单文件最多 10 MB');return;}
      get('#otaImportPreview').textContent='正在读取订单…';
      try{
        const base64=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result).split(',')[1]);reader.onerror=reject;reader.readAsDataURL(file);});
        const preview=await api('ota-preview',{file:base64});
        get('#otaImportPreview').innerHTML=`<div class="ota-preview-summary"><strong>文件共 ${preview.count} 笔不同订单</strong><span>新增 ${preview.new} · 系统已有 ${preview.existing} · 共 ${preview.roomNights} 间夜</span><small>日期 ${esc(preview.firstDate)} 至 ${esc(preview.lastDate)}。系统旧订单有 ${preview.notInFile} 笔未出现在此文件，仍会保留，请核对取消情况。</small><small>预订网站：${Object.entries(preview.sites).map(([site,n])=>esc(site)+' '+n).join('、')}；订单状态：${Object.entries(preview.statuses).map(([status,n])=>esc(status)+' '+n).join('、')}</small></div><div class="ota-mappings"><h3>核对携程房型对应</h3>${Object.entries(preview.products).map(([product,n],i)=>`<label>${esc(product)}（${n} 笔）<select data-product="${i}" aria-label="${esc(product)} 对应房型"><option value="">请选择</option>${kinds.map(kind=>`<option value="${kind}" ${suggested(product)===kind?'selected':''}>${kind}</option>`).join('')}</select></label>`).join('')}</div><label class="ota-confirm"><input type="checkbox" id="otaMappingConfirmed"> 我已核对房型对应与导出范围</label><button id="otaCommit" class="ota-primary">导入并自动分房</button><p class="batch-note">按订单全部住宿晚数分房，离店当天不占房。已有未关联手工记录或整段日期撞房时，会提示你核对。每晚默认：标准 196.24、大床 178.64、舒适观景 266.64、高级观景 284.24 元；总房费自动乘晚数，付款状态仍需确认。</p>`;
        const products=Object.keys(preview.products);
        get('#otaCommit').addEventListener('click',()=>{
          const mapping=Object.fromEntries([...get('#otaImportPreview').querySelectorAll('[data-product]')].map(el=>[products[Number(el.dataset.product)],el.value]));
          if(!get('#otaMappingConfirmed').checked||Object.values(mapping).some(value=>!value)){message('请先逐项核对房型，并勾选确认');return;}
          change('ota-import',{file:base64,mapping},()=>{const result=state.otaLastImportResult||{};showToast(`订单 ${result.orders||preview.count} 笔，自动分房 ${result.assigned||0} 间，待核对 ${result.skipped||0} 间`);openOrders();});
        });
      }catch(error){get('#otaImportPreview').textContent='';message(error.message);}
    });
  }
  function openManualOrder(order=null){
    const previous=Boolean(order),start=order?.start||state.today,end=order?.end||addDays(state.today,1);
    open(head(previous?'编辑美团未来订单':'添加美团未来订单')+`<form id="otaManualForm" class="modal-body ota-manual-form"><p class="batch-note">按房型、日期和间数占用未来房量。订单号用于避免重复登记；付款和房费到分房时再核对。</p><label>美团订单号<input name="orderId" value="${esc(previous?order.id.slice(8):'')}" maxlength="80" required ${previous?'readonly':''} placeholder="填写美团订单号"></label><label>房型<select name="kind">${kinds.map(kind=>`<option ${order?.kind===kind?'selected':''}>${kind}</option>`).join('')}</select></label><div class="ota-manual-dates"><label>入住日期<input name="start" type="date" min="${start<state.today?start:state.today}" value="${start}" required></label><label>离店日期<input name="end" type="date" value="${end}" required></label></div><label>房间数<input name="quantity" type="number" min="1" max="13" step="1" value="${order?.quantity||1}" required></label><label>订单状态<select name="status"><option ${order?.status!=='已取消'?'selected':''}>已接单</option><option ${order?.status==='已取消'?'selected':''}>已取消</option></select></label><div id="otaError" class="error hidden"></div><button type="submit" class="ota-primary">${previous?'保存修改':'保存美团订单'}</button><button type="button" id="backToOtaOrders" class="ota-back">返回订单列表</button></form>`);
    get('#backToOtaOrders').addEventListener('click',openOrders);
    get('#otaManualForm').addEventListener('submit',event=>{event.preventDefault();const values=Object.fromEntries(new FormData(event.target));values.quantity=Number(values.quantity);if(values.end<=values.start)return message('离店日期应晚于入住日期');change('ota-manual',values,()=>{showToast('美团预订已更新房量');openOrders();});});
  }
  function openOrders(initial=''){
    const orders=(state.otaOrders||[]).filter(o=>o.end>state.today).sort((a,b)=>a.start.localeCompare(b.start)||a.id.localeCompare(b.id));
    open(head('待入住平台订单')+`<div class="modal-body"><p class="batch-note">携程导入与手工美团订单都按房型占用未来房量。若此前已登记房号，请关联原记录，避免重复占房。</p><button id="addMeituanOrder" class="ota-primary">添加美团未来订单</button><div id="otaError" class="error hidden"></div><label class="ota-search">查找订单 <input id="otaSearch" placeholder="日期、房型、网站或订单号"></label><div id="otaOrderList"></div></div>`);
    get('#addMeituanOrder').addEventListener('click',()=>openManualOrder());
    get('#otaSearch').value=typeof initial==='string'?initial:'';
    get('#otaSearch').placeholder='姓名、日期、房型或订单号';
    const list=()=>{const query=get('#otaSearch').value.trim().toLowerCase(),matches=orders.filter(o=>[o.id,o.start,o.end,o.kind,o.site,o.product,o.guest].some(v=>String(v||'').toLowerCase().includes(query)));
      get('#otaOrderList').innerHTML=matches.map(o=>`<button class="ota-order-row" data-order="${esc(o.id)}"><strong>${esc(o.guest||'姓名待核对')} · ${esc(o.kind)}</strong><span>${esc(o.start)} → ${esc(o.end)} · ${dayCount(o.start,o.end)} 晚</span><span>${esc(o.site)} · 本机保留 ${quantity(o)} / 原单 ${o.quantity} 间 · ${esc(o.status)}${o.manualIgnored?' · 人工停计':''}</span><small>订单尾号 ${esc(shortId(o.id))} · 已分房 ${linked(o).length} 间${o.assignmentIssue?' · 需核对':''}</small></button>`).join('')||'<p class="empty-records">没有匹配的导入订单</p>';
      get('#otaOrderList').querySelectorAll('[data-order]').forEach(button=>button.addEventListener('click',()=>openOrder(button.dataset.order)));
    };get('#otaSearch').addEventListener('input',list);list();
  }
  function openOrder(id){
    const order=state.otaOrders.find(o=>o.id===id);if(!order)return openOrders();
    const connected=linked(order),channel=order.site==='美团'?'美团':'携程',candidates=state.bookings.filter(b=>!b.deletedAt&&b.status!=='已取消'&&b.channel===channel&&state.rooms[order.kind].includes(b.room)&&b.start===order.start&&b.end===order.end&&!b.otaOrderId);
    const allConnected=state.bookings.filter(b=>b.otaOrderId===id&&!b.deletedAt&&b.status!=='已取消');
    open(head(`${esc(order.guest||order.kind)} · ${esc(order.site)}`)+`<div class="modal-body">
      <p class="batch-note">${esc(order.start)} 入住 → ${esc(order.end)} 离店 · ${dayCount(order.start,order.end)} 晚 · ${esc(order.kind)} · 订单尾号 ${esc(shortId(id))}</p>
      <p class="batch-note">本机保留 ${quantity(order)} / 原订单 ${order.quantity} 间。房费按默认每晚价格填写，付款状态请自行核对。</p>
      ${order.assignmentIssue?`<p class="error">${esc(order.assignmentIssue)}</p>`:''}<div id="otaError" class="error hidden"></div>
      ${active(order)?`<form id="otaQuantityForm" class="ota-link-form"><label>保留几间 <input id="otaKeepQuantity" type="number" min="0" max="${order.quantity}" step="1" value="${quantity(order)}" required></label><button type="submit">保存间数</button><button type="button" id="otaAssign">补全分房</button></form><p class="batch-note">全取消填 0；部分取消填剩余间数。会同步取消多出的未入住预订，旧表重复导入不会恢复；误取消可在这里改回。</p>`:''}
      <h3 class="ota-subtitle">已分房 ${connected.length} / ${quantity(order)} 间</h3>
      ${allConnected.map(b=>`<div class="ota-linked"><span>${esc(b.room)} · ${esc(b.notes)}<small>${esc(b.start)} → ${esc(b.end)}</small></span><button data-ota-edit="${b.id}">编辑</button>${b.status==='预订'?`<button data-ota-move="${b.id}">换房</button><button data-ota-cancel="${b.id}">取消这间</button>`:''}<button data-unlink="${b.id}">解除关联</button></div>`).join('')||'<p class="batch-note">尚未分配具体房号</p>'}
      ${active(order)&&connected.length<quantity(order)?`<h3 class="ota-subtitle">关联以前手工登记的房号</h3><div class="ota-link-form"><select id="otaCandidate" aria-label="选择已登记房号"><option value="">选择匹配的房号</option>${candidates.map(b=>`<option value="${b.id}">${esc(b.room)} · 记录 #${b.id}</option>`).join('')}</select><button id="otaLink">关联</button></div>`:''}
      <p class="batch-note">这里只更正本机房量，不会替你取消平台订单或退款。已入住的房间不会被导入操作自动取消。</p>
      <button id="otaIgnore" class="ota-back">${order.manualIgnored?'恢复计入房量':'人工确认不计房量'}</button><button id="backToOtaOrders" class="ota-back">返回订单列表</button></div>`);
    get('#backToOtaOrders').addEventListener('click',openOrders);
    if(order.manual){get('#otaIgnore').hidden=true;get('#modalContent').querySelector('.modal-body>.batch-note:nth-child(2)').textContent='美团手工预订。修改状态为“已取消”可释放本机房量；平台订单仍须在美团后台处理。';get('#backToOtaOrders').insertAdjacentHTML('beforebegin','<button id="editMeituanOrder" class="ota-back">编辑这笔美团预订</button>');get('#editMeituanOrder').addEventListener('click',()=>openManualOrder(order));}
    get('#otaIgnore').addEventListener('click',()=>{const ignored=!order.manualIgnored;if(confirm(ignored?'已在平台核实这笔订单不再占房吗？此操作只修改本机房量，不会取消平台订单。':'确认恢复计入这笔订单的房量吗？'))change('ota-ignore',{orderId:id,ignored},()=>openOrder(id));});
    get('#otaLink')?.addEventListener('click',()=>{const bid=Number(get('#otaCandidate').value);if(!bid)return message('请先选择一个房号');change('ota-link',{bookingId:bid,orderId:id},()=>openOrder(id));});
    get('#otaQuantityForm')?.addEventListener('submit',event=>{event.preventDefault();const keep=Number(get('#otaKeepQuantity').value);if(confirm(`这笔订单本机保留 ${keep} 间，多出的未入住预订将取消。已收款和平台退款请自行核对。确认？`))change('ota-quantity',{orderId:id,quantity:keep},()=>openOrder(id));});
    get('#otaAssign')?.addEventListener('click',()=>change('ota-assign',{orderId:id},()=>openOrder(id)));
    get('#modalContent').querySelectorAll('[data-ota-edit]').forEach(button=>button.addEventListener('click',()=>openEdit(Number(button.dataset.otaEdit))));
    get('#modalContent').querySelectorAll('[data-ota-move]').forEach(button=>button.addEventListener('click',()=>openMove(Number(button.dataset.otaMove))));
    get('#modalContent').querySelectorAll('[data-ota-cancel]').forEach(button=>button.addEventListener('click',()=>{if(confirm('取消这间预订并同步释放平台订单在本机占用的房量？不会执行平台取消或退款。'))change('quick-cancel',{bookingId:Number(button.dataset.otaCancel)},()=>openOrder(id));}));
    get('#modalContent').querySelectorAll('[data-unlink]').forEach(button=>button.addEventListener('click',()=>{if(confirm('解除关联会保留房号记录，并让平台订单重新待分房。若是取消，请用“取消这间”。确认解除？'))change('ota-link',{bookingId:Number(button.dataset.unlink),orderId:''},()=>openOrder(id));}));
  }
  function decorateCheckin(room,date,kind){
    const orders=(state.otaOrders||[]).filter(o=>active(o)&&o.kind===kind&&o.start===date&&linked(o).length<quantity(o));
    if(!orders.length)return;
    const field=document.createElement('label');field.className='ota-checkin-field';field.textContent='对应导入订单（如有）';
    const select=document.createElement('select');select.name='otaOrderId';select.setAttribute('aria-label','对应导入订单');
    select.innerHTML=`<option value="">新登记，非导入订单</option>${orders.map(o=>`<option value="${esc(o.id)}">${esc(o.site)} · ${esc(o.kind)} · ${esc(o.start)} 起 ${(dayCount(o.start,o.end))} 晚 · 尾号 ${esc(shortId(o.id))}</option>`).join('')}`;
    field.append(select);get('#checkinForm .amount-label').before(field);
    select.addEventListener('change',()=>{const order=orders.find(o=>o.id===select.value);if(!order)return;get(`#checkinForm [name=channel][value="${order.site==='美团'?'美团':'携程'}"]`).checked=true;get('#checkinForm [name=paymentStatus]').value='未付';const nights=dayCount(order.start,order.end),nightsSelect=get('#checkinForm [name=nights]');if(![...nightsSelect.options].some(option=>option.value===String(nights))){const option=new Option(`${nights} 晚（平台订单）`,String(nights));nightsSelect.add(option);}nightsSelect.value=String(nights);nightsSelect.dispatchEvent(new Event('change'));get('#paidAmount').value=((state.defaultRates[kind]||0)*nights/100).toFixed(2);if(!get('#bookingNotes').value)get('#bookingNotes').value=order.guest||'';});
  }
  get('#otaImportButton').addEventListener('click',openImport);
  get('#otaOrdersButton').addEventListener('click',openOrders);
  get('#allAlertsButton').addEventListener('click',openAlerts);
  get('#closurePreview').addEventListener('click',event=>{if(event.target.closest('[data-alert-open]'))openAlerts();});
  window.KashoOta={render:renderAlerts,decorateCheckin};
})();
