const assert=require('node:assert/strict'),fs=require('node:fs'),crypto=require('node:crypto');
const M=require('../web/money.js');
const b=(id,room,channel,guestPaid,start,end,status='在住')=>({id,room,channel,guestPaid,start,end,status,quick:true});
const s=bookings=>({rooms:{测试:['8306','8307','8801']},bookings,payments:[]});
let state=s([b(1,'8306','携程',10001,'2026-08-31','2026-09-02'),b(2,'8801','美团',60000,'2026-09-20','2026-09-22','预订'),
  {...b(3,'8307','线下',20000,'2026-09-10','2026-09-11','已退房'),releasedOn:'2026-09-10'},b(4,'8307','线下',18000,'2026-09-10','2026-09-11'),
  {...b(5,'8306','携程',90000,'2026-09-01','2026-09-02'),deletedAt:'2026-09-01'},b(6,'8306','线下',50000,'2026-09-01','2026-09-02','已取消'),
  b(7,'8306','线下',0,'2026-09-02','2026-09-03','停用')]);
const before=JSON.stringify(state);let r=M.monthReport(state,'2026-09');
assert.deepEqual(r.stays,{online:5000,offline:38000,total:43000});assert.equal(r.reserved.total,60000);assert.equal(r.all.total,103000);
assert.equal(r.soldNights,2);assert.equal(r.reservedNights,2);assert.equal(r.rows.length,4);assert.equal(r.rows.find(x=>x.booking.id===1).nights,1);
assert.equal(M.monthReport(state,'2026-08').all.total,5001);assert.equal(M.monthReport(state,'2026-10').all.total,0);assert.equal(JSON.stringify(state),before);
state=s([b(1,'8306','携程',100,'2024-02-29','2024-03-03')]);assert.equal(M.monthReport(state,'2024-02').dates.length,29);assert.equal(M.monthReport(state,'2024-02').all.total,34);assert.equal(M.monthReport(state,'2024-03').all.total,66);
state=s([b(1,'8306','线下',101,'2026-12-31','2027-01-02')]);assert.equal(M.monthReport(state,'2026-12').all.total,51);assert.equal(M.monthReport(state,'2027-01').all.total,50);
state=s([b(1,'8306','线下',0,'2026-09-20','2026-09-21')]);assert.equal(M.monthReport(state,'2026-09').soldNights,1);
for(const month of ['2026-00','2026-13','bad','2026-9','0000-01','9999-12'])assert.throws(()=>M.monthReport(state,month));
for(let amount=0;amount<100;amount++)for(let nights=1;nights<=7;nights++){
  state=s([b(1,'8306','携程',amount,'2026-09-30',`2026-10-${String(nights).padStart(2,'0')}`)]);
  assert.equal(M.monthReport(state,'2026-09').all.total+M.monthReport(state,'2026-10').all.total,amount);
}
if(process.argv[2]){
  const file=process.argv[2],data=fs.readFileSync(file),hash=crypto.createHash('sha256').update(data).digest('hex');state=JSON.parse(data.toString('utf8').replace(/^\uFEFF/,''));
  state.rooms={标准间:['8302','8802','8806','8808'],大床房:['8306','8308'],高级观景:['8801'],舒适观景:['8303','8305','8307','8803','8805','8807']};
  r=M.monthReport(state,'2026-09');let sum=0,online=0,offline=0;
  for(const d of r.dates){const day=M.report(state,d.date);sum+=day.all.total;online+=day.all.online;offline+=day.all.offline;assert.equal(day.all.total,d.all.total);}
  assert.deepEqual(r.all,{online,offline,total:sum});assert.equal(r.all.total,r.stays.total+r.reserved.total);
  assert.equal(r.all.total,r.rows.reduce((n,row)=>n+row.cents,0));assert.equal(r.rows.some(row=>row.booking.id===72),true);
  assert.equal(crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'),hash);
  console.log(JSON.stringify({month:r.month,stays:r.stays,reserved:r.reserved,all:r.all,soldNights:r.soldNights,reservedNights:r.reservedNights,records:r.rows.length}));
}
console.log('PASS monthly: cross-month/year/leap-day cent allocation, reservations separate, turnover dedup, deleted/cancelled/maintenance excluded, zero-price night, daily=sum(month), source immutable.');
