const { chromium } = require(process.argv[2] || 'playwright');
const assert = require('node:assert/strict');
const path = require('node:path');

(async () => {
  const browser = await chromium.launch({
    executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    headless: true,
  });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto('http://127.0.0.1:8766');
    await page.locator('#freeCount').filter({ hasText: '13' }).waitFor();
    assert.equal(await page.locator('.room').count(), 13);
    assert.equal(await page.locator('.room-group').count(), 4);
    await page.getByRole('button', { name: '8801 空房', exact: true }).click();
    assert.equal(await page.locator('dialog input[type=radio]').count(), 3);
    assert.equal(await page.locator('dialog input[type=number]').count(), 1);
    assert.equal(await page.locator('dialog input[type=date]').count(), 0);
    await page.getByText('携程', { exact: true }).click();
    await page.getByLabel('房费金额（整单）').fill('268.50');
    await page.getByRole('button', { name: '确认入住', exact: true }).click();
    await page.locator('dialog').waitFor({ state: 'hidden' });
    assert.equal(await page.locator('#freeCount').innerText(), '12');
    const group = page.locator('.room-group').filter({ has: page.getByRole('heading', { name: '高级观景', exact: true }) });
    assert.match(await group.innerText(), /暂无空房/);
    assert.match(await group.innerText(), /268.5/);
    await page.reload();
    await page.getByRole('button', { name: '8801 携程 已占用', exact: true }).waitFor();
    await page.getByRole('button', { name: '8801 携程 已占用', exact: true }).click();
    await page.getByRole('button', { name: '确认退房', exact: true }).click();
    await page.locator('dialog').waitFor({ state: 'hidden' });
    assert.equal(await page.locator('#freeCount').innerText(), '13');
    await page.getByRole('button', { name: '8801 空房', exact: true }).waitFor();
    assert.equal(errors.length, 0, errors.join('\n'));
    // Production page is inspected read-only; test records stay on port 8766.
    await page.goto('http://127.0.0.1:8765');
    await page.locator('.room').first().waitFor();
    await page.screenshot({ path: path.join(__dirname, '../test-artifacts/simple-home.png'), fullPage: true });
    await page.getByRole('button', { name: '8302 空房', exact: true }).click();
    await page.screenshot({ path: path.join(__dirname, '../test-artifacts/simple-dialog.png') });
    console.log('PASS: 13 rooms, 4 types, only 3 sources + 1 amount, check-in updates free counts, reload persists, same-day checkout restores room.');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
