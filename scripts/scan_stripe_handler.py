#!/usr/bin/env python3
"""Standard-library heuristic pattern linter; no control-flow or database proofs."""
import json
import re
import sys
from pathlib import Path

RULES = json.loads(Path(__file__).with_name('lint-rules.json').read_text(encoding='utf-8'))['rules']


def views(source):
    code, clean, i = [], [], 0
    def mask(s):
        return re.sub(r'[^\r\n]', ' ', s)
    while i < len(source):
        start = i
        if source.startswith('//', i) or source[i] == '#':
            while i < len(source) and source[i] != '\n':
                i += 1
            s = mask(source[start:i])
            code.append(s)
            clean.append(s)
        elif source.startswith('/*', i):
            end = source.find('*/', i + 2)
            i = len(source) if end < 0 else end + 2
            s = mask(source[start:i])
            code.append(s)
            clean.append(s)
        elif source[i] in ('"', "'", chr(96)):
            q = source[i]
            end = q * 3 if source.startswith(q * 3, i) else q
            i += len(end)
            while i < len(source):
                if source[i] == '\\':
                    i += 2
                    continue
                if source.startswith(end, i):
                    i += len(end)
                    break
                i += 1
            s = source[start:i]
            code.append(mask(s))
            clean.append(s)
        else:
            code.append(source[i])
            clean.append(source[i])
            i += 1
    return {'code': ''.join(code), 'clean': ''.join(clean)}


def inspect(file, source, framework, profile):
    v = views(source)
    handler = re.search(r'\b(?:POST|webhook|handler)\s*(?:\(|=|:)|\bexport\s*\{[^}]*\bPOST\b|\bdef\s+\w*webhook\w*\s*\(|\.post\s*\(', v['code'], re.I)
    if not handler and framework == 'auto' and not re.search(r'\b(?:whsec_|sk_live_|sk_test_|rk_live_|rk_test_)[A-Za-z0-9_]{20,}', source):
        return None
    if framework == 'auto':
        framework = 'fastapi' if file.endswith('.py') else 'pages' if '/pages/api/' in file.replace('\\', '/') else 'app'
    findings = []
    def add(rule, level, message, index=0):
        findings.append(dict(file=file, rule=rule, level=level, line=source[:index].count('\n') + 1, message=message))
    for m in re.finditer(r'\b(?:whsec_|sk_live_|sk_test_|rk_live_|rk_test_)[A-Za-z0-9_]{20,}', source):
        add('secret-like-literal', 'FAIL', 'Stripe-key-shaped text detected. Remove real secrets; test placeholders may be false positives.', m.start())
    for r in RULES:
        if r.get('frameworks') and framework not in r['frameworks']:
            continue
        m = re.search(r['pattern'], v[r.get('channel', 'code')], re.M)
        if (not m) if r.get('missing') else bool(m):
            add(r['id'], r['level'], r['message'], m.start() if m else 0)
    if 'checkout.session.completed' in v['clean']:
        m = re.search(r'\bpayment_status\b', v['clean'])
        add('payment-status-reference', 'FOUND' if m else 'WARN', 'payment_status text appears; comparison, mode and provisioning policy are unverified.' if m else 'Checkout completion text appears without payment_status. Inspect the fulfillment path.', m.start() if m else 0)
    if profile == 'subscription':
        for event in ('customer.subscription.created', 'customer.subscription.updated', 'customer.subscription.deleted', 'invoice.paid'):
            if event not in v['clean']:
                add('event-missing:' + event, 'WARN', 'Event text not in this file: ' + event + '. Check configured destinations and delegated handlers before adding it.')
    return findings


def main(args):
    target, framework, profile, strict, output_json = None, 'auto', 'none', False, False
    try:
        i = 0
        while i < len(args):
            a = args[i]
            if a in ('--help', '-h'):
                print('Usage: python scripts/scan_stripe_handler.py PATH [--framework auto|app|pages|express|fastapi] [--profile none|subscription] [--strict] [--json]\nExit: 0 complete; 1 findings (FAIL, or WARN with --strict); 2 input/read error or no eligible handlers.')
                return 0
            if a == '--strict':
                strict = True
            elif a == '--json':
                output_json = True
            elif a in ('--framework', '--profile'):
                i += 1
                if i >= len(args):
                    raise ValueError('Missing value for ' + a)
                if a == '--framework':
                    framework = args[i]
                else:
                    profile = args[i]
            elif a.startswith('-'):
                raise ValueError('Unknown option: ' + a)
            elif target is None:
                target = a
            else:
                raise ValueError('Only one target is supported')
            i += 1
        if not target:
            raise ValueError('PATH is required (see --help)')
        if framework not in ('auto', 'app', 'pages', 'express', 'fastapi'):
            raise ValueError('Invalid framework')
        if profile not in ('none', 'subscription'):
            raise ValueError('Invalid profile')
        files = []
        def walk(p):
            if p.is_symlink():
                return
            if p.is_dir():
                for child in sorted(p.iterdir()):
                    if child.name not in ('node_modules', '.git', '.next', 'venv', '.venv', '__pycache__'):
                        walk(child)
            elif p.is_file() and re.search(r'\.(?:[cm]?[jt]s|tsx|py)$', p.name):
                files.append(p)
            elif not p.exists():
                raise FileNotFoundError('Target path does not exist: ' + str(p))
        walk(Path(target).resolve())
        scanned, findings, skipped_files = 0, [], []
        for file in files:
            result = inspect(str(file), file.read_text(encoding='utf-8'), framework, profile)
            if result is not None:
                scanned += 1
                findings.extend(result)
            else:
                skipped_files.append(str(file))
        if not scanned:
            raise ValueError('No eligible handler source files found')
        if output_json:
            print(json.dumps(dict(filesScanned=scanned, skippedFiles=skipped_files, findings=findings)))
        else:
            print('Stripe webhook heuristic lint: ' + str(scanned) + ' file(s), ' + str(len(skipped_files)) + ' helper/source file(s) skipped')
            for file in skipped_files:
                print('[SKIPPED] ' + file + ': no local handler pattern; imports are not resolved. Use --framework to inspect this file explicitly.')
            for f in findings:
                print('[{level}] {file}:{line} {rule}: {message}'.format(**f))
            print('Pattern observations only. No syntax, signature, transaction, idempotency or concurrency guarantee.')
        return 1 if any(f['level'] == 'FAIL' or strict and f['level'] == 'WARN' for f in findings) else 0
    except (OSError, UnicodeError, ValueError) as error:
        if output_json:
            print(json.dumps(dict(error=str(error))))
        else:
            print('[ERROR] ' + str(error), file=sys.stderr)
        return 2


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
