# Expected schema

`schema.sql` is the committed record of the schema the migration set produces on a clean
database: the schema-only dump, comments and blank lines stripped, of a database built by
applying `migrations/0001..000n` in order.

`ci/db_check.sh` diffs the applied schema against this file in both directions. An object of the
record missing from the database fails the build, and so does an object of the database missing
from the record; there is no exception list.

To generate or refresh it, run the checks against a disposable cluster with

```
LEDGERDESK_WRITE_EXPECTED=yes bash ci/db_check.sh
```

and review the diff before committing. Generate it with the same `pg_dump` version CI uses — the
CI job is the arbiter if a local client disagrees.
