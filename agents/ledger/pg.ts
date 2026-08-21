/**
 * The `LedgerStore` over PostgreSQL: the implementation the chokepoint runs against in CI and on
 * the deployment target.
 *
 * **It writes as `app_rw`, under the tenant's claims, exactly like the consoles do.** Not because
 * the gateway is a console, but because the alternative is worse in a specific way: a writer that
 * connected as the owner would insert rows the policy `ledger_writer_insert` never had to accept,
 * and every isolation test in the repository would then be measuring a world the ledger writer does
 * not live in. Writing through the policy is what makes the policy load-bearing.
 *
 * **The claim set carries `org_id` and nothing else.** The two policies on `ledger_entry` read
 * `org_id` and no other claim, so that is what is set. A gateway that also asserted a `role` and a
 * `sub` would be handing itself the claims that open the *ticket* policies — access it has no
 * business having and no need for. What it cannot see, it cannot leak.
 *
 * **The retry is the mechanism, not a nicety.** Two writers on the same run read the same head and
 * both build a row that claims it. The unique index `ledger_one_child_per_head` lets exactly one of
 * them in and rejects the other; the trigger's advisory lock narrows the window but does not close
 * it, because the head is read before the lock is taken. So the loser re-reads the head, rebuilds
 * its row against the new one, and tries again. The row content is rebuilt rather than reused: `seq`
 * and `cum_tokens` both count from the head, so a row that kept them would be wrong in a way no
 * constraint would catch.
 *
 * **One limitation, named where it bites.** The head read and the consumption sum run under the
 * policies, so both see one organisation's rows. `ledger_link()` is `security definer` and reads the
 * true head across tenants, which is exactly why a run whose rows belong to two organisations would
 * have the writer proposing a `prev_hash` the trigger rejects, indefinitely. Single-tenant runs —
 * every run this increment can produce — are unaffected. The general case wants
 * `ledger_run_head(run_id)` and `ledger_run_cost(run_id)` as `security definer` accessors, which is
 * a migration, and migrations are frozen scope.
 */

import { Pool } from 'pg';
import type { Pool as PgPool, PoolClient } from 'pg';

import { canonicalJson } from '../canonical.ts';
import type { Json } from '../canonical.ts';
import { linkRow } from './row.ts';
import type { ChainedRow, LedgerRowContent } from './row.ts';
import type {
  AppendedRow,
  BudgetScope,
  CacheProbe,
  CachedCall,
  LedgerHead,
  LedgerStore,
} from './store.ts';

const APPLICATION_ROLE = 'app_rw';

/** How many times a writer will lose the head before it reports the chain as unextendable. */
const APPEND_ATTEMPTS = 6;

const INSERT = `
  insert into ledger_entry (
    run_id, seq, org_id, ticket_id, agent, prompt_version_id,
    model_requested, model_returned, sampling, seed,
    input_hash, input_path, prompt_hash, response_hash, state_hash,
    split_id, toolchain, restarts,
    tokens_in, tokens_out, cost_aud, latency_ms, cum_tokens,
    class, output, confidence, ts, prev_hash, row_hash)
  values (
    $1::uuid, $2::bigint, $3::uuid, $4::uuid, $5::agent_kind, $6::uuid,
    $7, $8, $9::jsonb, $10::bigint,
    $11, $12, $13, $14, $15,
    $16::uuid, $17::jsonb, $18::int,
    $19::int, $20::int, $21::numeric, $22::int, $23::bigint,
    $24::ledger_class, $25::jsonb, $26::numeric, $27::timestamptz, $28, $29)
  returning id, seq, prev_hash, row_hash`;

const HEAD = `
  select seq, row_hash, cum_tokens
    from ledger_entry
   where run_id = $1::uuid
   order by seq desc
   limit 1`;

const SPENT = `
  select coalesce(sum(cost_aud), 0)::text as total
    from ledger_entry
   where ($1::uuid is null or run_id = $1::uuid)`;

/**
 * The cache lookup. Ordered by `id`, which is the order the rows were written in across every run
 * — `seq` counts within a run and would order two runs by nothing at all. A row that was itself
 * served from the cache is excluded, so the answer always comes from the call that really happened
 * and the provenance never becomes a chain of copies.
 */
const CACHED = `
  select seq, model_returned, response_hash, tokens_in, tokens_out, confidence,
         output ->> 'response' as response_text
    from ledger_entry
   where class = 'agent_call'
     and input_hash = $1
     and prompt_version_id = $2::uuid
     and prompt_hash = $3
     and model_requested = $4
     and sampling = $5::jsonb
     and seed is not distinct from $6::bigint
     and output ? 'response'
     and coalesce((output -> 'cache' ->> 'hit')::boolean, false) = false
   order by id asc
   limit 1`;

/**
 * `numeric` arrives as text from the driver, and it stays text until it is turned into an integer
 * number of millionths. Parsing it as a float first and multiplying would reintroduce exactly the
 * drift the integer representation exists to avoid.
 */
export function microFromNumericText(text: string): number {
  const trimmed = text.trim();
  const negative = trimmed.startsWith('-');
  const digits = negative ? trimmed.slice(1) : trimmed;
  const [whole, fraction = ''] = digits.split('.');
  if (!/^\d*$/.test(whole) || !/^\d*$/.test(fraction)) {
    throw new TypeError(`microFromNumericText: '${text}' is not a decimal`);
  }
  const scaled = Number(whole || '0') * 1_000_000 + Number(fraction.slice(0, 6).padEnd(6, '0') || '0');
  return negative ? -scaled : scaled;
}

/**
 * A row as the driver hands it back, turned into the form the writer hashed.
 *
 * This is the only conversion in the tree, and it exists so that verification is possible at all: a
 * digest is taken over text, the driver returns `bigint` columns as strings, `numeric` columns as
 * strings, `timestamptz` as a `Date` and `jsonb` as an object, and none of those is the form the
 * digest was taken over. The three that need care are named where they are converted.
 */
export function rowFromDatabase(record: Record<string, unknown>): ChainedRow {
  const asNumber = (value: unknown): number => Number(value);
  const asNullableNumber = (value: unknown): number | null =>
    value === null || value === undefined ? null : Number(value);

  return {
    run_id: record.run_id as string,
    seq: asNumber(record.seq),
    org_id: record.org_id as string,
    ticket_id: (record.ticket_id ?? null) as string | null,
    agent: record.agent as ChainedRow['agent'],
    prompt_version_id: (record.prompt_version_id ?? null) as string | null,
    model_requested: (record.model_requested ?? null) as string | null,
    model_returned: (record.model_returned ?? null) as string | null,
    sampling: (record.sampling ?? null) as Json | null,
    seed: asNullableNumber(record.seed),
    input_hash: (record.input_hash ?? null) as string | null,
    input_path: (record.input_path ?? null) as string | null,
    prompt_hash: (record.prompt_hash ?? null) as string | null,
    response_hash: (record.response_hash ?? null) as string | null,
    state_hash: record.state_hash as string,
    split_id: (record.split_id ?? null) as string | null,
    toolchain: record.toolchain as Json,
    restarts: asNumber(record.restarts),
    tokens_in: asNumber(record.tokens_in),
    tokens_out: asNumber(record.tokens_out),
    // `numeric` already arrives as text at the scale the column declares — `0.001000`, not `0.001`
    // — which is exactly the string that was hashed. Turning it into a float and back would not be.
    cost_aud: record.cost_aud as string,
    latency_ms: asNumber(record.latency_ms),
    cum_tokens: asNumber(record.cum_tokens),
    class: record.class as ChainedRow['class'],
    output: record.output as Json,
    confidence: (record.confidence ?? null) as string | null,
    // The writer supplied this instant with millisecond precision; rendering it back the same way
    // is what makes the digest recomputable.
    ts: new Date(record.ts as string | Date).toISOString(),
    prev_hash: record.prev_hash as string,
    row_hash: record.row_hash as string,
  };
}

function isChainConflict(error: unknown): boolean {
  const candidate = error as { code?: string; message?: string };
  if (candidate?.code === '23505') return true; // one child per head, or (run_id, seq)
  return typeof candidate?.message === 'string' && candidate.message.includes('E_LEDGER_CHAIN_BROKEN');
}

export type PgLedgerStoreOptions = {
  connectionString: string;
  max?: number;
};

export class PgLedgerStore implements LedgerStore {
  readonly #pool: PgPool;

  constructor(options: PgLedgerStoreOptions) {
    this.#pool = new Pool({
      connectionString: options.connectionString,
      max: options.max ?? 4,
      idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 5_000,
    });
    this.#pool.on('error', (error) => {
      console.error('[gateway/ledger] idle client error:', error.message);
    });
  }

  async #withTenant<T>(orgId: string, work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.#pool.connect();
    try {
      await client.query('begin');
      await client.query(`set local role ${APPLICATION_ROLE}`);
      await client.query('select set_config($1, $2, true)', [
        'request.jwt.claims',
        JSON.stringify({ org_id: orgId }),
      ]);
      const result = await work(client);
      await client.query('commit');
      return result;
    } catch (error) {
      await client.query('rollback').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async append(
    runId: string,
    orgId: string,
    build: (head: LedgerHead | null) => LedgerRowContent,
  ): Promise<AppendedRow> {
    let lastError: unknown = null;

    for (let attempt = 0; attempt < APPEND_ATTEMPTS; attempt += 1) {
      try {
        return await this.#withTenant(orgId, async (client) => {
          const headResult = await client.query<{
            seq: string;
            row_hash: string;
            cum_tokens: string;
          }>(HEAD, [runId]);

          const headRow = headResult.rows[0];
          const head: LedgerHead | null = headRow
            ? {
                seq: Number(headRow.seq),
                row_hash: headRow.row_hash,
                cum_tokens: Number(headRow.cum_tokens),
              }
            : null;

          const row = linkRow(build(head), head);

          const inserted = await client.query<{
            id: string;
            seq: string;
            prev_hash: string;
            row_hash: string;
          }>(INSERT, [
            row.run_id,
            row.seq,
            row.org_id,
            row.ticket_id,
            row.agent,
            row.prompt_version_id,
            row.model_requested,
            row.model_returned,
            row.sampling === null ? null : canonicalJson(row.sampling),
            row.seed,
            row.input_hash,
            row.input_path,
            row.prompt_hash,
            row.response_hash,
            row.state_hash,
            row.split_id,
            canonicalJson(row.toolchain),
            row.restarts,
            row.tokens_in,
            row.tokens_out,
            row.cost_aud,
            row.latency_ms,
            row.cum_tokens,
            row.class,
            canonicalJson(row.output),
            row.confidence,
            row.ts,
            row.prev_hash,
            row.row_hash,
          ]);

          const written = inserted.rows[0];
          return {
            id: written.id,
            seq: Number(written.seq),
            prev_hash: written.prev_hash,
            row_hash: written.row_hash,
            ts: row.ts,
          };
        });
      } catch (error) {
        if (!isChainConflict(error)) throw error;
        lastError = error;
      }
    }

    throw lastError ?? new Error('append: the chain could not be extended');
  }

  async spentMicroAud(orgId: string, scope: BudgetScope): Promise<number> {
    return this.#withTenant(orgId, async (client) => {
      const result = await client.query<{ total: string }>(SPENT, [scope.run_id]);
      return microFromNumericText(result.rows[0]?.total ?? '0');
    });
  }

  async findCached(orgId: string, probe: CacheProbe): Promise<CachedCall | null> {
    return this.#withTenant(orgId, async (client) => {
      const result = await client.query<{
        seq: string;
        model_returned: string;
        response_hash: string;
        tokens_in: number;
        tokens_out: number;
        confidence: string | null;
        response_text: string | null;
      }>(CACHED, [
        probe.input_hash,
        probe.prompt_version_id,
        probe.prompt_hash,
        probe.model_requested,
        canonicalJson(probe.sampling),
        probe.seed,
      ]);

      const row = result.rows[0];
      if (!row || row.response_text === null) return null;

      return {
        seq: Number(row.seq),
        model_returned: row.model_returned,
        response_hash: row.response_hash,
        response_text: row.response_text,
        tokens_in: Number(row.tokens_in),
        tokens_out: Number(row.tokens_out),
        confidence: row.confidence,
      };
    });
  }

  async close(): Promise<void> {
    await this.#pool.end();
  }
}
