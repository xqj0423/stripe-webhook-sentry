const {test}=require('node:test');
const assert=require('node:assert/strict');
const {spawn}=require('node:child_process');
const fs=require('node:fs/promises');
const path=require('node:path');
const http=require('node:http');
const Stripe=require('stripe');
const stripe=new Stripe('sk_test_local_only');
const root=path.resolve(__dirname,'..');
function run(exe,args){return new Promise((resolve,reject)=>{const p=spawn(exe,args,{windowsHide:true});let output='';p.stdout.on('data',d=>output+=d);p.stderr.on('data',d=>output+=d);p.on('error',reject);p.on('close',status=>resolve({status,output}));});}
for(const [name,exe,script] of [['Node',process.execPath,'simulate-webhook.js'],['Python',process.env.PYTHON_BIN,'simulate_webhook.py']]) {
 test(name+' simulator sends exact file bytes, replays IDs, and supports rejection tests',{skip:!exe},async()=>{
  const ids=[];
  const server=http.createServer(async(req,res)=>{
   const chunks=[];for await(const chunk of req)chunks.push(chunk);
   try{const event=stripe.webhooks.constructEvent(Buffer.concat(chunks),req.headers['stripe-signature'],'whsec_local');ids.push(event.id);res.writeHead(200);res.end('ok');}
   catch{res.writeHead(400);res.end('bad signature');}
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  await fs.mkdir(path.join(root,'work'),{recursive:true});
  const file=path.join(root,'work','payload-'+name+'.json');
  await fs.writeFile(file,'{ "id": "evt_repeat", "type": "checkout.session.completed", "data": { "object": {} } }\n');
  const prefix=[path.join(root,'scripts',script),'--url','http://127.0.0.1:'+server.address().port,'--secret','whsec_local','--file',file];
  try {
   for(let i=0;i<2;i++)assert.equal((await run(exe,prefix)).status,0);
   assert.deepEqual(ids,['evt_repeat','evt_repeat']);
   assert.equal((await run(exe,[...prefix,'--invalid-signature'])).status,1);
   assert.equal((await run(exe,[...prefix,'--timestamp','1'])).status,1);
   assert.equal((await run(exe,[path.join(root,'scripts',script),'--help'])).status,0);
   assert.equal((await run(exe,[path.join(root,'scripts',script),'--unknown'])).status,2);
  } finally {server.closeAllConnections();await new Promise(r=>server.close(r));await fs.unlink(file);}
 });
}
