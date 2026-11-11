import type Stripe from 'stripe';
import type {Pool, PoolClient} from 'pg';

const checkoutEvents = new Set(['checkout.session.completed','checkout.session.async_payment_succeeded','checkout.session.async_payment_failed']);
const subscriptionEvents = new Set(['customer.subscription.created','customer.subscription.updated','customer.subscription.deleted','customer.subscription.paused','customer.subscription.resumed']);
const invoiceEvents = new Set(['invoice.paid','invoice.payment_failed']);

// Stripe expandable fields may be IDs, expanded objects, or null.
function resourceId(value: string | {id: string} | null | undefined): string {
  const id = typeof value === 'string' ? value : value?.id;
  if (!id) throw new Error('Required Stripe resource mapping is missing');
  return id;
}

async function syncSubscription(client: PoolClient, stripe: Stripe, id: string, customerId: string) {
  const mapping = await client.query<{user_id: string}>(
    'SELECT user_id FROM app_users WHERE stripe_customer_id=$1', [customerId]);
  if (mapping.rowCount !== 1) throw new Error('Customer mapping missing for subscription');
  const userId = mapping.rows[0].user_id;
  await client.query(
    'INSERT INTO subscriptions(subscription_id,user_id,stripe_customer_id) VALUES($1,$2,$3) ON CONFLICT(subscription_id) DO NOTHING',
    [id,userId,customerId]);
  const locked = await client.query<{user_id: string;stripe_customer_id: string}>(
    'SELECT user_id,stripe_customer_id FROM subscriptions WHERE subscription_id=$1 FOR UPDATE', [id]);
  if (locked.rows[0].user_id !== userId || locked.rows[0].stripe_customer_id !== customerId)
    throw new Error('Subscription customer mapping mismatch');

  // Acquire this subscription's DB lock BEFORE the network fetch. Every writer
  // of this snapshot must use this protocol; fetching first reopens the race.
  const live = await stripe.subscriptions.retrieve(id);
  if (resourceId(live.customer) !== customerId) throw new Error('Live subscription customer mismatch');
  await client.query(
    'UPDATE subscriptions SET status=$2,price_ids=$3::jsonb,synced_at=now() WHERE subscription_id=$1',
    [id,live.status,JSON.stringify(live.items.data.map(item=>item.price.id))]);
}

async function reconcileCheckout(client: PoolClient, stripe: Stripe, sessionId: string, failedEvent: boolean) {
  const result = await client.query<{
    user_id: string;stripe_customer_id: string;subscription_id: string|null;
    allow_no_payment: boolean;status: string;
  }>('SELECT * FROM checkout_orders WHERE session_id=$1 FOR UPDATE', [sessionId]);
  if (result.rowCount !== 1) throw new Error('Checkout order mapping missing');
  const order = result.rows[0];
  if (order.status === 'fulfilled') return;

  // A pre-registered order is the server-side ownership boundary. Never trust a
  // client userId or update every user matching an optional/undefined filter.
  const live = await stripe.checkout.sessions.retrieve(sessionId);
  if (live.mode !== 'subscription') throw new Error('This example only supports subscription-mode Checkout');
  if (resourceId(live.customer) !== order.stripe_customer_id) throw new Error('Checkout customer mismatch');
  const paid = live.payment_status === 'paid';
  const free = live.payment_status === 'no_payment_required';
  if (live.status !== 'complete' || (!paid && !free)) {
    const status = failedEvent || order.status === 'payment_failed' ? 'payment_failed' : 'pending_payment';
    await client.query('UPDATE checkout_orders SET status=$2 WHERE session_id=$1', [sessionId,status]);
    return;
  }
  if (free && !order.allow_no_payment) {
    await client.query("UPDATE checkout_orders SET status='awaiting_approval' WHERE session_id=$1", [sessionId]);
    return;
  }
  const subscriptionId = resourceId(live.subscription);
  if (order.subscription_id && order.subscription_id !== subscriptionId)
    throw new Error('Checkout subscription mapping mismatch');
  await syncSubscription(client,stripe,subscriptionId,order.stripe_customer_id);
  // This is the complete fulfillment in this example: a committed DB order plus
  // a subscription snapshot. Access is derived by the schema's view. No email,
  // shipping or external side effects are covered by this transaction.
  await client.query(
    "UPDATE checkout_orders SET status='fulfilled',subscription_id=$2 WHERE session_id=$1",
    [sessionId,subscriptionId]);
}

/** Accepts a signature-verified snapshot event for ONE Stripe account/mode.
 * All connections use the same PostgreSQL database, READ COMMITTED isolation.
 * Unknown event types are intentionally ignored. Errors propagate to HTTP 500.
 */
export async function processEvent(pool: Pool, stripe: Stripe, event: Stripe.Event): Promise<'processed'|'duplicate'|'ignored'> {
  if (!checkoutEvents.has(event.type) && !subscriptionEvents.has(event.type) && !invoiceEvents.has(event.type)) return 'ignored';
  const client = await pool.connect();
  let inTransaction = false;
  try {
    await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
    inTransaction = true;
    await client.query("SET LOCAL lock_timeout='5s'");
    await client.query("SET LOCAL statement_timeout='10s'");
    await client.query("SET LOCAL idle_in_transaction_session_timeout='15s'");
    // The conflict target is THIS insert's event key. No generic unique-error
    // catch can accidentally turn business-table failures into acknowledgments.
    const receipt = await client.query(
      'INSERT INTO processed_events(event_id,event_type) VALUES($1,$2) ON CONFLICT(event_id) DO NOTHING RETURNING event_id',
      [event.id,event.type]);
    if (receipt.rowCount === 0) {
      await client.query('COMMIT');inTransaction=false;return 'duplicate';
    }
    if (checkoutEvents.has(event.type)) {
      const session = event.data.object as Stripe.Checkout.Session;
      await reconcileCheckout(client,stripe,session.id,event.type==='checkout.session.async_payment_failed');
    } else if (subscriptionEvents.has(event.type)) {
      const sub = event.data.object as Stripe.Subscription;
      await syncSubscription(client,stripe,sub.id,resourceId(sub.customer));
    } else {
      const invoice = event.data.object as Stripe.Invoice;
      // Matches the pinned SDK/API's Invoice shape. Older API versions need an
      // explicit adapter, rather than a TypeScript cast pretending compatibility.
      const details = invoice.parent?.subscription_details;
      if (details?.subscription) await syncSubscription(client,stripe,resourceId(details.subscription),resourceId(invoice.customer));
    }
    await client.query('COMMIT');inTransaction=false;return 'processed';
  } catch (error) {
    if (inTransaction) {
      try {await client.query('ROLLBACK');}
      catch (rollbackError) {throw new AggregateError([error,rollbackError],'Processing and rollback failed');}
    }
    throw error;
  } finally {client.release();}
}
