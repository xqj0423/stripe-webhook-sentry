#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const {rules} = require('./lint-rules.json');

// Keep offsets/newlines. This is a small lexer, not a parser: template interpolation
// is intentionally opaque. Reported patterns never imply executed behavior.
function views(source) {
  let code='',clean='',i=0;
  const mask = s => s.replace(/[^\r\n]/g,' ');
  while(i<source.length) {
    const start=i;
    if(source.startsWith('//',i)||source[i]==='#') {
      while(i<source.length&&source[i]!=='\n') i++;
      const s=mask(source.slice(start,i));code+=s;clean+=s;
    } else if(source.startsWith('/*',i)) {
      const end=source.indexOf('*/',i+2);i=end<0?source.length:end+2;
      const s=mask(source.slice(start,i));code+=s;clean+=s;
    } else if('"\x27\x60'.includes(source[i])) {
      const q=source[i],triple=source.startsWith(q.repeat(3),i),end=triple?q.repeat(3):q;i+=end.length;
      while(i<source.length){if(source[i]==='\\'){i+=2;continue;}if(source.startsWith(end,i)){i+=end.length;break;}i++;}
      const s=source.slice(start,i);code+=mask(s);clean+=s;
    } else {code+=source[i];clean+=source[i];i++;}
  }
  return {code,clean};
}
function inspect(file,source,framework,profile) {
  const v=views(source);
  const handler=/\b(?:POST|webhook|handler)\s*(?:\(|=|:)|\bexport\s*\{[^}]*\bPOST\b|\bdef\s+\w*webhook\w*\s*\(|\.post\s*\(/i.test(v.code);
  if(!handler && framework==='auto' && !/\b(?:whsec_|sk_live_|sk_test_|rk_live_|rk_test_)[A-Za-z0-9_]{20,}/.test(source))return null;
  if(framework==='auto')framework=file.endsWith('.py')?'fastapi':file.replaceAll('\\','/').includes('/pages/api/')?'pages':'app';
  const findings=[];
  function add(rule,level,message,index=0){findings.push({file,rule,level,line:source.slice(0,index).split('\n').length,message});}
  const secret=/\b(?:whsec_|sk_live_|sk_test_|rk_live_|rk_test_)[A-Za-z0-9_]{20,}/g;
  for(const m of source.matchAll(secret))add('secret-like-literal','FAIL','Stripe-key-shaped text detected. Remove real secrets; test placeholders may be false positives.',m.index);
  for(const r of rules){
    if(r.frameworks&&!r.frameworks.includes(framework))continue;
    const m=new RegExp(r.pattern,'m').exec(v[r.channel||'code']);
    if(r.missing?!m:!!m)add(r.id,r.level,r.message,m?.index||0);
  }
  if(v.clean.includes('checkout.session.completed')) {
    const m=/\bpayment_status\b/.exec(v.clean);
    add('payment-status-reference',m?'FOUND':'WARN',m?'payment_status text appears; comparison, mode and provisioning policy are unverified.':'Checkout completion text appears without payment_status. Inspect the fulfillment path.',m?.index||0);
  }
  if(profile==='subscription')for(const event of ['customer.subscription.created','customer.subscription.updated','customer.subscription.deleted','invoice.paid']) {
    if(!v.clean.includes(event))add('event-missing:'+event,'WARN','Event text not in this file: '+event+'. Check configured destinations and delegated handlers before adding it.');
  }
  return findings;
}
function main(args) {
  let target=null,framework='auto',profile='none',strict=false,json=false;
  try {
    for(let i=0;i<args.length;i++) {
      const a=args[i];
      if(a==='--help'||a==='-h'){console.log('Usage: node scripts/scan-stripe-handler.js PATH [--framework auto|app|pages|express|fastapi] [--profile none|subscription] [--strict] [--json]\nExit: 0 complete; 1 findings (FAIL, or WARN with --strict); 2 input/read error or no eligible handlers.');return 0;}
      if(a==='--strict')strict=true;
      else if(a==='--json')json=true;
      else if(a==='--framework')framework=args[++i];
      else if(a==='--profile')profile=args[++i];
      else if(a.startsWith('-'))throw new Error('Unknown option: '+a);
      else if(target===null)target=a;else throw new Error('Only one target is supported');
    }
    if(!target)throw new Error('PATH is required (see --help)');
    if(!['auto','app','pages','express','fastapi'].includes(framework))throw new Error('Invalid framework');
    if(!['none','subscription'].includes(profile))throw new Error('Invalid profile');
    const files=[];
    function walk(p){const s=fs.lstatSync(p);if(s.isSymbolicLink())return;if(s.isDirectory()){
      for(const n of fs.readdirSync(p).sort())if(!['node_modules','.git','.next','venv','.venv','__pycache__'].includes(n))walk(path.join(p,n));
    }else if(s.isFile()&&/\.(?:[cm]?[jt]s|tsx|py)$/.test(p))files.push(p);}
    walk(path.resolve(target));
    let filesScanned=0;const findings=[];const skippedFiles=[];
    for(const f of files){const result=inspect(f,fs.readFileSync(f,'utf8'),framework,profile);if(result!==null){filesScanned++;findings.push(...result);}else skippedFiles.push(f);}
    if(!filesScanned)throw new Error('No eligible handler source files found');
    if(json)console.log(JSON.stringify({filesScanned,skippedFiles,findings}));
    else {
      console.log('Stripe webhook heuristic lint: '+filesScanned+' file(s), '+skippedFiles.length+' helper/source file(s) skipped');
      for(const f of skippedFiles)console.log('[SKIPPED] '+f+': no local handler pattern; imports are not resolved. Use --framework to inspect this file explicitly.');
      for(const f of findings)console.log('['+f.level+'] '+f.file+':'+f.line+' '+f.rule+': '+f.message);
      console.log('Pattern observations only. No syntax, signature, transaction, idempotency or concurrency guarantee.');
    }
    return findings.some(f=>f.level==='FAIL'||strict&&f.level==='WARN')?1:0;
  } catch(error) {if(json)console.log(JSON.stringify({error:error.message}));else console.error('[ERROR] '+error.message);return 2;}
}
if(require.main===module)process.exitCode=main(process.argv.slice(2));
module.exports={inspect,views};
