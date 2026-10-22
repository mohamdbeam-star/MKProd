"""Counts captured test emails: mail_check.py <dir> <to> <subject substring> [body substring]"""
import sys, os, email
from email import policy
d, to, subj = sys.argv[1], sys.argv[2], sys.argv[3]
body_needle = sys.argv[4] if len(sys.argv) > 4 else None
n = 0
for f in sorted(os.listdir(d)) if os.path.isdir(d) else []:
    m = email.message_from_bytes(open(os.path.join(d, f), 'rb').read(), policy=policy.default)
    if to not in str(m['To']) or subj not in str(m['Subject']): continue
    if body_needle and body_needle not in m.get_body(('plain',)).get_content(): continue
    n += 1
print(n)
