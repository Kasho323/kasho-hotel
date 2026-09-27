const {chromium}=require(process.argv[2]||'playwright');const assert=require('node:assert/strict'),path=require('node:path');
(async()=>{const browser=await chromium.launch({executablePath:'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',headless:true});try{
  const page=await browser.newPage({viewport:{width:1280,height:1100}}),errors=[];page.on('pageerror',e=>errors.push(e.message));page.on('dialog',d=>d.accept());
  const base='http://127.0.0.1:8766';let s=await(await page.request.get(base+'/api/state')).json();assert.equal(s.bookings.length,0);
  const d=new Date(s.today+'T12:00:00');d.setDate(d.getDate()-1);const yesterday=`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  async function post(action,data){const r=await page.request.post(base+'/api/'+action,{headers:{'X-Kasho-Request':'frontdesk'},data:{...data,revision:s.revision}});s=await r.json();assert.equal(r.ok(),true,JSON.stringify(s));}
  await post('quick-in',{room:'8805',channel:'线下',amount:'150'});await post('quick-edit',{bookingId:1,date:yesterday,status:'已退房'});
  await post('quick-in',{room:'8802',channel:'携程',amount:'400',paymentStatus:'未付'});await post('quick-edit',{bookingId:2,status:'预订'});
  await page.goto(base);await page.locator('.room').first().waitFor();
  async function closed(){await page.locator('dialog').waitFor({state:'hidden'});}
  async function book(room,fee,status,nights=1){await page.locator(`[data-room="${room}"]`).click();await page.locator('dialog').getByText('线下',{exact:true}).click();await page.getByLabel('房费金额（整单）',{exact:true}).fill(fee);await page.getByLabel('房费付款状态').selectOption(status);await page.getByLabel('住几晚').selectOption(String(nights));await page.locator('#checkinForm button[type=submit]').click();await closed();}
  await book('8306','200','已付');await book('8308','300','未付',3);
  assert.match(await page.locator('[data-room="8306"]').getAttribute('class'),/paid/);assert.match(await page.locator('[data-room="8308"]').getAttribute('class'),/unpaid/);assert.match(await page.locator('[data-room="8802"]').getAttribute('class'),/reserved/);
  assert.match(await page.locator('#moneyScope').innerText(),/已付 ¥200.00 · 未付 ¥500.00/);assert.equal(await page.locator('#dailyTotal').innerText(),'¥700.00');
  await page.mouse.move(0,0);const colors=await page.locator('[data-room="8306"],[data-room="8308"],[data-room="8802"],[data-room="8303"]').evaluateAll(nodes=>nodes.map(n=>getComputedStyle(n).backgroundColor));assert.equal(new Set(colors).size,4);
  await page.screenshot({path:path.join(__dirname,'../test-artifacts/payment-colors.png'),fullPage:true});
  await page.locator('[data-room="8308"]').click();assert.match(await page.locator('.payment-summary').innerText(),/客人已付 ¥0.00 · 待付 ¥300.00/);await page.locator('#editBooking').click();assert.equal(await page.locator('#editAmount').inputValue(),'300.00');await page.getByLabel('房费付款状态').selectOption('已付');await page.getByRole('button',{name:'保存修改',exact:true}).click();await closed();
  assert.match(await page.locator('[data-room="8308"]').getAttribute('class'),/\bpaid\b/);assert.equal(await page.locator('#dailyTotal').innerText(),'¥700.00');
  await page.locator('[data-room="8802"]').click();await page.locator('#arrive').click();await closed();assert.match(await page.locator('[data-room="8802"]').getAttribute('class'),/unpaid/);
  await page.locator('#yesterdayButton').click();assert.equal(await page.locator('#selectedLabel').innerText(),'昨天');assert.equal(await page.locator('#freeCount').innerText(),'12');assert.equal(await page.locator('#dailyTotal').innerText(),'¥150.00');assert.equal(await page.locator('[data-room="8805"] [data-cents]').innerText(),'¥150.00');
  await page.locator('[data-room="8805"]').click();assert.match(await page.locator('.history-record').innerText(),/已退房/);await page.getByRole('button',{name:'关闭',exact:true}).click();
  await page.locator('[data-room="8303"]').click();assert.equal(await page.locator('#checkinForm').count(),0);assert.match(await page.locator('.empty-records').innerText(),/没有登记/);await page.getByRole('button',{name:'关闭',exact:true}).click();
  await page.screenshot({path:path.join(__dirname,'../test-artifacts/yesterday-view.png'),fullPage:true});
  await page.locator('#datePicker button').first().click();await page.locator('#recordsButton').click();await page.locator('[data-select-record="3"]').check();await page.locator('[data-select-record="4"]').check();await page.locator('#batchEdit').click();await page.locator('[data-apply="paymentStatus"]').check();await page.locator('#batchForm [name="paymentStatus"]').selectOption('未付');await page.getByRole('button',{name:'保存批量修改',exact:true}).click();await closed();
  assert.match(await page.locator('#moneyScope').innerText(),/已付 ¥0.00 · 未付 ¥700.00/);
  await page.locator('#monthlyButton').click();assert.match(await page.locator('.money-table').first().innerText(),/未付/);await page.getByRole('button',{name:'关闭',exact:true}).click();
  await page.reload();await page.locator('.room').first().waitFor();assert.match(await page.locator('[data-room="8306"]').getAttribute('class'),/unpaid/);
  await page.setViewportSize({width:390,height:844});assert.equal(await page.locator('body').evaluate(e=>e.scrollWidth<=window.innerWidth),true);await page.locator('[data-room="8306"]').click();await page.locator('#editBooking').click();assert.equal(await page.locator('dialog').evaluate(e=>e.scrollWidth<=e.clientWidth),true);
  assert.deepEqual(errors,[]);console.log('PASS: yesterday includes checked-out stay, paid green/unpaid red/reserved blue/empty neutral, payment edits and batch, fees remain equal to cards, arrival color, persistence, mobile.');
}finally{await browser.close();}})().catch(e=>{console.error(e);process.exitCode=1;});
