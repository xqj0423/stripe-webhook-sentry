// Copy examples/ into your application, apply schema.sql, install pg and stripe,
// and adjust this import to the copied module. Use the Node runtime, not Edge.
import {Pool} from 'pg';
import Stripe from 'stripe';
import {createWebhookHandler} from './webhook.mts';
export const runtime = 'nodejs';
const {STRIPE_SECRET_KEY,STRIPE_WEBHOOK_SECRET,DATABASE_URL,STRIPE_EXPECT_LIVE}=process.env;
if (!STRIPE_SECRET_KEY || !STRIPE_WEBHOOK_SECRET || !DATABASE_URL || !['true','false'].includes(STRIPE_EXPECT_LIVE||''))
  throw new Error('Configure Stripe keys, DATABASE_URL and STRIPE_EXPECT_LIVE=true|false');
const stripe = new Stripe(STRIPE_SECRET_KEY,{timeout:4000,maxNetworkRetries:0});
// Dedicated webhook pool; keep separate from interactive app queries.
// Tune per-instance limits against the database connection budget.
const pool = new Pool({connectionString:DATABASE_URL,max:5,connectionTimeoutMillis:5000});
export const POST = createWebhookHandler(pool,stripe,STRIPE_WEBHOOK_SECRET,STRIPE_EXPECT_LIVE==='true');
