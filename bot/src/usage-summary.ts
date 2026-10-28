import type { DatabaseSync, StatementSync } from "node:sqlite";
import type { UsageEntry, UsageTotal } from "./usage.js";

/** Incremental project rollups; every change runs in the ledger transaction. */
export class UsageSummaries {
  private readonly cache = new WeakMap<DatabaseSync, { total: StatementSync; model: StatementSync; cleanTotal: StatementSync; cleanModel: StatementSync }>();

  static create(db: DatabaseSync): void {
    db.exec(`CREATE TABLE IF NOT EXISTS usage_thread_totals (
      thread_id TEXT PRIMARY KEY, entries INTEGER NOT NULL, turns INTEGER NOT NULL, failed_turns INTEGER NOT NULL,
      input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL, cache_tokens INTEGER NOT NULL,
      cost REAL NOT NULL, catalog_cost REAL NOT NULL, priced_entries INTEGER NOT NULL, catalog_priced_entries INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS usage_thread_models (
        thread_id TEXT NOT NULL, model TEXT NOT NULL, entries INTEGER NOT NULL, turns INTEGER NOT NULL,
        input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL, cache_tokens INTEGER NOT NULL,
        cost REAL NOT NULL, catalog_cost REAL NOT NULL, comparisons INTEGER NOT NULL,
        unreported INTEGER NOT NULL, catalog_estimated INTEGER NOT NULL, priced_entries INTEGER NOT NULL,
        catalog_priced_entries INTEGER NOT NULL, PRIMARY KEY(thread_id, model));`);
  }

  adjust(db: DatabaseSync, entry: UsageEntry, direction: 1 | -1): void {
    let queries = this.cache.get(db);
    if (!queries) {
      queries = {
        total: db.prepare(`INSERT INTO usage_thread_totals VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(thread_id) DO UPDATE SET entries=entries+excluded.entries, turns=turns+excluded.turns,
            failed_turns=failed_turns+excluded.failed_turns, input_tokens=input_tokens+excluded.input_tokens,
            output_tokens=output_tokens+excluded.output_tokens, cache_tokens=cache_tokens+excluded.cache_tokens,
            cost=CASE WHEN priced_entries+excluded.priced_entries=0 THEN 0 ELSE cost+excluded.cost END,
            catalog_cost=CASE WHEN catalog_priced_entries+excluded.catalog_priced_entries=0 THEN 0 ELSE catalog_cost+excluded.catalog_cost END,
            priced_entries=priced_entries+excluded.priced_entries, catalog_priced_entries=catalog_priced_entries+excluded.catalog_priced_entries`),
        model: db.prepare(`INSERT INTO usage_thread_models VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(thread_id, model) DO UPDATE SET entries=entries+excluded.entries, turns=turns+excluded.turns,
            input_tokens=input_tokens+excluded.input_tokens, output_tokens=output_tokens+excluded.output_tokens,
            cache_tokens=cache_tokens+excluded.cache_tokens,
            cost=CASE WHEN priced_entries+excluded.priced_entries=0 THEN 0 ELSE cost+excluded.cost END,
            catalog_cost=CASE WHEN catalog_priced_entries+excluded.catalog_priced_entries=0 THEN 0 ELSE catalog_cost+excluded.catalog_cost END,
            comparisons=comparisons+excluded.comparisons, unreported=unreported+excluded.unreported,
            catalog_estimated=catalog_estimated+excluded.catalog_estimated, priced_entries=priced_entries+excluded.priced_entries,
            catalog_priced_entries=catalog_priced_entries+excluded.catalog_priced_entries`),
        cleanTotal: db.prepare("DELETE FROM usage_thread_totals WHERE thread_id = ? AND entries = 0"),
        cleanModel: db.prepare("DELETE FROM usage_thread_models WHERE thread_id = ? AND model = ? AND entries = 0"),
      };
      this.cache.set(db, queries);
    }
    const models = entry.models ?? [];
    const catalogCost = models.reduce((sum, model) => sum + (model.catalogCost ?? 0), 0);
    queries.total.run(entry.threadId, direction, direction,
      direction * (entry.failed ? 1 : 0), direction * entry.inputTokens,
      direction * entry.outputTokens, direction * entry.cacheTokens, direction * entry.cost,
      direction * catalogCost, direction * (entry.cost > 0 ? 1 : 0), direction * (catalogCost > 0 ? 1 : 0));
    for (const model of models) {
      queries.model.run(entry.threadId, model.model, direction, direction,
        direction * model.inputTokens, direction * model.outputTokens, direction * model.cacheTokens,
        direction * model.cost, direction * (model.catalogCost ?? 0), direction * (model.catalogCost !== undefined ? 1 : 0),
        direction * (!model.reported ? 1 : 0), direction * (!model.reported && !model.marketEstimated ? 1 : 0),
        direction * (model.cost > 0 ? 1 : 0), direction * ((model.catalogCost ?? 0) > 0 ? 1 : 0));
      if (direction < 0) queries.cleanModel.run(entry.threadId, model.model);
    }
    if (direction < 0) queries.cleanTotal.run(entry.threadId);
  }

  read(db: DatabaseSync, threadId: string): UsageTotal & { lastTs?: string } {
    const row = db.prepare("SELECT * FROM usage_thread_totals WHERE thread_id = ?").get(threadId);
    if (!row) return { turns: 0, failedTurns: 0, inputTokens: 0, outputTokens: 0, cacheTokens: 0, cost: 0, catalogCost: 0, models: new Map() };
    const models: UsageTotal["models"] = new Map();
    for (const item of db.prepare("SELECT * FROM usage_thread_models WHERE thread_id = ?").all(threadId)) {
      const model = String(item.model);
      models.set(model, { model, turns: Number(item.turns), inputTokens: Number(item.input_tokens),
        outputTokens: Number(item.output_tokens), cacheTokens: Number(item.cache_tokens), cost: Number(item.priced_entries) > 0 ? Number(item.cost) : 0,
        ...(Number(item.comparisons) > 0 ? { catalogCost: Number(item.catalog_priced_entries) > 0 ? Number(item.catalog_cost) : 0 } : {}),
        ...(Number(item.unreported) > 0 ? { unreported: true as const } : { reported: true as const }),
        ...(Number(item.catalog_estimated) > 0 ? { catalogEstimated: true as const } : {}) });
    }
    const latest = db.prepare("SELECT ts FROM usage_entries WHERE thread_id = ? ORDER BY ts DESC, id DESC LIMIT 1").get(threadId);
    return { turns: Number(row.turns), failedTurns: Number(row.failed_turns), inputTokens: Number(row.input_tokens),
      outputTokens: Number(row.output_tokens), cacheTokens: Number(row.cache_tokens), cost: Number(row.priced_entries) > 0 ? Number(row.cost) : 0,
      catalogCost: Number(row.catalog_priced_entries) > 0 ? Number(row.catalog_cost) : 0, models, ...(latest ? { lastTs: String(latest.ts) } : {}) };
  }
}
