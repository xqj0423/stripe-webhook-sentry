# Next.js App Router / PostgreSQL example

The runnable implementation is in [route.ts](../examples/route.ts), [webhook.mts](../examples/webhook.mts), [process-event.mts](../examples/process-event.mts) and [schema.sql](../examples/schema.sql). The files are the source of truth; this guide does not duplicate a separate code snippet.

## Supported model

- One Stripe account and one test/live mode per database. Snapshot events only. Connect/organization contexts are rejected.
- Subscription-mode Checkout; one access tier. The app creates Checkout Sessions with its trusted product/price selection and registers the returned Session ID against the authenticated user before redirecting them. No arbitrary customer/user metadata is accepted as proof of ownership.
- PostgreSQL at READ COMMITTED using node-postgres. All snapshot/order writers use the same database and locking protocol. This is an explicit database example, not a drop-in Prisma or SQLite implementation.
- Database-only fulfillment: an order becomes fulfilled and access is derived from its linked active/trialing subscription. No emails, physical shipping, wallet credits, refunds, disputes or external provisioning are implemented.
- Node.js 24+ for directly running .mts tests. Runtime dependencies are pinned in package.json/package-lock.json. The reference uses Stripe SDK 23.1.0 and its API version 2026-10-28.endive; the webhook rejects different snapshot API versions. Adapt deliberately when upgrading.

## Set up

1. Copy examples/ into your app and adjust route imports for app/api/webhooks/stripe/route.ts. Use the Node runtime. Install the pinned pg and stripe dependencies; the sample's TypeScript modules are .mts.
2. Apply schema.sql to an isolated database first. Adapt the tables to your app through migrations; do not run this example schema blindly on production tables.
3. Configure DATABASE_URL, STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET and STRIPE_EXPECT_LIVE=true|false. The CLI forwarding secret and a Dashboard endpoint secret differ.
4. Create a server-owned user/customer mapping and order after creating the Checkout Session, before returning its redirect URL. Use parameterized SQL, for example:

~~~sql
INSERT INTO app_users(user_id,stripe_customer_id) VALUES($1,$2);
INSERT INTO checkout_orders(session_id,user_id,stripe_customer_id,allow_no_payment)
VALUES($1,$2,$3,$4);
~~~

The policy flag allow_no_payment is set by your server/product policy, not supplied by the customer. false leaves a zero-payment Session awaiting_approval without access. true permits trial/free provisioning after current subscription synchronization. This example does not implement a manual approval workflow; changing a flag and resending an already processed event does not bypass deduplication.

5. Configure only the relevant snapshot events, including the Checkout completed/async success/async failure events, subscription created/updated/deleted/paused/resumed, and invoice.paid/payment_failed. Old invoice payloads using invoice.subscription require a version adapter; the pinned API uses invoice.parent.subscription_details.subscription.
6. Query user_subscription_access for this example's Boolean access policy. Do not treat an order being paid/fulfilled alone as an active subscription. A richer app must define trials, grace periods, tier/seat entitlements, cancellation and refunds itself.

If events arrive before mapping creation, the transaction fails and receipt insertion rolls back. Fix mappings and replay within Stripe's supported recovery window; retries are finite and require operational attention when exhausted.

## Transaction and lock sequence

1. Acquire one pool client. Begin an explicit READ COMMITTED transaction.
2. Insert processed_events using ON CONFLICT(event_id) DO NOTHING RETURNING event_id. Only this table/key conflict is an acknowledged duplicate. Business errors propagate; there is no generic P2002/unique-error catch.
3. Checkout path: lock the pre-registered checkout_orders row FOR UPDATE. Missing row throws. An already fulfilled order returns without executing fulfillment again, even when a distinct event refers to the same Session.
4. Fetch the current Checkout Session while its order is locked. Check mode/customer and the server-owned free-payment policy. A fulfilled order cannot be reset by late unpaid/failure events. Failure without an order throws instead of silently updating zero rows.
5. To synchronize a subscription, find its customer mapping, create its row if needed, then lock that subscription row FOR UPDATE **before** fetching its current Stripe state. Write to this subscription ID, never a single permanent canceled flag on the user. Checkout paths always acquire order then subscription; subscription/invoice paths acquire only subscription. Other writers must preserve the protocol.
6. Commit the receipt and business state together. On processing failure roll back and return 500. Invalid signature/account/mode/API version returns 400; intentionally unsupported event types return 200 as ignored.

## Configuration failures and intentional ignores

A valid signature does not make a payload compatible with this endpoint. An API-version mismatch can mean a real payment event is unprocessable until configuration/an adapter is fixed. This example returns 400 with code endpoint_configuration_mismatch, logs the expected/received configuration, and leaves the event unprocessed. Repair the endpoint version/destination/mode configuration promptly and recover deliveries through Stripe's supported replay tools. Never return 200 merely to conceal such a failure.

A deliberately irrelevant event type is different: processEvent acknowledges it as ignored. Applications that intentionally share destinations across modes/accounts must define their own routing/ignore policy and tests rather than copying this single-account rejection policy blindly.

Stripe considers non-2xx deliveries failures and can retry with exponential backoff, for up to three days in live mode. Do not infer automatic disablement from this status code alone. Consult actual destination status/notifications and Stripe's recovery guidance; no universal automatic-disable threshold is assumed. Official examples also use 400 for missing organization/account context, not only for bad signatures.

## Synchronous resource-serialization tradeoff

The network fetch runs under a row lock in this small synchronous example. Stripe requests and lock waits are bounded; timeouts fail the transaction for retry. This costs connection/lock occupancy, and is not a throughput recommendation. route.ts creates a dedicated webhook pool; do not reuse it for interactive application queries. The sample max=5 is per instance, not a universal capacity setting. Budget all instance pools against database limits, observe pool wait/timeout rates, and load-test the expected workload. For a high-volume app, use durable ingestion plus a per-resource worker and reconciliation policy, validated for that deployment.

Moving the API fetch before the resource lock reopens the stale-write timeline tested in payments.test.mts. Adopt a durable per-resource worker or another demonstrated synchronization protocol before making that change; simply increasing the pool or adding an untested queue is not a correctness fix.

A Stripe object can change immediately after any fetch. This protocol orders cooperating local writers; it does not create an atomic transaction across Stripe and PostgreSQL. Later events/reconciliation must bring snapshots up to date. A success redirect should query committed access; it must not implement a separate unprotected fulfillment path.

## Verify

~~~sh
npm ci
npm run typecheck
npm test
~~~

The linter can scan examples/route.ts in auto mode, but it will warn about delegated verification. Directory scans list skipped helpers; use --framework app on examples/process-event.mts if you want text patterns in that module. This does not establish database correctness.

Tests launch a temporary real PostgreSQL on loopback and use multiple independent pooled connections. Stripe SDK signature checks are real; Stripe resource API responses come from a local HTTP test server. They do not contact a Stripe account or run Next.js/Stripe CLI.

For actual deployment acceptance, run the copied route in Next.js, create real sandbox Sessions through your server flow, forward/replay events with Stripe CLI and inspect committed orders/subscriptions/access. Verify timeout/retry behavior on your host and recover failures with the Dashboard/CLI. Do not call the bundled suite a completed live acceptance test.

## Sources

- [Stripe webhook delivery, duplicate handling and ordering](https://docs.stripe.com/webhooks)
- [Stripe Checkout fulfillment and Session-level idempotency](https://docs.stripe.com/checkout/fulfillment?ui=full-page)
- [node-postgres: use the same client for every transaction statement](https://node-postgres.com/features/transactions)
- [PostgreSQL row-level locking](https://www.postgresql.org/docs/current/explicit-locking.html)
- [PostgreSQL targeted ON CONFLICT](https://www.postgresql.org/docs/current/sql-insert.html)
