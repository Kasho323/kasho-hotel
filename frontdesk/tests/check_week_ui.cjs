const { chromium }=require(process.argv[2]||'playwright');
const assert=require('node:assert/strict');
const path=require('node:path');
(async()=>{
  const browser=await chromium.launch({executablePath:'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',headless:true});
  try{
    const page=await browser.newPage({viewport:{width:1280,height:900}});
    const errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.goto('http://127.0.0.1:8766');
    await page.locator('#datePicker button').first().waitFor();
    assert.equal(await page.locator('#datePicker button').count(),7);
    assert.equal(await page.locator('#dailyTotal').innerText(),'¥0.00');
    async function book(room,channel,paid,nights){
      await page.getByRole('button',{name:room+' 空房',exact:true}).click();
      await page.locator('dialog').getByText(channel,{exact:true}).click();
      await page.getByLabel('住几晚').selectOption(String(nights));
      await page.getByLabel('房费金额（整单）').fill(paid);
      await page.locator('#checkinForm button[type=submit]').click();
      await page.locator('dialog').waitFor({state:'hidden'});
    }
    await book('8306','携程','600',3);
    await book('8308','美团','300',3);
    await book('8302','线下','150',3);
    assert.equal(await page.locator('#onlineTotal').innerText(),'¥300.00');
    assert.equal(await page.locator('#offlineTotal').innerText(),'¥50.00');
    assert.equal(await page.locator('#dailyTotal').innerText(),'¥350.00');
    assert.equal(await page.locator('#freeCount').innerText(),'10');
    await page.locator('#datePicker button').nth(1).click();
    assert.equal(await page.locator('#onlineTotal').innerText(),'¥300.00');
    await book('8801','美团','210',1);
    assert.equal(await page.locator('#onlineTotal').innerText(),'¥510.00');
    assert.equal(await page.locator('#offlineTotal').innerText(),'¥50.00');
    assert.equal(await page.locator('#dailyTotal').innerText(),'¥560.00');
    await page.locator('#datePicker button').nth(3).click();
    assert.equal(await page.locator('#freeCount').innerText(),'13');
    assert.equal(await page.locator('#dailyTotal').innerText(),'¥0.00');
    await page.locator('#datePicker button').first().click();
    await book('8802','线下','80',1);
    const before=await page.locator('#dailyTotal').innerText();
    await page.getByRole('button',{name:'8802 线下 已占用',exact:true}).click();
    await page.getByRole('button',{name:'确认退房',exact:true}).click();
    await page.locator('dialog').waitFor({state:'hidden'});
    assert.equal(await page.locator('#dailyTotal').innerText(),'¥350.00','checkout moves amount out of visible room totals');
    await page.locator('#moneyDetails').click();assert.match(await page.locator('.status-breakdown').innerText(),/80.00/);await page.getByRole('button',{name:'关闭',exact:true}).click();
    await page.reload();await page.locator('.room').first().waitFor();
    assert.equal(await page.locator('#onlineTotal').innerText(),'¥300.00');
    assert.equal(await page.locator('#offlineTotal').innerText(),'¥50.00');
    assert.deepEqual(errors,[]);
    await page.screenshot({path:path.join(__dirname,'../test-artifacts/week-split-test.png'),fullPage:true});
    console.log('PASS: 7 dates, multi-night availability, future booking, online=Ctrip+Meituan, separate offline totals, nightly allocation, checkout keeps history separately, reload persistence.');
  }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
