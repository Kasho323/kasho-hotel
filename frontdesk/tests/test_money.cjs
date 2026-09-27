const assert=require('node:assert/strict');
const fs=require('node:fs');
const crypto=require('node:crypto');
const M=require('../web/money.js');
function booking(id,room,channel,guestPaid,start='2026-09-20',end='2026-09-21',status='在住'){
  return {id,room,channel,guestPaid,start,end,status,quick:true};
}
function state(bookings){return {rooms:{测试:['8307','8801','8802']},bookings,payments:[]};}
function invariant(s,date){
  const r=M.report(s,date);
  assert.equal(r.display.total,Object.values(r.byRoom).filter(Boolean).reduce((sum,b)=>sum+M.daily(s,b,date),0));
  assert.equal(r.display.total,r.display.online+r.display.offline);
  assert.equal(r.all.total,r.display.total+r.hiddenTotals.total);
  assert.equal(r.all.total,Object.values(r.groups).reduce((sum,t)=>sum+t.total,0));
}
const old=booking(1,'8307','携程',26664);old.status='已退房';old.releasedOn='2026-09-20';
const fresh=booking(2,'8307','线下',19000);
let s=state([old,fresh]);let r=M.report(s,'2026-09-20');
assert.deepEqual(r.display,{online:0,offline:19000,total:19000});
assert.deepEqual(r.all,{online:26664,offline:19000,total:45664});
assert.equal(r.hidden[0].id,1);
for(let cents=0;cents<=1000;cents++)for(let nights=1;nights<=7;nights++){
  const b=booking(1,'8307','携程',cents,'2026-09-20',`2026-09-${20+nights}`);s=state([b]);
  let sum=0;for(let i=0;i<nights;i++){const date=`2026-09-${20+i}`;sum+=M.daily(s,b,date);invariant(s,date);}
  assert.equal(sum,cents);assert.equal(M.daily(s,b,b.end),0);assert.equal(M.report(s,b.end).display.total,0);
}
s=state([booking(1,'8307','携程',60000,'2026-09-20','2026-09-23'),booking(2,'8801','线下',0),booking(3,'8802','线下',20000,undefined,undefined,'预订')]);
assert.equal(M.report(s,'2026-09-20').display.online,20000);assert.equal(M.report(s,'2026-09-20').groups['预订'].offline,20000);
s.bookings[0].deletedAt='2026-09-20T12:00:00';s.bookings[2].status='已取消';invariant(s,'2026-09-20');assert.equal(M.report(s,'2026-09-20').all.total,0);
if(process.argv[2]){
  const file=process.argv[2],bytes=fs.readFileSync(file),before=crypto.createHash('sha256').update(bytes).digest('hex');
  const real=JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/,''));
  real.rooms={标准间:['8302','8802','8806','8808'],大床房:['8306','8308'],高级观景:['8801'],舒适观景:['8303','8305','8307','8803','8805','8807']};
  r=M.report(real,'2026-09-20');
  assert.deepEqual(r.display,{online:124556,offline:86000,total:210556});
  assert.deepEqual(r.all,{online:151220,offline:86000,total:237220});
  assert.deepEqual(r.hidden.map(b=>b.id),[72]);
  assert.equal(r.groups['预订'].offline,40000);assert.equal(r.groups['在住'].offline,46000);
  assert.equal(r.groups['已退房'].online,26664);assert.equal(r.shown.length,9);
  for(let d=15;d<=26;d++)invariant(real,`2026-09-${d}`);
  assert.equal(crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'),before);
  console.log('PASS real backup: display 1245.56 + 860.00 = 2105.56; hidden #72 266.64; offline reserved 400 / in-house 460; source unchanged.');
}
console.log('PASS: 7007 amount/night combinations, cent conservation, room/summary equality, deleted/cancelled/zero/multiple stays, no lost checkout record.');
