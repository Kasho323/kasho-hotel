const {chromium}=require(process.argv[2]||'playwright');
const assert=require('node:assert/strict');
const path=require('node:path');
(async()=>{
  const browser=await chromium.launch({executablePath:'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',headless:true});
  try{
    const page=await browser.newPage({viewport:{width:1280,height:900}});
    const errors=[];page.on('pageerror',e=>errors.push(e.message));page.on('dialog',d=>d.accept());
    const base='http://127.0.0.1:8766';await page.goto(base);await page.locator('.room').first().waitFor();
    assert.equal(await page.locator('#freeCount').innerText(),'13');
    async function closed(){await page.locator('dialog').waitFor({state:'hidden'});}
    async function recordEdit(){await page.locator('#recordsButton').click();await page.locator('.record-row button').click();}
    async function save(){await page.getByRole('button',{name:'保存修改',exact:true}).click();await closed();}
    await page.locator('[data-room="8306"]').click();
    await page.locator('dialog').getByText('携程',{exact:true}).click();await page.getByLabel('房费金额（整单）',{exact:true}).fill('288');
    await page.getByLabel('备注（选填）',{exact:true}).fill('今晚较晚到店\n加一床被子');
    await page.screenshot({path:path.join(__dirname,'../test-artifacts/notes-create.png')});
    await page.locator('#checkinForm button[type=submit]').click();await closed();
    assert.equal(await page.locator('[data-room="8306"] .note-indicator').innerText(),'有备注');
    assert.equal(await page.locator('#onlineTotal').innerText(),'¥288.00');
    await page.reload();await page.locator('[data-room="8306"]').click();
    assert.equal(await page.locator('.stay-notes p').innerText(),'今晚较晚到店\n加一床被子');
    await page.screenshot({path:path.join(__dirname,'../test-artifacts/notes-detail.png')});
    await page.locator('#editBooking').click();
    assert.equal(await page.getByLabel('备注（选填）',{exact:true}).inputValue(),'今晚较晚到店\n加一床被子');
    const hostile='明早叫醒\n<img src=x onerror="window.noteInjected=true">\n</textarea><script>window.noteInjected=true</script>';
    await page.getByLabel('备注（选填）',{exact:true}).fill(hostile);await save();
    await page.locator('[data-room="8306"]').click();assert.equal(await page.locator('.stay-notes p').innerText(),hostile);
    assert.equal(await page.locator('.stay-notes img,.stay-notes script').count(),0);assert.equal(await page.evaluate(()=>window.noteInjected),undefined);
    await page.getByRole('button',{name:'关闭',exact:true}).click();await page.locator('#recordsButton').click();
    await page.getByLabel('搜索记录').fill('明早叫醒');assert.equal(await page.locator('.record-row').count(),1);
    await page.locator('.record-row button').click();assert.equal(await page.getByLabel('备注（选填）',{exact:true}).inputValue(),hostile);
    await page.getByLabel('备注（选填）',{exact:true}).fill('明早叫醒；加一床被子');await save();
    await page.locator('[data-room="8306"]').click();await page.locator('#checkout').click();await closed();
    await recordEdit();assert.equal(await page.getByLabel('备注（选填）',{exact:true}).inputValue(),'明早叫醒；加一床被子');
    await page.getByLabel('备注（选填）',{exact:true}).fill('退房时已取回充电器');await save();
    assert.equal(await page.locator('#onlineTotal').innerText(),'¥0.00');assert.equal(await page.locator('#freeCount').innerText(),'13');
    await page.locator('#moneyDetails').click();assert.match(await page.locator('.status-breakdown').innerText(),/288.00/);await page.getByRole('button',{name:'关闭',exact:true}).click();
    await recordEdit();await page.setViewportSize({width:390,height:844});
    assert.equal(await page.locator('dialog').evaluate(e=>e.scrollWidth<=e.clientWidth),true);
    await page.screenshot({path:path.join(__dirname,'../test-artifacts/notes-mobile.png')});
    await page.getByLabel('备注（选填）',{exact:true}).fill('');await save();
    await page.locator('#recordsButton').click();assert.equal(await page.locator('.record-note').count(),0);
    const backup=await (await page.request.get(base+'/api/backup')).json();assert.equal(backup.bookings[0].notes,'');
    assert.deepEqual(errors,[]);
    console.log('PASS: optional note create/display/edit/search/clear; reload and checked-out history; no amount or availability change; escaped HTML; mobile layout.');
  }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
