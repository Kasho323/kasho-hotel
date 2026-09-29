const {chromium}=require(process.argv[2]||'playwright');
const assert=require('node:assert/strict');
(async()=>{
  const browser=await chromium.launch({executablePath:'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',headless:true});
  try{
    const page=await browser.newPage({viewport:{width:1280,height:900}}),errors=[];
    page.on('pageerror',error=>errors.push(error.message));
    await page.goto('http://127.0.0.1:8766/');
    await page.locator('.room').first().waitFor();
    await page.locator('#datePicker [data-date]').nth(1).click();
    await page.locator('[data-room="8302"]').click();
    await page.locator('dialog').getByText('携程',{exact:true}).click();
    await page.getByLabel('房费金额（整单）',{exact:true}).fill('388');
    await page.getByLabel('备注（选填）',{exact:true}).fill('张先生');
    await page.getByLabel('住几晚').selectOption('2');
    await page.locator('#checkinForm button[type=submit]').click();
    await page.locator('dialog').waitFor({state:'hidden'});
    assert.equal(await page.locator('[data-room="8302"] .room-note').innerText(),'张先生');
    await page.locator('[data-room="8302"]').click();
    await page.locator('#moveBooking').click();
    assert.equal(await page.locator('[data-move-room]').count(),3);
    await page.locator('[data-move-room="8802"]').click();
    await page.locator('dialog').waitFor({state:'hidden'});
    assert.equal(await page.locator('[data-room="8302"] .room-note').count(),0);
    assert.equal(await page.locator('[data-room="8802"] .room-note').innerText(),'张先生');
    const state=await (await page.request.get('http://127.0.0.1:8766/api/state')).json();
    assert.equal(state.bookings.length,1);
    assert.equal(state.bookings[0].room,'8802');
    assert.equal(state.bookings[0].roomCharge,38800);
    assert.deepEqual(errors,[]);
    console.log('PASS: same-type full-stay move preserves booking and shows note on new room.');
  }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
