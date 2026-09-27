const {chromium}=require(process.argv[2]||'playwright');
const fs=require('node:fs'),assert=require('node:assert/strict'),path=require('node:path');
(async()=>{
  const browser=await chromium.launch({executablePath:'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',headless:true});
  try{
    const page=await browser.newPage({viewport:{width:1280,height:950}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
    const base='http://127.0.0.1:8766';const template=await (await page.request.get(base+'/api/state')).json();
    assert.equal(template.bookings.length,0);
    const real=JSON.parse(fs.readFileSync(process.argv[3],'utf8').replace(/^\uFEFF/,''));
    const fixture={...template,...real,today:'2026-09-20'};
    await page.route('**/api/state',route=>route.fulfill({json:fixture}));
    await page.route('**/api/quick-*',()=>{throw Error('Real backup UI audit must be read-only');});
    await page.goto(base);await page.locator('.room').first().waitFor();
    assert.equal(await page.locator('#freeCount').innerText(),'4');
    assert.equal(await page.locator('#onlineTotal').innerText(),'¥1,245.56');assert.equal(await page.locator('#offlineTotal').innerText(),'¥860.00');
    assert.equal(await page.locator('#dailyTotal').innerText(),'¥2,105.56');
    const sum=await page.locator('[data-cents]').evaluateAll(nodes=>nodes.reduce((n,e)=>n+Number(e.dataset.cents),0));assert.equal(sum,210556);
    assert.match(await page.locator('#moneyScope').innerText(),/266.64/);
    assert.match(await page.locator('[data-room="8802"]').innerText(),/预订/);
    await page.screenshot({path:path.join(__dirname,'../test-artifacts/reconcile-home.png')});
    await page.locator('#moneyDetails').click();assert.equal(await page.locator('[data-money-id]').count(),10);
    assert.match(await page.locator('[data-money-id="72"]').innerText(),/已退房/);assert.match(await page.locator('[data-money-id="72"]').innerText(),/否/);
    const status=await page.locator('.status-breakdown').innerText();assert.match(status,/400.00/);assert.match(status,/460.00/);assert.match(status,/266.64/);
    await page.screenshot({path:path.join(__dirname,'../test-artifacts/reconcile-details.png')});
    await page.locator('[data-money-id="72"] button').click();assert.equal(await page.locator('#editAmount').inputValue(),'266.64');
    await page.getByRole('button',{name:'关闭',exact:true}).click();
    await page.locator('#moneyDetails').click();await page.locator('#moneyDate').fill('2026-09-19');await page.locator('#moneyDate').dispatchEvent('change');
    assert.equal(await page.locator('[data-money-id]').count(),13);
    await page.setViewportSize({width:390,height:844});assert.equal(await page.locator('dialog').evaluate(e=>e.scrollWidth<=e.clientWidth),true);
    await page.getByRole('button',{name:'关闭',exact:true}).click();
    // Use a synthetic multi-night record to check the displayed cents, not just the pure helper.
    fixture.bookings=[{id:1,room:'8306',channel:'携程',status:'在住',quick:true,guestPaid:10001,start:'2026-09-20',end:'2026-09-23'}];fixture.revision++;
    await page.reload();await page.locator('[data-cents]').waitFor();
    assert.equal(await page.locator('[data-room="8306"] [data-cents]').innerText(),'¥33.34');assert.equal(await page.locator('#onlineTotal').innerText(),'¥33.34');
    await page.locator('#datePicker button').nth(2).click();assert.equal(await page.locator('#onlineTotal').innerText(),'¥33.33');
    assert.deepEqual(errors,[]);
    console.log('PASS: real backup reconciles room cards/top/detail, reserved vs in-house, preserved retired #72, historical dates, multi-night cents, mobile; no source writes.');
  }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
