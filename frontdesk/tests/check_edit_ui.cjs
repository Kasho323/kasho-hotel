const {chromium}=require(process.argv[2]||'playwright');
const assert=require('node:assert/strict');
const path=require('node:path');
(async()=>{
  const browser=await chromium.launch({executablePath:'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',headless:true});
  try{
    const page=await browser.newPage({viewport:{width:1280,height:900}});
    const errors=[];page.on('pageerror',e=>errors.push(e.message));page.on('dialog',d=>d.accept());
    await page.goto('http://127.0.0.1:8766');await page.locator('.room').first().waitFor();
    assert.equal(await page.locator('#freeCount').innerText(),'13');
    async function closed(){await page.locator('dialog').waitFor({state:'hidden'});}
    async function editRoom(room){await page.locator(`[data-room="${room}"]`).click();await page.locator('#editBooking').click();}
    async function submitEdit(){await page.getByRole('button',{name:'保存修改',exact:true}).click();await closed();}
    async function records(){await page.locator('#recordsButton').click();}
    await page.locator('[data-room="8306"]').click();
    await page.locator('dialog').getByText('携程',{exact:true}).click();
    await page.getByLabel('房费金额（整单）',{exact:true}).fill('600');
    await page.getByLabel('住几晚').selectOption('3');
    await page.locator('#checkinForm button[type=submit]').click();await closed();
    await editRoom('8306');
    await page.getByLabel('房费金额（整单）').fill('300.01');
    await page.locator('dialog').getByText('线下',{exact:true}).click();
    await page.screenshot({path:path.join(__dirname,'../test-artifacts/edit-dialog.png')});
    await submitEdit();
    assert.equal(await page.locator('#onlineTotal').innerText(),'¥0.00');
    assert.equal(await page.locator('#offlineTotal').innerText(),'¥100.01');
    await page.locator('#datePicker button').nth(1).click();
    assert.equal(await page.locator('#offlineTotal').innerText(),'¥100.00');
    await page.locator('#datePicker button').first().click();
    await editRoom('8306');await page.getByLabel('房号',{exact:true}).selectOption('8801');await submitEdit();
    assert.equal(await page.locator('[data-room="8306"]').getAttribute('aria-label'),'8306 空房');
    await editRoom('8801');await page.locator('#deleteBooking').click();await closed();
    assert.equal(await page.locator('#freeCount').innerText(),'13');assert.equal(await page.locator('#dailyTotal').innerText(),'¥0.00');
    await records();await page.getByLabel('已删除',{exact:true}).check();
    assert.equal(await page.locator('.record-row').count(),1);
    await page.getByRole('button',{name:'恢复',exact:true}).click();await closed();
    assert.equal(await page.locator('#freeCount').innerText(),'12');
    assert.equal(await page.locator('#offlineTotal').innerText(),'¥100.01');
    await page.locator('[data-room="8801"]').click();await page.locator('#checkout').click();await closed();
    await records();await page.locator('.record-row button').click();
    await page.getByLabel('房费金额（整单）').fill('180');await submitEdit();
    assert.equal(await page.locator('#freeCount').innerText(),'13');assert.equal(await page.locator('#offlineTotal').innerText(),'¥0.00');
    await page.locator('#moneyDetails').click();assert.match(await page.locator('.status-breakdown').innerText(),/180.00/);await page.getByRole('button',{name:'关闭',exact:true}).click();
    await records();await page.locator('.record-row button').click();
    await page.getByLabel('状态',{exact:true}).selectOption('在住');await submitEdit();
    assert.equal(await page.locator('#freeCount').innerText(),'12');
    await editRoom('8801');
    const state=await (await page.request.get('http://127.0.0.1:8766/api/state')).json();
    const tomorrow=new Date(state.today+'T12:00:00');tomorrow.setDate(tomorrow.getDate()+1);
    const next=`${tomorrow.getFullYear()}-${String(tomorrow.getMonth()+1).padStart(2,'0')}-${String(tomorrow.getDate()).padStart(2,'0')}`;
    await page.getByLabel('入住日期',{exact:true}).fill(next);await page.getByLabel('状态',{exact:true}).selectOption('预订');await submitEdit();
    assert.equal(await page.locator('#freeCount').innerText(),'13');assert.equal(await page.locator('#dailyTotal').innerText(),'¥0.00');
    await page.locator('#datePicker button').nth(1).click();assert.equal(await page.locator('#dailyTotal').innerText(),'¥180.00');
    await page.reload();await page.locator('.room').first().waitFor();
    await records();await page.getByLabel('搜索记录').fill('8801');assert.equal(await page.locator('.record-row').count(),1);
    await page.screenshot({path:path.join(__dirname,'../test-artifacts/edit-records.png')});
    await page.locator('.record-row button').click();await page.setViewportSize({width:390,height:844});
    assert.equal(await page.locator('dialog').evaluate(e=>e.scrollWidth<=e.clientWidth),true);
    await page.screenshot({path:path.join(__dirname,'../test-artifacts/edit-mobile.png')});
    assert.deepEqual(errors,[]);
    console.log('PASS: edit money/channel/room/dates/status; exact daily totals; delete/restore; historical checkout editing; undo checkout; persistence; mobile layout.');
  }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
