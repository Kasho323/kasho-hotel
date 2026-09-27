const {spawn}=require('node:child_process');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const root=path.resolve(__dirname,'../..');
async function check(script){
  const data=fs.mkdtempSync(path.join(os.tmpdir(),'kasho-regression-'));
  const server=spawn(process.argv[3]||'python',[path.join(root,'frontdesk/server.py'),'--port','8766','--data-dir',data],{cwd:root,windowsHide:true});
  try{
    await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Server startup timeout')),15000);server.once('error',reject);server.once('exit',code=>{clearTimeout(timer);reject(Error('Server exited '+code));});server.stdout.on('data',chunk=>{if(String(chunk).includes('KASHO Front Desk:')){clearTimeout(timer);resolve();}});server.stderr.on('data',d=>process.stderr.write(d));});
    await new Promise((resolve,reject)=>{const child=spawn(process.execPath,[path.join(__dirname,script),process.argv[2]],{cwd:root,windowsHide:true,stdio:'inherit'});child.once('error',reject);child.once('exit',code=>code===0?resolve():reject(Error(script+' failed: '+code)));});
  }finally{if(server.exitCode===null){const exited=new Promise(resolve=>server.once('exit',resolve));server.kill();await exited;}}
}
(async()=>{for(const script of ['check_batch_ui.cjs','check_edit_ui.cjs','check_notes_ui.cjs','check_week_ui.cjs'])await check(script);console.log('PASS: all four isolated UI regression suites.');})().catch(e=>{console.error(e);process.exitCode=1;});
