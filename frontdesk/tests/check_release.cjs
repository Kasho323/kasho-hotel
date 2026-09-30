// Smoke test the actual distributable, never the hotel's live data directory.
const {spawn}=require('node:child_process');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),assert=require('node:assert/strict');
(async()=>{
  const folder=path.resolve(process.argv[2]);
  const data=fs.mkdtempSync(path.join(os.tmpdir(),'kasho-release-check-'));
  const server=spawn(path.join(folder,'runtime/python.exe'),['-B',path.join(folder,'frontdesk/server.py'),'--port','8767','--data-dir',data],{windowsHide:true});
  try{
    await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Startup timeout')),15000);server.once('error',reject);server.once('exit',code=>{clearTimeout(timer);reject(Error('Exited '+code));});server.stdout.on('data',d=>{if(String(d).includes('KASHO Front Desk:')){clearTimeout(timer);resolve();}});server.stderr.on('data',d=>process.stderr.write(d));});
    const base='http://127.0.0.1:8767';
    let s=await(await fetch(base+'/api/state')).json();
    assert.equal(s.bookings.length,0);assert.equal(s.otaOrders.length,0);
    assert.deepEqual(s.defaultRates,{'标准间':19624,'大床房':17864,'高级观景':28424,'舒适观景':26664});
    for(const file of ['','simple.js','ota.js','money.js','batch.css'])assert.equal((await fetch(base+'/'+file)).status,200);
    const r=await fetch(base+'/api/quick-in',{method:'POST',headers:{'Content-Type':'application/json','X-Kasho-Request':'frontdesk'},body:JSON.stringify({revision:s.revision,room:'8306',channel:'线下',date:s.today,nights:3,amount:'535.92',notes:'发布测试',paymentStatus:'未付'})});
    assert.equal(r.status,200);s=await r.json();
    assert.equal(s.bookings[0].roomCharge,53592);
    assert.equal(s.inventory[s.today]['大床房'].free,1);
    assert.equal(fs.existsSync(path.join(folder,'frontdesk/data')),false);
    console.log('PASS: bundled runtime starts packaged server; empty data, assets, exact room prices and 3-night save. No data written inside package.');
  }finally{if(server.exitCode===null){const exited=new Promise(resolve=>server.once('exit',resolve));server.kill();await exited;}}
})().catch(e=>{console.error(e);process.exitCode=1;});
