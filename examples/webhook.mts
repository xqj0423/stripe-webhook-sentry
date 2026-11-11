import type {Pool} from 'pg';
import Stripe from 'stripe';
import {processEvent} from './process-event.mts';

export function createWebhookHandler(pool: Pool, stripe: Stripe, secret: string, expectLive: boolean) {
  if (!secret) throw new Error('STRIPE_WEBHOOK_SECRET is required');
  return async function POST(req: Request): Promise<Response> {
    const signature = req.headers.get('stripe-signature');
    if (!signature) return Response.json({error:'Missing signature'},{status:400});
    let event: Stripe.Event;
    try {
      const rawBody = await req.text();
      event = stripe.webhooks.constructEvent(rawBody,signature,secret);
    } catch {
      return Response.json({error:'Invalid webhook signature or body'},{status:400});
    }
    if (event.api_version !== Stripe.API_VERSION || event.livemode !== expectLive || event.account || event.context) {
      // This endpoint expects these events to be processable. Acknowledge only
      // deliberately irrelevant events; do not hide a broken version/destination
      // configuration as successful delivery. Repair it and replay failed events.
      console.error('Webhook endpoint configuration mismatch', {
        eventId:event.id, apiVersion:event.api_version, expectedApiVersion:Stripe.API_VERSION,
        livemode:event.livemode, expectedLivemode:expectLive,
        connectedAccount:!!event.account, organizationContext:!!event.context,
      });
      return Response.json({error:'Endpoint configuration mismatch; inspect server logs',code:'endpoint_configuration_mismatch'},{status:400});
    }
    try {
      const result = await processEvent(pool,stripe,event);
      return Response.json({received:true,result});
    } catch (error) {
      console.error('Webhook processing failed',event.id,error);
      return Response.json({error:'Processing failed; retry requested'},{status:500});
    }
  };
}
