#!/usr/bin/env python3
"""HMAC smoke-test dispatcher. Mock objects are not real Stripe resources."""
import argparse
import hashlib
import hmac
import json
import math
import os
from pathlib import Path
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid


def signature(payload, secret, timestamp):
    digest = hmac.new(secret.encode('utf-8'), str(timestamp).encode('ascii') + b'.' + payload, hashlib.sha256).hexdigest()
    return 't={},v1={}'.format(timestamp, digest)


def main():
    parser = argparse.ArgumentParser(description='Send signed mock events. --file preserves exact payload bytes and event ID for replay; mocks do not exist in Stripe.')
    parser.add_argument('--url', default='http://localhost:3000/api/webhooks/stripe')
    parser.add_argument('--secret', default=os.environ.get('STRIPE_WEBHOOK_SECRET', 'whsec_test_secret_for_local_dev'))
    parser.add_argument('--event', default='checkout.session.completed')
    parser.add_argument('--file')
    parser.add_argument('--event-id')
    parser.add_argument('--timestamp', type=int, default=int(time.time()))
    parser.add_argument('--invalid-signature', action='store_true')
    parser.add_argument('--timeout', type=float, default=10)
    args = parser.parse_args()
    if args.timestamp < 0 or not math.isfinite(args.timeout) or args.timeout <= 0:
        parser.error('Invalid timestamp or timeout')
    if args.file and args.event_id:
        parser.error('--file cannot be combined with --event-id')
    if urllib.parse.urlparse(args.url).scheme not in ('http', 'https'):
        parser.error('Use http or https')
    try:
        if args.file:
            payload = Path(args.file).read_bytes()
            json.loads(payload)
        else:
            samples = json.loads(Path(__file__).with_name('sample-events.json').read_text(encoding='utf-8'))
            if args.event not in samples:
                raise ValueError('Unsupported mock event type')
            payload = json.dumps(dict(id=args.event_id or 'evt_local_' + str(uuid.uuid4()), object='event', created=int(time.time()), livemode=False, type=args.event, data=dict(object=samples[args.event])), indent=2).encode('utf-8')
    except (OSError, ValueError) as error:
        print('[ERROR] ' + str(error), file=sys.stderr)
        return 2
    header = signature(payload, args.secret, args.timestamp)
    if args.invalid_signature:
        header = header[:-1] + ('1' if header[-1] == '0' else '0')
    request = urllib.request.Request(args.url, data=payload, method='POST', headers={'Content-Type': 'application/json', 'Stripe-Signature': header})
    try:
        with urllib.request.urlopen(request, timeout=args.timeout) as response:
            print('HTTP ' + str(response.status))
            return 0 if 200 <= response.status < 300 else 1
    except (OSError, urllib.error.URLError) as error:
        print('Dispatch failed: ' + str(error), file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
