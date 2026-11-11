# stripe-webhook-sentry

A Stripe webhook skill with source-pattern checks, local signature dispatchers and a tested PostgreSQL subscription-Checkout example. Static observations are not security or correctness certification.

## Use the skill

Copy this directory into the skill directory supported by your agent (for example .agents/skills/stripe-webhook-sentry or .claude/skills/stripe-webhook-sentry). SKILL.md routes to the implementation and event guides. No marketplace submission or listing is implied.

## Scan handler source

The Node and Python tools use only their standard libraries and a shared rule file. They need Node.js 18+ or Python 3.8+; no npm/pip install is needed for these tools.

~~~sh
node scripts/scan-stripe-handler.js app/api/webhooks/stripe/route.ts --framework app
python scripts/scan_stripe_handler.py app/webhook.py --framework fastapi
~~~

Options: --framework auto|app|pages|express|fastapi, --profile none|subscription, --strict, --json, --help. Profile defaults to none so unrelated subscription event requirements are not imposed on every endpoint.

- FOUND: text/call syntax appears. It does not establish an executed call or correct implementation.
- WARN: inspect context, including delegated verification/handlers.
- FAIL: key-shaped text appears, including possible test placeholders. Secret values are not printed.
- Exit 0: scan completed. Exit 1: FAIL, or WARN with --strict. Exit 2: input/read error or no eligible handler source.

Automatic discovery recognizes function declarations, factory-assigned POST exports and POST re-exports. Directory output lists skipped helper/source files (skippedFiles in JSON); it does not traverse imports or audit the whole call graph. For a helper module, pass --framework explicitly. A delegated route can correctly warn that signature verification is not in that file.

These tools do not perform AST parsing, syntax validation, control/data-flow analysis, import resolution or database inspection. They can miss aliases, template interpolation, middleware and unusual syntax. Inspect the actual application. Python construct_event and JavaScript constructEvent calls are recognized as separate language patterns. A P2002 warning remains reviewable even if meta.target mentions id: that does not identify the event table.

## Dispatch local smoke tests

~~~sh
node scripts/simulate-webhook.js --url http://localhost:3000/api/webhooks/stripe --file sandbox-event.json
python scripts/simulate_webhook.py --url http://localhost:3000/api/webhooks/stripe --file sandbox-event.json
~~~

Set STRIPE_WEBHOOK_SECRET or pass --secret. --file preserves the bytes and event ID, so run the same command twice for replay. --invalid-signature and --timestamp 1 exercise rejection. --event-id controls IDs for generated samples. Requests have a timeout. Dispatch exit codes: 0 HTTP 2xx; 1 non-2xx/network error; 2 invalid arguments/input.

Default generated events contain synthetic IDs and minimal fields; they do not create Stripe objects. They are useful for a signature receiver, not full fulfillment against Stripe's API. Use real sandbox event files matching your endpoint API version for that flow. HTTP 200 alone does not demonstrate signature verification or fulfillment.

## Executable reference and tests

Read [the Next.js/PostgreSQL guide](references/NEXTJS_APP_ROUTER.md) and [event matrix](references/EVENT_MATRIX.md). The implementation lives in examples/ and has no mock database. It supports one Stripe account/mode, snapshot events, subscription Checkout and database-backed Boolean access. Other payment/database/business models require adaptation.

The reference/tests need Node.js 24+ and npm dependencies (pg, stripe, TypeScript and test-only embedded PostgreSQL). The database test runner starts a temporary loopback-only PostgreSQL server, stops it on completion, and does not install a system service or create OS users. Platform binaries are downloaded by npm. Run as a normal user; root-only environments need an appropriately configured PostgreSQL test environment.

~~~sh
npm ci
npm run typecheck
npm test
~~~

To include Python parity and dispatcher checks, set PYTHON_BIN to a working Python executable before npm test. Without it those checks are marked skipped. The obsolete good_route.ts mock was replaced with executable tests:

- tests/linter.test.cjs: CLI outcomes, strings/comments, raw-body warning and Node/Python parity.
- tests/simulator.test.cjs: exact-byte signing/replay and invalid/stale signatures against the actual Stripe SDK.
- tests/payments.test.mts: real PostgreSQL transactions, concurrent independent connections, order/resource locks, rollback and access state. Stripe API resources are served by a local HTTP test server.

This is not a real Stripe CLI, Next.js build, cloud-deployment or live-account acceptance test. Follow the guide's sandbox deployment checks before using the copied code with customers.

MIT license; see LICENSE.
