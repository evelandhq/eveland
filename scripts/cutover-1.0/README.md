# 1.0 cutover kit

A one-off kit for moving the existing Eveland installation onto 1.0. It is not
part of the product: no platform code imports anything here, and this
directory is deleted once the cutover is done.

## `reseal-secrets.ts`

Re-seals every value sealed with `APP_SECRET_KEY` into the single versioned
envelope the 1.0 platform reads (`packages/core/src/server/sealed-secret.ts`).
The 1.0 platform has no reader for the earlier formats, so run this before
starting 1.0 against an existing database.

```bash
# Platform processes stopped, database backed up. Dry run first:
APP_SECRET_KEY=... DATABASE_URL=postgres://... node scripts/cutover-1.0/reseal-secrets.ts
# Then commit:
APP_SECRET_KEY=... DATABASE_URL=postgres://... node scripts/cutover-1.0/reseal-secrets.ts --apply
```

It covers Project Secrets, the shared Agent environment, Git credentials
(including pending source preflights and queued import jobs), external
observability destinations, Agent Connection config, credentials, and OIDC
transactions, Identity Provider client secrets, Identity login transactions,
and Identity signing keys. It prints counts per table and never prints a
sealed or opened value. Everything runs in one transaction; a dry run rolls
back, and a value that cannot be opened aborts the run unless
`--allow-unreadable` is given. Re-running after `--apply` changes nothing.
