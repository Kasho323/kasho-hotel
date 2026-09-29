const {spawn}=require('node:child_process');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const root=path.resolve(__dirname,'../..');
async function check(script){
  const data=fs.mkdtempSync(path.join(os.tmpdir(),'kasho-regression-'));
  const server=spawn(process.argv[3]||'python',[path.join(root,'frontdesk/server.py'),'--port','8766','--data-dir',data],{cwd:root,windowsHide:true});
  try{
    await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Server startup timeout')),15000);server.once('error',reject);server.once('exit',code=>{clearTimeout(timer);reject(Error('Server exited '+code));});server.stdout.on('data',chunk=>{if(String(chunk).includes('KASHO Front Desk:')){clearTimeout(timer);resolve();}});server.stderr.on('data',d=>process.stderr.write(d));});
    await new Promise((resolve,reject)=>{const args=[path.join(__dirname,script),process.argv[2]];if(script==='check_ota_ui.cjs')args.push(process.env.KASHO_CTRIP_SAMPLE);const child=spawn(process.execPath,args,{cwd:root,windowsHide:true,stdio:'inherit'});child.once('error',reject);child.once('exit',code=>code===0?resolve():reject(Error(script+' failed: '+code)));});
  }finally{if(server.exitCode===null){const exited=new Promise(resolve=>server.once('exit',resolve));server.kill();await exited;}}
}
(async()=>{const scripts=['check_batch_ui.cjs','check_edit_ui.cjs','check_notes_ui.cjs','check_week_ui.cjs','check_move_ui.cjs'];if(process.env.KASHO_CTRIP_SAMPLE)scripts.push('check_ota_ui.cjs');for(const script of scripts)await check(script);console.log(`PASS: all ${scripts.length} isolated UI regression suites.`);})().catch(e=>{console.error(e);process.exitCode=1;});
