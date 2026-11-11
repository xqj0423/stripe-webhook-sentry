import {test, before, after, beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, readFile, rm} from 'node:fs/promises';
import {createServer} from 'node:http';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import EmbeddedPostgres from 'embedded-postgres';
import {Pool} from 'pg';
import Stripe from 'stripe';
import {processEvent} from '../examples/process-event.mts';
import {createWebhookHandler} from '../examples/webhook.mts';

let db: EmbeddedPostgres, pool: Pool, stripe: Stripe, dataDir: string;
let sessions: Record<string, object>={}, subs: Record<string, object>={};
let fetchCount=0;
let subscriptionGate: null | (()=>Promise<void>)=null;
const api=createServer(async(req,res)=>{
 try {
  const id=decodeURIComponent((req.url||'').split('?')[0].split('/').pop()!);
  let body: object|undefined;
  if(req.url?.startsWith('/v1/checkout/sessions/')) body=sessions[id];
  else {fetchCount++;body=structuredClone(subs[id]);if(subscriptionGate)await subscriptionGate();}
  res.writeHead(body?200:404,{'content-type':'application/json'});
  res.end(JSON.stringify(body||{error:{message:'not found',type:'invalid_request_error'}}));
 } catch(e) {res.writeHead(500);res.end(JSON.stringify({error:{message:String(e)}}));}
});
function event(id:string,type:string,object:object):Stripe.Event {
 return JSON.parse(JSON.stringify({id,object:'event',livemode:false,created:1700000000,api_version:Stripe.API_VERSION,type,data:{object}}));
}
function session(payment_status='paid',sub='sub_1') {
 return {id:'cs_1',object:'checkout.session',mode:'subscription',status:'complete',payment_status,customer:'cus_1',subscription:sub};
}
function subscription(status='active',id='sub_1') {
 return {id,object:'subscription',customer:'cus_1',status,items:{data:[{price:{id:'price_pro'}}]}};
}
function checkout(id='evt_1',type='checkout.session.completed'){return event(id,type,session());}
async function rows(sql:string){return (await pool.query(sql)).rows;}
async function access(){return (await rows("SELECT has_access FROM user_subscription_access WHERE user_id='u1'"))[0].has_access;}
async function until(f:()=>Promise<boolean>){for(let i=0;i<200;i++){if(await f())return;await delay(10);}throw new Error('condition did not become true');}
before(async()=>{
 await mkdir(new URL('../work/',import.meta.url),{recursive:true});
 dataDir=await mkdtemp(fileURLToPath(new URL('../work/pg-',import.meta.url)));
 // Ask the OS for an unused port; the server is bound only to loopback.
 const portProbe=createServer();await new Promise<void>(r=>portProbe.listen(0,'127.0.0.1',r));
 const pgPort=(portProbe.address() as {port:number}).port;await new Promise<void>(r=>portProbe.close(()=>r()));
 db=new EmbeddedPostgres({databaseDir:dataDir,user:'postgres',password:'local_test_only',port:pgPort,persistent:true,postgresFlags:['-h','127.0.0.1'],autoRehydrateSymlinks:true,onLog:()=>{},onError:console.error});
 await db.initialise();await db.start();
 pool=new Pool({host:'127.0.0.1',port:pgPort,user:'postgres',password:'local_test_only',database:'postgres',max:12,application_name:'sentry-test'});
 await pool.query(await readFile(new URL('../examples/schema.sql',import.meta.url),'utf8'));
 // A database observer counts actual fulfillment writes, including accidental repeats.
 await pool.query("CREATE TABLE fulfillment_audit(session_id text); CREATE FUNCTION audit_fulfillment() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.status='fulfilled' THEN INSERT INTO fulfillment_audit VALUES(NEW.session_id); END IF; RETURN NEW; END $$; CREATE TRIGGER audit AFTER UPDATE ON checkout_orders FOR EACH ROW EXECUTE FUNCTION audit_fulfillment();");
 await new Promise<void>(r=>api.listen(0,'127.0.0.1',r));
 stripe=new Stripe('sk_test_local_only',{host:'127.0.0.1',port:(api.address() as {port:number}).port,protocol:'http',maxNetworkRetries:0,timeout:3000});
});
after(async()=>{api.closeAllConnections();await new Promise<void>(r=>api.close(()=>r()));if(pool)await pool.end();if(db)await db.stop();if(dataDir)await rm(dataDir,{recursive:true,force:true,maxRetries:20,retryDelay:100});});
beforeEach(async()=>{
 subscriptionGate=null;fetchCount=0;
 await pool.query('DROP TRIGGER IF EXISTS business_error ON checkout_orders; TRUNCATE processed_events,checkout_orders,subscriptions,app_users,fulfillment_audit CASCADE');
 await pool.query("INSERT INTO app_users VALUES ('u1','cus_1'); INSERT INTO checkout_orders(session_id,user_id,stripe_customer_id) VALUES('cs_1','u1','cus_1')");
 sessions={cs_1:session()};subs={sub_1:subscription()};
});

test('concurrent duplicate events commit one event and one fulfillment',async()=>{
 const result=await Promise.all(Array.from({length:8},()=>processEvent(pool,stripe,checkout())));
 assert.equal(result.filter(r=>r==='processed').length,1);assert.equal((await rows('SELECT * FROM processed_events')).length,1);assert.equal((await rows('SELECT * FROM fulfillment_audit')).length,1);assert.equal(await access(),true);
});
test('different event IDs for one Session do not fulfill twice',async()=>{
 await Promise.all([processEvent(pool,stripe,checkout('evt_a')),processEvent(pool,stripe,checkout('evt_b','checkout.session.async_payment_succeeded'))]);
 assert.equal((await rows('SELECT * FROM processed_events')).length,2);assert.equal((await rows('SELECT * FROM fulfillment_audit')).length,1);
});
test('business primary-key conflict rolls back event receipt and allows retry',async()=>{
 await pool.query("CREATE OR REPLACE FUNCTION fail_business() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'business id conflict' USING ERRCODE='23505', CONSTRAINT='checkout_orders_pkey'; END $$; CREATE TRIGGER business_error BEFORE UPDATE ON checkout_orders FOR EACH ROW EXECUTE FUNCTION fail_business();");
 await assert.rejects(processEvent(pool,stripe,checkout()),{code:'23505'});
 assert.equal((await rows('SELECT * FROM processed_events')).length,0);assert.equal(await access(),false);
 await pool.query('DROP TRIGGER business_error ON checkout_orders');await processEvent(pool,stripe,checkout());assert.equal(await access(),true);
});
test('missing order mapping fails without acknowledging event',async()=>{
 await pool.query('DELETE FROM checkout_orders');await assert.rejects(processEvent(pool,stripe,checkout()),/mapping/i);assert.equal((await rows('SELECT * FROM processed_events')).length,0);
});
test('late unpaid completion and failure cannot undo fulfilled order',async()=>{
 await processEvent(pool,stripe,checkout());sessions.cs_1=session('unpaid');
 await processEvent(pool,stripe,checkout('evt_old'));await processEvent(pool,stripe,checkout('evt_failed','checkout.session.async_payment_failed'));
 assert.equal((await rows('SELECT status FROM checkout_orders'))[0].status,'fulfilled');assert.equal((await rows('SELECT * FROM fulfillment_audit')).length,1);
});
test('failure before completion stays failed until a live successful Session exists',async()=>{
 sessions.cs_1=session('unpaid');await processEvent(pool,stripe,checkout('evt_failed','checkout.session.async_payment_failed'));await processEvent(pool,stripe,checkout('evt_completed'));
 assert.equal((await rows('SELECT status FROM checkout_orders'))[0].status,'payment_failed');
 sessions.cs_1=session();await processEvent(pool,stripe,checkout('evt_success','checkout.session.async_payment_succeeded'));assert.equal(await access(),true);
});
test('failure with missing order rolls back instead of silently updating zero rows',async()=>{
 await pool.query('DELETE FROM checkout_orders');await assert.rejects(processEvent(pool,stripe,checkout('evt_failed','checkout.session.async_payment_failed')),/mapping/i);assert.equal((await rows('SELECT * FROM processed_events')).length,0);
});
test('subscription row is locked before fetching so a stale fetch cannot write last',async()=>{
 let unblock!:()=>void;const gate=new Promise<void>(r=>unblock=r);let first=true;
 subscriptionGate=async()=>{if(first){first=false;await gate;}};
 const a=processEvent(pool,stripe,event('evt_update','customer.subscription.updated',subscription()));
 await until(async()=>fetchCount===1);
 subs.sub_1=subscription('canceled');
 const b=processEvent(pool,stripe,event('evt_delete','customer.subscription.deleted',subscription('canceled')));
 try {
  await until(async()=>(await rows("SELECT 1 FROM pg_stat_activity WHERE application_name='sentry-test' AND wait_event_type='Lock'")).length>0);
  assert.equal(fetchCount,1,'second worker must not fetch before lock acquisition');
 } finally {unblock();}
 await Promise.all([a,b]);assert.equal((await rows('SELECT status FROM subscriptions'))[0].status,'canceled');
});
test('a late paid checkout cannot reactivate a canceled subscription',async()=>{
 subs.sub_1=subscription('canceled');await processEvent(pool,stripe,checkout());assert.equal(await access(),false);
});
test('canceling an old subscription does not remove access from a new subscription',async()=>{
 await processEvent(pool,stripe,checkout());
 await pool.query("INSERT INTO checkout_orders(session_id,user_id,stripe_customer_id) VALUES('cs_2','u1','cus_1')");
 sessions.cs_2={...session('paid','sub_2'),id:'cs_2'};subs.sub_2=subscription('active','sub_2');
 await processEvent(pool,stripe,event('evt_new','checkout.session.completed',sessions.cs_2));subs.sub_1=subscription('canceled');
 await processEvent(pool,stripe,event('evt_old_cancel','customer.subscription.deleted',subscription('canceled')));assert.equal(await access(),true);
});
test('zero-payment checkout follows server-side policy',async()=>{
 sessions.cs_1=session('no_payment_required');subs.sub_1=subscription('trialing');await processEvent(pool,stripe,checkout());assert.equal(await access(),false);
 assert.equal((await rows('SELECT status FROM checkout_orders'))[0].status,'awaiting_approval');
 await pool.query("INSERT INTO checkout_orders(session_id,user_id,stripe_customer_id,allow_no_payment) VALUES('cs_trial','u1','cus_1',true)");
 sessions.cs_trial={...session('no_payment_required','sub_trial'),id:'cs_trial'};subs.sub_trial=subscription('trialing','sub_trial');
 await processEvent(pool,stripe,event('evt_trial','checkout.session.completed',sessions.cs_trial));assert.equal(await access(),true);
});
test('mismatched Stripe customer cannot fulfill a mapped order',async()=>{
 sessions.cs_1={...session(),customer:'cus_other'};await assert.rejects(processEvent(pool,stripe,checkout()),/customer/i);assert.equal((await rows('SELECT * FROM processed_events')).length,0);
});
test('route verifies signatures with the real Stripe SDK before processing',async()=>{
 const handler=createWebhookHandler(pool,stripe,'whsec_local',false);
 const payload=JSON.stringify(checkout());const header=stripe.webhooks.generateTestHeaderString({payload,secret:'whsec_local'});
 const bad=await handler(new Request('http://local/webhook',{method:'POST',body:payload,headers:{'stripe-signature':header+'invalid'}}));assert.equal(bad.status,400);assert.equal((await rows('SELECT * FROM processed_events')).length,0);
 const good=await handler(new Request('http://local/webhook',{method:'POST',body:payload,headers:{'stripe-signature':header}}));assert.equal(good.status,200);assert.equal(await access(),true);
});
test('route rejects stale signatures and live/test mismatch',async(t)=>{
 const diagnostic=t.mock.method(console,'error',()=>{});
 const handler=createWebhookHandler(pool,stripe,'whsec_local',false);const payload=JSON.stringify({...checkout(),livemode:true});
 for(const timestamp of [1,Math.floor(Date.now()/1000)]){
  const header=stripe.webhooks.generateTestHeaderString({payload,secret:'whsec_local',timestamp});const r=await handler(new Request('http://local',{method:'POST',body:payload,headers:{'stripe-signature':header}}));assert.equal(r.status,400);
 }
 assert.equal((await rows('SELECT * FROM processed_events')).length,0);
});

test('route rejects a snapshot API-version mismatch before touching the database',async(t)=>{
 const diagnostic=t.mock.method(console,'error',()=>{});
 const handler=createWebhookHandler(pool,stripe,'whsec_local',false);
 const payload=JSON.stringify({...checkout(),api_version:'2024-06-20'});
 const signature=stripe.webhooks.generateTestHeaderString({payload,secret:'whsec_local'});
 const result=await handler(new Request('http://local',{method:'POST',body:payload,headers:{'stripe-signature':signature}}));
 assert.equal(result.status,400);assert.equal((await result.json()).code,'endpoint_configuration_mismatch');assert.equal(diagnostic.mock.callCount(),1);assert.equal(diagnostic.mock.calls[0].arguments[1].expectedApiVersion,Stripe.API_VERSION);assert.equal((await rows('SELECT * FROM processed_events')).length,0);
});

test('late invoice events synchronize live subscription status rather than copying failure state',async()=>{
 await processEvent(pool,stripe,checkout());
 const invoice={id:'in_1',object:'invoice',customer:'cus_1',parent:{type:'subscription_details',subscription_details:{subscription:'sub_1'}}};
 await processEvent(pool,stripe,event('evt_invoice_failed','invoice.payment_failed',invoice));
 assert.equal(await access(),true);
 subs.sub_1=subscription('past_due');
 await processEvent(pool,stripe,event('evt_invoice_paid','invoice.paid',invoice));
 assert.equal((await rows('SELECT status FROM subscriptions'))[0].status,'past_due');assert.equal(await access(),false);
});
