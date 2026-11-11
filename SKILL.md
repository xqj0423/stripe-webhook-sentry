---
name: stripe-webhook-sentry
description: Use when implementing or reviewing Stripe webhook handlers, diagnosing raw-body signature failures, or checking payment fulfillment and subscription synchronization. Includes conservative source-pattern tools and a PostgreSQL subscription-Checkout example.
license: MIT
metadata:
  version: "1.3.1"
  tooling-runtime: "Node.js 18+ or Python 3.8+; standard libraries only"
  example-runtime: "Node.js 24+, pg, stripe, PostgreSQL"
---

# Stripe Webhook Sentry

Use the project's framework, database and payment model. Establish whether it uses subscription Checkout, one-time payments, Connect, snapshot or thin events, and the endpoint API version before adapting examples.

## Implementation and review

- Verify signatures with the endpoint secret and untouched request bytes before using event contents. In Next.js App Router use request.text() or a buffer. Pages Router needs raw-body configuration; Express middleware order matters; FastAPI uses await request.body(). Use the appropriate Stripe SDK verifier for the language/event format.
- Treat event receipt and business fulfillment as separate idempotency boundaries. Commit a processed event only with the intended database work, or durably enqueue it with a recoverable worker lifecycle. A unique column name alone cannot establish which operation failed.
- Map purchases through server-owned order/customer records. A missing expected mapping is a processing failure, not successful fulfillment. Choose an explicit policy for deliberately irrelevant accounts/events.
- Check Checkout mode and current payment state. paid and no_payment_required are different cases; free access/trials depend on server-side product policy. unpaid does not authorize provisioning. Handle delayed success/failure if those methods are enabled.
- Stripe event.created is not an ordering version. Fetching a current object also does not order concurrent writes. Use a tested per-resource synchronization protocol suited to the database; keep subscription identity separate from user identity so an old canceled subscription cannot disable a new one.
- Database transactions do not roll back emails, shipping or other remote calls. If required, implement an outbox/worker with independently idempotent effects in the actual application. This package's example fulfills only database-backed subscription access.

For the executable Next.js/PostgreSQL example, assumptions, lock ordering and setup, read [NEXTJS_APP_ROUTER.md](references/NEXTJS_APP_ROUTER.md). For event selection and recovery cases, read [EVENT_MATRIX.md](references/EVENT_MATRIX.md). Do not transplant this example into Prisma, another database, Connect or a one-time-credit system without adapting and testing the semantics.

## Source-pattern checks

Run through an interpreter from this skill directory:

~~~sh
node scripts/scan-stripe-handler.js /path/to/handler.ts --framework app
python scripts/scan_stripe_handler.py /path/to/webhook.py --framework fastapi
~~~

Use --profile subscription only when that integration requires those events; handlers may be delegated to other files. --json produces machine-readable findings. --strict treats warnings as a nonzero outcome. Exit codes: 0 completed, 1 FAIL findings (or WARN under strict), 2 input/read error or no eligible source.

FOUND means text/call syntax was recognized. WARN means inspect context. FAIL currently flags key-shaped text, which can include test placeholders. The tools do not parse an AST, prove execution order, validate syntax, resolve imports or inspect database guarantees. Automatic discovery recognizes assigned/re-exported POST entrypoints; directory reports list skipped helper files and do not resolve imports. Explicit --framework overrides automatic handler discovery. Template-string interpolation and unusual syntax can be missed.

## Verification

Run the application's actual database/Stripe sandbox tests. The bundled local simulator only signs mock bytes and reports HTTP status; a receiver returning 200 without checking anything would also appear successful. Use an exact sandbox event file for repeat delivery and --invalid-signature or --timestamp 1 for rejection checks:

~~~sh
node scripts/simulate-webhook.js --url http://localhost:3000/api/webhooks/stripe --file event.json
~~~

The simulator reads STRIPE_WEBHOOK_SECRET, or accepts --secret. Synthetic object IDs are not real Stripe resources. Test DB failures/rollback, missing mappings, duplicate events, distinct events for the same Session, delayed payments and resource synchronization. Report exactly what was run; do not call static findings or local mocks Stripe CLI end-to-end verification.
