import path from "node:path";
import type { UUID } from "node:crypto";

import { z } from "zod";

import { contentHash, readJsonArray } from "../lib/utils";
import { supabaseService } from "../lib/supabase-client";
import { traderIdEnumSchema } from "./traders";

const BATCH_SIZE = 100;

const tradeSchema = z.object({
	traderId: traderIdEnumSchema,
	itemId: z.string(),
	quantity: z.number(),
	cost: z.object({
		itemId: z.string(),
		quantity: z.number(),
	}),
	dailyLimit: z.number().nullable(),
});

type RawTrade = z.infer<typeof tradeSchema>;

interface TradeRow {
	trader_id: UUID;
	item_id: UUID;
	quantity: number;
	cost_item_id: UUID;
	cost_quantity: number;
	daily_limit: number | null;
	content_hash: string;
	source_json: RawTrade;
}

interface LookupMaps {
	items: Map<string, UUID>;
	traders: Map<string, UUID>;
}

export async function upsertTrades(
	baseDir: string,
	lookups: LookupMaps,
): Promise<void> {
	const file = path.join(baseDir, "trades.json");
	const trades = readJsonArray(file, tradeSchema);

	if (!trades || trades.length === 0) {
		console.warn("[Trades] no trades found or failed to parse");
		return;
	}

	console.log(`[Trades] found ${trades.length} trades`);

	const missingTraders = new Set<string>();
	const missingItems = new Set<string>();

	for (const t of trades) {
		if (!lookups.traders.has(t.traderId)) {
			missingTraders.add(t.traderId);
		}
		if (!lookups.items.has(t.itemId)) {
			missingItems.add(t.itemId);
		}
		if (!lookups.items.has(t.cost.itemId)) {
			missingItems.add(t.cost.itemId);
		}
	}

	if (missingTraders.size > 0) {
		console.warn(`[Trades] missing traders: ${[...missingTraders].join(", ")}`);
	}
	if (missingItems.size > 0) {
		console.warn(`[Trades] missing items: ${[...missingItems].join(", ")}`);
	}

	const rows: TradeRow[] = [];
	let skipped = 0;

	for (const t of trades) {
		const traderId = lookups.traders.get(t.traderId);
		const itemId = lookups.items.get(t.itemId);
		const costItemId = lookups.items.get(t.cost.itemId);

		if (!traderId || !itemId || !costItemId) {
			skipped++;
			continue;
		}

		rows.push({
			trader_id: traderId,
			item_id: itemId,
			quantity: t.quantity,
			cost_item_id: costItemId,
			cost_quantity: t.cost.quantity,
			daily_limit: t.dailyLimit,
			content_hash: contentHash(t),
			source_json: t,
		});
	}

	if (skipped > 0) {
		console.warn(`[Trades] skipped ${skipped} trades due to missing FKs`);
	}

	const { data: existing, error: fetchErr } = await supabaseService
		.from("trades")
		.select("id, trader_id, item_id, cost_item_id, content_hash");

	if (fetchErr) {
		console.error("[Trades] error fetching existing:", fetchErr);
		return;
	}

	// build lookup by composite key (trader_id, item_id, cost_item_id)
	const compositeKey = (traderId: UUID, itemId: UUID, costItemId: UUID) =>
		`${traderId}|${itemId}|${costItemId}`;

	const existingByKey = new Map(
		existing?.map((r) => [
			compositeKey(r.trader_id, r.item_id, r.cost_item_id),
			{ id: r.id, hash: r.content_hash },
		]) ?? [],
	);

	const toUpsert: TradeRow[] = [];
	const unchanged: string[] = [];

	for (const row of rows) {
		const key = compositeKey(row.trader_id, row.item_id, row.cost_item_id);
		const existing = existingByKey.get(key);

		if (existing?.hash === row.content_hash) {
			unchanged.push(key);
			continue;
		}

		toUpsert.push(row);
	}

	console.log(
		`[Trades] ${unchanged.length} unchanged, ${toUpsert.length} to upsert`,
	);

	if (toUpsert.length > 0) {
		for (let i = 0; i < toUpsert.length; i += BATCH_SIZE) {
			const batch = toUpsert.slice(i, i + BATCH_SIZE);
			const { error } = await supabaseService
				.from("trades")
				.upsert(batch, { onConflict: "trader_id,item_id,cost_item_id" });

			if (error) {
				console.error(
					`[Trades] batch upsert error (batch ${i / BATCH_SIZE + 1}):`,
					error,
				);
			}
		}
	}

	console.log("[Trades] ingestion complete");
}
