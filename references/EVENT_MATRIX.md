# Event selection and recovery

Select events for the application's payment model. A one-time payment endpoint does not need every subscription handler. Snapshot and thin events have different payload/verification APIs; the bundled executable example supports the pinned snapshot version only.

| Event | Decision in this example | Important boundary |
| --- | --- | --- |
| checkout.session.completed | Lock the registered order and fetch the current Session. | Completion alone is not payment or proof of subscription access. |
| checkout.session.async_payment_succeeded | Reconcile that same Session/order under its row lock. | Distinct event IDs must not cause a second fulfillment. |
| checkout.session.async_payment_failed | Preserve fulfilled status; otherwise reconcile/mark failure. | Missing order is an error. A late unpaid completion cannot reset a failed order to pending. |
| customer.subscription.created / updated / deleted / paused / resumed | Lock the subscription ID before fetching/writing its current status. | Access is computed per subscription; cancellation of an old subscription cannot disable a different new one. |
| invoice.paid / invoice.payment_failed | Resolve the subscription ID from the pinned invoice shape and run the same synchronization path. | A past failed invoice must not directly overwrite current subscription state with past_due. Standalone non-subscription invoices are intentionally ignored. |
| Other events | Acknowledge as ignored. | Implement refunds, disputes, entitlements or other business events explicitly when required. |

## Payment states

- paid: the Session can be fulfilled according to its mode and product policy. It is not an irrevocable settlement/refund guarantee.
- no_payment_required: no payment is due. Provision only if the server-owned order policy permits that free/trial purchase; preserve actual subscription status such as trialing.
- unpaid: no paid entitlement is authorized. Wait for a later successful payment event when supporting delayed payment methods. Do not infer the exact payment method from this status alone.

## Required failure cases to exercise

- Invalid/missing/expired signature: no database effects.
- Same event delivered concurrently: one committed receipt; failed processing remains retryable.
- Different event IDs for the same Session: one fulfilled order, no repeated business effect.
- A business-table primary/unique-key failure: processing failure, not a duplicate acknowledgment.
- Order/customer missing or mismatched: roll back receipt and repair mapping before replay.
- Async failure before completion; unpaid completion after success: no order regression.
- Two workers synchronize one subscription: obtain the resource lock before either fetch.
- Old subscription canceled while a new subscription is active: access still reflects the new subscription.
- Free/trial checkout with policy enabled and disabled: observe distinct outcomes.

## Scope of the guarantees

Stripe retries failed deliveries for a finite time; it does not guarantee every application mutation eventually succeeds. Retain failure visibility and recovery procedures. event.created has second precision and is not a resource version. A live API read is a snapshot, not cross-service atomicity. Database transactions cover only the database mutations within them. For remote effects, a tested outbox and effect-specific idempotency are separate application work.

Sources: [Stripe webhooks](https://docs.stripe.com/webhooks), [Checkout fulfillment](https://docs.stripe.com/checkout/fulfillment?ui=full-page), [delivery recovery](https://docs.stripe.com/events/manage-webhook-endpoints).
