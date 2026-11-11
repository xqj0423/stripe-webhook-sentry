-- PostgreSQL; apply to an isolated database before running this example.
CREATE TABLE app_users (
  user_id text PRIMARY KEY,
  stripe_customer_id text NOT NULL UNIQUE,
  UNIQUE(user_id,stripe_customer_id)
);
CREATE TABLE processed_events (
  event_id text PRIMARY KEY,
  event_type text NOT NULL,
  processed_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE subscriptions (
  subscription_id text PRIMARY KEY,
  user_id text NOT NULL,
  stripe_customer_id text NOT NULL,
  status text NOT NULL DEFAULT 'unknown',
  price_ids jsonb NOT NULL DEFAULT '[]',
  synced_at timestamptz,
  FOREIGN KEY(user_id,stripe_customer_id) REFERENCES app_users(user_id,stripe_customer_id)
);
CREATE TABLE checkout_orders (
  session_id text PRIMARY KEY,
  user_id text NOT NULL,
  stripe_customer_id text NOT NULL,
  subscription_id text REFERENCES subscriptions(subscription_id),
  allow_no_payment boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'pending_payment'
    CHECK (status IN ('pending_payment','fulfilled','payment_failed','awaiting_approval')),
  FOREIGN KEY(user_id,stripe_customer_id) REFERENCES app_users(user_id,stripe_customer_id)
);
-- Access is per subscription; status alone does not fulfill an order.
CREATE VIEW user_subscription_access AS
SELECT u.user_id, EXISTS (
  SELECT 1 FROM subscriptions s
  JOIN checkout_orders o ON o.subscription_id = s.subscription_id
    AND o.user_id = s.user_id AND o.status = 'fulfilled'
  WHERE s.user_id = u.user_id AND s.status IN ('active','trialing')
) AS has_access FROM app_users u;
