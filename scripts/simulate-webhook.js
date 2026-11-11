#!/usr/bin/env node
'use strict';
const fs=require('node:fs');
const crypto=require('node:crypto');
const http=require('node:http');
const https=require('node:https');
const samples=require('./sample-events.json');
function signature(payload,secret,timestamp){return 't='+timestamp+',v1='+crypto.createHmac('sha256',secret).update(String(timestamp)+'.').update(payload).digest('hex');}
async function main(args){
 let opts={url:'http://localhost:3000/api/webhooks/stripe',secret:process.env.STRIPE_WEBHOOK_SECRET||'whsec_test_secret_for_local_dev',event:'checkout.session.completed',timeout:10,timestamp:Math.floor(Date.now()/1000)},invalid=false;
 try {
  for(let i=0;i<args.length;i++){
   const a=args[i];
   if(a==='--help'||a==='-h'){console.log('Usage: node scripts/simulate-webhook.js [--url URL] [--secret SECRET] [--event TYPE | --file JSON] [--event-id ID] [--timestamp UNIX_SECONDS] [--invalid-signature] [--timeout SECONDS]\nUses STRIPE_WEBHOOK_SECRET when set. --file preserves exact bytes and event ID; replay it to test deduplication. Mock objects do not exist in Stripe.');return 0;}
   if(a==='--invalid-signature'){invalid=true;continue;}
   if(!['--url','--secret','--event','--file','--event-id','--timestamp','--timeout'].includes(a))throw new Error('Unknown option: '+a);
   if(!args[i+1]||args[i+1].startsWith('--'))throw new Error('Missing value for '+a);
   opts[a.slice(2)]=args[++i];
  }
  opts.timestamp=Number(opts.timestamp);opts.timeout=Number(opts.timeout);
  if(!Number.isInteger(opts.timestamp)||opts.timestamp<0||!Number.isFinite(opts.timeout)||opts.timeout<=0)throw new Error('Invalid timestamp or timeout');
  if(opts.file&&opts['event-id'])throw new Error('--file cannot be combined with --event-id');
  const target=new URL(opts.url);if(!['http:','https:'].includes(target.protocol))throw new Error('Use http or https');
  let payload;
  if(opts.file){payload=fs.readFileSync(opts.file);JSON.parse(payload.toString('utf8'));}
  else {if(!samples[opts.event])throw new Error('Unsupported mock event type');payload=Buffer.from(JSON.stringify({id:opts['event-id']||'evt_local_'+crypto.randomUUID(),object:'event',created:Math.floor(Date.now()/1000),livemode:false,type:opts.event,data:{object:samples[opts.event]}},null,2));}
  let header=signature(payload,opts.secret,opts.timestamp);if(invalid)header=header.slice(0,-1)+(header.endsWith('0')?'1':'0');
  return await new Promise(resolve=>{
   const client=target.protocol==='https:'?https:http;
   const req=client.request(target,{method:'POST',headers:{'content-type':'application/json','content-length':payload.length,'stripe-signature':header}},res=>{
    res.resume();res.on('end',()=>{console.log('HTTP '+res.statusCode);resolve(res.statusCode>=200&&res.statusCode<300?0:1);});res.on('error',e=>{console.error(e.message);resolve(1);});
   });
   req.setTimeout(opts.timeout*1000,()=>req.destroy(new Error('Request timeout')));
   req.on('error',e=>{console.error('Dispatch failed: '+e.message);resolve(1);});req.end(payload);
  });
 } catch(error){console.error('[ERROR] '+error.message);return 2;}
}
if(require.main===module)main(process.argv.slice(2)).then(code=>process.exitCode=code);
module.exports={signature};
