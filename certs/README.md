# certs

`supabase-root-2021-ca.pem` is the trust anchor that lets Node verify TLS to the Supabase
session pooler.

## Why this file exists

The pooler host in `DATABASE_URL` (form `aws-<zone>-<region>.pooler.supabase.com`, port 5432)
presents this chain:

```
leaf     *.pooler.supabase.com        issued by Supabase Intermediate 2021 CA
intermed Supabase Intermediate 2021 CA issued by Supabase Root 2021 CA
root     Supabase Root 2021 CA         self-signed
```

Supabase runs its own private certificate authority, and that root is in neither Node's bundled
CA store nor the Windows certificate store on this machine. `src/mastra/storage.ts` deliberately
sets `rejectUnauthorized: true` for every non-loopback host, so verification fails on a chain Node
genuinely cannot trust. The observable symptom is that every conversation and thread read answers
`503` or `500` with detail `self-signed certificate in certificate chain`, while the CRM routes
look healthy because `src/db/client.ts` passes no `ssl` option at all and negotiates plaintext.

## How it is wired

Node reads `NODE_EXTRA_CA_CERTS` during bootstrap, so it must be present in the process
environment before the process starts. Putting it in `.env` does not work, because the repo's own
env loading runs later. It is set at Windows **User** scope on this machine:

```powershell
[Environment]::SetEnvironmentVariable('NODE_EXTRA_CA_CERTS', 'D:/Code/CRUM/certs/supabase-root-2021-ca.pem', 'User')
```

Terminals opened before that change do not carry it, so existing shells and processes need a
restart. To undo it:

```powershell
[Environment]::SetEnvironmentVariable('NODE_EXTRA_CA_CERTS', $null, 'User')
```

Verified on 2026-10-26 against the live pooler. With the variable in the process environment,
`GET /api/agent/threads` returns `200` and a raw `pg` client configured with
`ssl: { rejectUnauthorized: true }` connects. With it absent, both fail with
`SELF_SIGNED_CERT_IN_CHAIN`.

## Provenance and its limit

The PEM was extracted from the live pooler handshake on this machine, so it is trust on first use.
Its SHA-256 fingerprint is:

```
80:70:25:AD:50:D4:ED:21:9D:2C:9C:7D:29:9C:00:4F:82:4E:B0:0C:F7:F6:5A:FE:F6:07:D0:7B:72:E6:CA:FA
```

No independent published fingerprint for `Supabase Root 2021 CA` was findable to check that against,
and Supabase's own docs point you at the dashboard download. To upgrade this to a verified anchor,
open Project Settings, then Database, then the SSL Configuration section, download the certificate,
and compare its fingerprint to the value above before replacing the file.

## Never do this instead

Do not set `MASTRA_PG_SSL=false` and do not set `rejectUnauthorized: false`. Both turn off the check
rather than supplying the missing trust anchor, and the code comment in `src/mastra/storage.ts` says
so explicitly. Copying `src/db/client.ts`'s missing `ssl` option is worse still, since that sends the
`DATABASE_URL` credentials and every customer row over an unencrypted link.
