const assert=require('node:assert/strict'),M=require('../web/money.js');
const state={today:'2026-09-23',rooms:{测试:['8306','8308']},payments:[],bookings:[
  {id:1,room:'8306',channel:'携程',status:'已退房',quick:true,guestPaid:20000,start:'2026-09-22',end:'2026-09-23',releasedOn:'2026-09-22'},
  {id:2,room:'8306',channel:'线下',status:'已退房',quick:true,guestPaid:0,roomCharge:18000,paymentStatus:'未付',start:'2026-09-22',end:'2026-09-23',releasedOn:'2026-09-23'},
  {id:3,room:'8308',channel:'美团',status:'在住',quick:true,guestPaid:0,roomCharge:60001,paymentStatus:'未付',start:'2026-09-22',end:'2026-09-25'}]};
let r=M.report(state,'2026-09-22');assert.equal(r.history,true);assert.equal(r.roomRows['8306'].length,2);assert.equal(r.byRoom['8306'].id,2);
assert.deepEqual(r.display,{online:40001,offline:18000,total:58001});assert.equal(r.settled.total,20000);assert.equal(r.unpaid.total,38001);assert.equal(r.hidden.length,0);
r=M.report(state,'2026-09-23');assert.equal(r.history,false);assert.equal(r.byRoom['8306'],null);assert.equal(r.display.total,20000);assert.equal(r.settled.total,0);assert.equal(r.unpaid.total,20000);
assert.equal(M.paid(state,state.bookings[2]),0);assert.equal(M.charge(state,state.bookings[2]),60001);
let m=M.monthReport(state,'2026-09');assert.equal(m.all.total,98001);assert.equal(m.settled.total,20000);assert.equal(m.unpaid.total,78001);assert.equal(m.all.total,m.settled.total+m.unpaid.total);
state.bookings[2].paymentStatus='已付';state.bookings[2].guestPaid=60001;r=M.report(state,'2026-09-23');assert.equal(r.display.total,20000);assert.equal(r.unpaid.total,0);assert.equal(r.settled.total,20000);
assert.equal(M.paymentStatus(state.bookings[0]),'已付');
console.log('PASS: yesterday includes departed stays and same-room turnover, fees/payment separate, month unpaid split, old data defaults, payment toggle preserves fees.');
