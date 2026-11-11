const {test}=require('node:test');
const assert=require('node:assert/strict');
const {spawnSync}=require('node:child_process');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'stripe-lint-'));
const root=path.resolve(__dirname,'..');
const commands=[[process.execPath,[path.join(root,'scripts/scan-stripe-handler.js')]]];
if(process.env.PYTHON_BIN) commands.push([process.env.PYTHON_BIN,[path.join(root,'scripts/scan_stripe_handler.py')]]);
function run(source,args=[],name='handler.ts') {
 const target=path.join(dir,name); fs.writeFileSync(target,source);
 return commands.map(([exe,prefix])=>{const p=spawnSync(exe,[...prefix,target,'--json',...args],{encoding:'utf8'});return {status:p.status,report:JSON.parse(p.stdout),stderr:p.stderr}});
}
test('flags JSON reads even when raw text is also read, regardless of filename',()=>{
 for(const r of run('export async function POST(req) { const stripe={}; await req.json(); const raw=await req.text(); stripe.webhooks.constructEvent(raw,sig,secret); }',['--framework','app'])) {
  assert(r.report.findings.some(x=>x.rule==='json-body-read'&&x.level==='WARN')); assert.equal(r.status,0);
 }
});
test('a string or comment does not count as an executed signature call',()=>{
 for(const r of run('export async function POST(req) { const note="stripe.webhooks.constructEvent"; // stripe.webhooks.constructEvent()\n return Response.json({ok:true}); }',['--framework','app','--strict'])) {
  assert(r.report.findings.some(x=>x.rule==='signature-not-seen')); assert.equal(r.status,1);
 }
});
test('column-only P2002 matching stays a warning',()=>{
 for(const r of run('export async function POST(req) { stripe.webhooks.constructEvent(raw,sig,secret); try { await prisma.$transaction(f); } catch(err) { if(err.code === "P2002" && err.meta.target.includes("id")) return ok; } }',['--framework','app'])) {
  assert(r.report.findings.some(x=>x.rule==='unique-error-review'&&x.level==='WARN'));
 }
});
test('a key-like string is reported without leaking the matched value',()=>{
 const secret='sk_live_'+'a'.repeat(30);
 for(const r of run('const stripeKey="'+secret+'";')) { assert.equal(r.status,1);assert(!JSON.stringify(r.report).includes(secret)); }
});
test('FastAPI construct_event is recognized and does not require JS lifecycle names',()=>{
 for(const r of run('async def webhook(request):\n    raw = await request.body()\n    event = stripe.Webhook.construct_event(raw, sig, secret)\n    return {"received": True}\n',['--framework','fastapi'],'handler.py')) {
 assert(!r.report.findings.some(x=>x.rule==='signature-not-seen'));assert(!r.report.findings.some(x=>x.rule.startsWith('event-missing')));
 }
});
test('invalid input, unknown flags and files with no eligible handlers fail operationally',()=>{
 for(const [exe,prefix] of commands){
  for(const args of [[path.join(dir,'missing')],[dir,'--nonsense'],[path.join(dir,'plain.ts')]]) {
   fs.writeFileSync(path.join(dir,'plain.ts'),'export const unrelated=1;');
   const r=spawnSync(exe,[...prefix,...args],{encoding:'utf8'});assert.equal(r.status,2,r.stdout+r.stderr);
  }
 }
});
test('JS and Python return the same finding set',{skip:commands.length<2},()=>{
 const results=run('export async function POST(req) { await req.json(); return Response.json({ok:true}); }',['--framework','app','--profile','subscription']);
 assert.deepEqual(results[0].report,results[1].report);
});
process.on('exit',()=>fs.rmSync(dir,{recursive:true,force:true}));

test('automatic discovery recognizes assigned and re-exported POST entrypoints',()=>{
 for(const source of [
  'export const POST = createWebhookHandler(pool,stripe,secret,false);',
  'export const POST: RequestHandler = withWebhook(processEvent);',
  'export { POST } from "./webhook";',
  'export { handleWebhook as POST } from "./webhook";'
 ])for(const r of run(source)) {assert.equal(r.status,0);assert.equal(r.report.filesScanned,1);assert(r.report.findings.some(f=>f.rule==='signature-not-seen'));}
});
test('directory reports skipped helper modules without pretending to resolve their imports',()=>{
 const bundle=path.join(dir,'bundle');fs.mkdirSync(bundle,{recursive:true});
 fs.writeFileSync(path.join(bundle,'route.ts'),'export const POST = createWebhookHandler(pool,stripe,secret,false);');
 fs.writeFileSync(path.join(bundle,'processor.mts'),'export async function processEvent(event) { return event.id; }');
 for(const [exe,prefix] of commands){
  const p=spawnSync(exe,[...prefix,bundle,'--json'],{encoding:'utf8'});assert.equal(p.status,0,p.stdout+p.stderr);
  const report=JSON.parse(p.stdout);assert.equal(report.filesScanned,1);assert.deepEqual(report.skippedFiles,[path.join(bundle,'processor.mts')]);
 }
});
