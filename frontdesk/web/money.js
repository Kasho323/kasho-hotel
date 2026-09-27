'use strict';
// All amounts remain integer cents until display. Shared by room cards and summaries.
(function(root){
  const days=(a,b)=>Math.round((Date.parse(b+'T12:00:00Z')-Date.parse(a+'T12:00:00Z'))/86400000);
  const paid=(state,b)=>b.quick?b.guestPaid:state.payments.filter(p=>p.bookingId===b.id).reduce((sum,p)=>sum+p.amount,0);
  const charge=(state,b)=>b.roomCharge??paid(state,b);
  const paymentStatus=b=>b.paymentStatus||'已付';
  function daily(state,b,date){
    const count=days(b.start,b.end),index=days(b.start,date),cents=charge(state,b);
    if(b.deletedAt||['已取消','停用'].includes(b.status)||count<1||index<0||index>=count)return 0;
    return Math.floor(cents/count)+(index<cents%count?1:0);
  }
  function visible(b,date){return !b.deletedAt&&!['已取消','已退房'].includes(b.status)&&b.start<=date&&date<b.end&&!(b.releasedOn&&b.releasedOn<=date);}
  function totals(state,rows,date){
    let online=0,offline=0;
    for(const b of rows){const cents=daily(state,b,date);if(b.channel==='线下')offline+=cents;else online+=cents;}
    return {online,offline,total:online+offline};
  }
  function report(state,date){
    const history=Boolean(state.today&&date<state.today);
    const roomRows={};
    const byRoom={};
    for(const room of Object.values(state.rooms).flat()){
      roomRows[room]=history?state.bookings.filter(b=>b.room===room&&!b.deletedAt&&b.status!=='已取消'&&b.start<=date&&date<b.end).sort((a,b)=>b.id-a.id):state.bookings.filter(b=>b.room===room&&visible(b,date)).slice(0,1);
      byRoom[room]=roomRows[room][0]||null;
    }
    const shown=Object.values(roomRows).flat();
    const rows=state.bookings.filter(b=>!b.deletedAt&&!['已取消','停用'].includes(b.status)&&b.start<=date&&date<b.end);
    const ids=new Set(shown.map(b=>b.id));
    const hidden=rows.filter(b=>!ids.has(b.id));
    const settled=totals(state,shown.filter(b=>paymentStatus(b)==='已付'),date),unpaid=totals(state,shown.filter(b=>paymentStatus(b)==='未付'),date);
    return {history,roomRows,byRoom,shown,rows,hidden,settled,unpaid,display:totals(state,shown,date),all:totals(state,rows,date),
      hiddenTotals:totals(state,hidden,date),
      groups:Object.fromEntries(['预订','在住','已退房'].map(status=>[status,totals(state,rows.filter(b=>b.status===status),date)]))};
  }
  function monthReport(state,month){
    if(!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)||month<'0001-01'||month>'9998-12')throw Error('请选择有效月份');
    const start=month+'-01',end=(Number(month.slice(5))===12?String(Number(month.slice(0,4))+1).padStart(4,'0')+'-01':month.slice(0,4)+'-'+String(Number(month.slice(5))+1).padStart(2,'0'))+'-01';
    const dates=Array.from({length:days(start,end)},(_,i)=>month+'-'+String(i+1).padStart(2,'0'));
    const blank=()=>({online:0,offline:0,total:0});
    const summary={stays:blank(),reserved:blank(),all:blank(),settled:blank(),unpaid:blank()};
    const sold=new Set(),reserved=new Set(),rows=[];
    const dailyRows=dates.map(date=>({date,stays:blank(),reserved:blank(),all:blank(),sold:new Set(),reservedRooms:new Set()}));
    function add(total,b,cents){total[b.channel==='线下'?'offline':'online']+=cents;total.total+=cents;}
    for(const b of state.bookings){
      if(b.deletedAt||['已取消','停用'].includes(b.status)||b.start>=end||b.end<=start)continue;
      const kind=b.status==='预订'?'reserved':'stays';let cents=0,nights=0;
      for(const entry of dailyRows){
        if(entry.date<b.start||entry.date>=b.end)continue;
        const value=daily(state,b,entry.date);cents+=value;nights++;
        add(entry[kind],b,value);add(entry.all,b,value);
        if(kind==='reserved'){reserved.add(b.room+'|'+entry.date);entry.reservedRooms.add(b.room);}
        else{sold.add(b.room+'|'+entry.date);entry.sold.add(b.room);}
      }
      add(summary[kind],b,cents);add(summary.all,b,cents);
      add(summary[paymentStatus(b)==='未付'?'unpaid':'settled'],b,cents);
      rows.push({booking:b,cents,nights,kind});
    }
    return {month,start,end,...summary,soldNights:sold.size,reservedNights:reserved.size,rows,
      dates:dailyRows.map(e=>({...e,soldNights:e.sold.size,reservedNights:e.reservedRooms.size,sold:undefined,reservedRooms:undefined}))};
  }
  const api={days,paid,charge,paymentStatus,daily,visible,totals,report,monthReport};
  if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.KashoMoney=api;
})(globalThis);
