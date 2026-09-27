const {chromium}=require(process.argv[2]||'playwright');
const assert=require('node:assert/strict');
const path=require('node:path');
(async()=>{
  const browser=await chromium.launch({executablePath:'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',headless:true});
  try{
    const page=await browser.newPage({viewport:{width:1280,height:950}});
    const errors=[];page.on('pageerror',e=>errors.push(e.message));page.on('dialog',d=>d.accept());
    const base='http://127.0.0.1:8766';
    let state=await (await page.request.get(base+'/api/state')).json();
    assert.equal(state.bookings.length,0);
    const offset=n=>{const d=new Date(state.today+'T12:00:00');d.setDate(d.getDate()+n);return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;};
    async function post(action,data){const r=await page.request.post(base+'/api/'+action,{headers:{'X-Kasho-Request':'frontdesk'},data:{revision:state.revision,...data}});state=await r.json();assert.equal(r.ok(),true,JSON.stringify(state));return state;}
    await post('quick-in',{room:'8306',channel:'携程',amount:'100'});
    await post('quick-edit',{bookingId:1,date:offset(-1)});
    await post('quick-in',{room:'8308',channel:'携程',amount:'600',nights:3});
    await post('quick-edit',{bookingId:2,date:offset(-1)});
    await post('quick-in',{room:'8306',channel:'美团',amount:'180'});
    await post('quick-in',{room:'8801',channel:'携程',amount:'300'});
    await page.goto(base);await page.locator('.room').first().waitFor();
    assert.equal(await page.locator('#onlineTotal').innerText(),'¥680.00');
    assert.equal(await page.locator('[data-room="8306"] small').innerText(),'¥180.00');
    async function closed(){await page.locator('dialog').waitFor({state:'hidden'});}
    async function records(){await page.locator('#recordsButton').click();}
    async function choose(ids){for(const id of ids)await page.locator(`[data-select-record="${id}"]`).check();}
    async function batch(changes){
      await page.locator('#batchEdit').click();
      for(const [key,value] of Object.entries(changes)){
        await page.locator(`[data-apply="${key}"]`).check();
        const control=page.locator(`#batchForm [name="${key}"]`);
        if(['channel','nights','status'].includes(key))await control.selectOption(String(value));else await control.fill(value);
      }
      await page.getByRole('button',{name:'保存批量修改',exact:true}).click();
    }
    await records();await choose([3,4]);await batch({channel:'线下'});await closed();
    assert.equal(await page.locator('#onlineTotal').innerText(),'¥200.00');assert.equal(await page.locator('#offlineTotal').innerText(),'¥480.00');
    await records();await choose([3,4]);await batch({amount:'90'});await closed();
    assert.equal(await page.locator('#offlineTotal').innerText(),'¥180.00');
    await records();await choose([3,4]);await page.screenshot({path:path.join(__dirname,'../test-artifacts/batch-records.png')});
    await page.locator('#batchEdit').click();
    await page.getByRole('button',{name:'保存批量修改',exact:true}).click();assert.match(await page.locator('#formError').innerText(),/至少一项/);
    for(const [key,val] of Object.entries({date:offset(1),nights:'2',status:'预订'})){
      await page.locator(`[data-apply="${key}"]`).check();const control=page.locator(`#batchForm [name="${key}"]`);
      if(key==='date')await control.fill(val);else await control.selectOption(val);
    }
    await page.screenshot({path:path.join(__dirname,'../test-artifacts/batch-edit.png')});
    await page.getByRole('button',{name:'保存批量修改',exact:true}).click();await closed();
    assert.equal(await page.locator('#offlineTotal').innerText(),'¥0.00');assert.equal(await page.locator('#freeCount').innerText(),'12');
    await page.locator('#datePicker button').nth(1).click();assert.equal(await page.locator('#offlineTotal').innerText(),'¥90.00');
    await records();await choose([3,4]);await page.locator('#batchDelete').click();await closed();
    assert.equal(await page.locator('#offlineTotal').innerText(),'¥0.00');assert.equal(await page.locator('#freeCount').innerText(),'12');
    await records();await page.getByLabel('已删除',{exact:true}).check();await page.locator('#selectPage').check();
    assert.equal(await page.locator('#selectionCount').innerText(),'已选 2 条');await page.locator('#batchRestore').click();await closed();
    assert.equal(await page.locator('#offlineTotal').innerText(),'¥90.00');
    await records();await choose([1,3]);await batch({date:offset(0),status:'在住'});
    await page.locator('#formError:not(.hidden)').waitFor();assert.match(await page.locator('#formError').innerText(),/冲突/);
    await page.getByRole('button',{name:'关闭',exact:true}).click();
    await records();await choose([1]);await page.getByLabel('搜索记录').fill('8801');
    assert.equal(await page.locator('#selectionCount').innerText(),'已选 0 条');
    await page.locator('#selectPage').check();assert.equal(await page.locator('#selectionCount').innerText(),'已选 1 条');
    await page.setViewportSize({width:390,height:844});
    assert.equal(await page.locator('dialog').evaluate(e=>e.scrollWidth<=e.clientWidth),true);
    await page.screenshot({path:path.join(__dirname,'../test-artifacts/batch-mobile.png')});
    await page.getByRole('button',{name:'关闭',exact:true}).click();
    await page.reload();await page.locator('.room').first().waitFor();assert.equal(await page.locator('#onlineTotal').innerText(),'¥200.00');
    // Simulate a window remaining open across midnight, without changing system time or production data.
    const rollover=await browser.newPage();let date='2026-09-14';
    await rollover.route('**/api/state',route=>route.fulfill({json:{...state,today:date,bookings:[
      {...state.bookings[0],id:1,start:'2026-09-14',end:'2026-09-15',channel:'携程',guestPaid:10000,status:'在住'},
      {...state.bookings[1],id:2,start:'2026-09-14',end:'2026-09-17',channel:'携程',guestPaid:60000,status:'在住'}]}}));
    await rollover.goto(base);await rollover.locator('.room').first().waitFor();
    assert.equal(await rollover.locator('#freeCount').innerText(),'11');assert.equal(await rollover.locator('#onlineTotal').innerText(),'¥300.00');
    date='2026-09-15';await rollover.evaluate(()=>refresh());
    assert.equal(await rollover.locator('#freeCount').innerText(),'12');assert.equal(await rollover.locator('#onlineTotal').innerText(),'¥200.00');
    assert.equal(await rollover.locator('[data-room="8306"]').getAttribute('aria-label'),'8306 空房');
    assert.deepEqual(errors,[]);
    console.log('PASS: Sept 14 to 15 rollover, one-night released/multi-night retained, old record preserved; multi-select edit/delete/restore; unchanged fields and totals; atomic conflict rejection; selection reset; reload; mobile.');
  }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
