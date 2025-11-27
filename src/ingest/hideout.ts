import path from "node:path";
import fs from "node:fs";
import type { UUID } from "node:crypto";

import { z } from "zod";

import { contentHash, readJson } from "../lib/utils";
import { supabaseService } from "../lib/supabase-client";

const BATCH_SIZE = 100;

export const benchIdEnumSchema = z.enum([
	"workbench",
	"gunsmith",
	"utility_station",
	"stash",
	"scrappy",
	"refiner",
	"medical_lab",
	"explosives_station",
	"gear_bench",
]);

const benchSchema = z.object({
	id: benchIdEnumSchema,
	name: z.string(),
	image: z.string().url().nullable(),
	maxLevel: z.number().min(0).max(10),
	levels: z.array(
		z.object({
			level: z.number().min(1).max(10),
			requirementItemIds: z.array(
				z.object({
					itemId: z.string(),
					quantity: z.number(),
				}),
			),
			description: z.string().nullable(),
		}),
	),
});

type RawBench = z.infer<typeof benchSchema>;

interface BenchRow {
	slug: string;
	name: string;
	image_url: string | null;
	max_level: number;
	content_hash: string;
	source_json: RawBench;
}

interface BenchLevelRow {
	bench_id: UUID;
	level: number;
	description: string | null;
}

interface BenchLevelItemRow {
	level_id: UUID;
	item_id: UUID;
	quantity: number;
}

interface LookupMaps {
	items: Map<string, UUID>;
}

function transformToRow(bench: RawBench): BenchRow {
	return {
		slug: bench.id,
		name: bench.name,
		image_url: bench.image,
		max_level: bench.maxLevel,
		content_hash: contentHash(bench),
		source_json: bench,
	};
}

export async function upsertBenches(
	baseDir: string,
	lookups: LookupMaps,
): Promise<Map<string, UUID>> {
	const dir = path.join(baseDir, "hideout");
	if (!fs.existsSync(dir)) {
		console.warn(`[Benches] directory not found at ${dir}`);
		return new Map();
	}

	const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
	console.log(`[Benches] found ${files.length} hideout JSON files`);

	// Read all benches
	const benches: RawBench[] = [];
	for (const file of files) {
		const bench = readJson(path.join(dir, file), benchSchema);
		if (bench) benches.push(bench);
	}
	console.log(`[Benches] parsed ${benches.length} benches successfully`);

	const { data: existing, error: fetchErr } = await supabaseService
		.from("benches")
		.select("id, slug, content_hash");

	if (fetchErr) {
		console.error("[Benches] error fetching existing:", fetchErr);
		return new Map();
	}

	const existingBySlug = new Map(
		existing?.map((r) => [r.slug, { id: r.id, hash: r.content_hash }]) ?? [],
	);

	const toUpsert: BenchRow[] = [];
	const unchanged: string[] = [];
	const changedSlugs: string[] = [];

	for (const bench of benches) {
		const row = transformToRow(bench);
		const existing = existingBySlug.get(row.slug);

		if (existing?.hash === row.content_hash) {
			unchanged.push(row.slug);
			continue;
		}

		toUpsert.push(row);
		changedSlugs.push(row.slug);
	}

	console.log(
		`[Benches] ${unchanged.length} unchanged, ${toUpsert.length} to upsert`,
	);

	if (toUpsert.length > 0) {
		const { error } = await supabaseService
			.from("benches")
			.upsert(toUpsert, { onConflict: "slug" });

		if (error) {
			console.error("[Benches] upsert error:", error);
		}
	}

	const slugToId = await getBenchLookup();

	if (changedSlugs.length === 0) {
		console.log("[Benches] no changes, skipping level updates");
		return slugToId;
	}

	const changedBenchIds = changedSlugs
		.map((slug) => slugToId.get(slug))
		.filter((id): id is UUID => id !== undefined);

	if (changedBenchIds.length > 0) {
		const { error: delErr } = await supabaseService
			.from("bench_levels")
			.delete()
			.in("bench_id", changedBenchIds);

		if (delErr) {
			console.error("[Benches] error deleting old levels:", delErr);
		}
	}

	const missingItems = new Set<string>();
	let totalLevels = 0;
	let totalLevelItems = 0;

	for (const bench of benches) {
		if (!changedSlugs.includes(bench.id)) continue;

		const benchId = slugToId.get(bench.id);
		if (!benchId) {
			console.warn(`[Benches] bench ${bench.id} not found in lookup`);
			continue;
		}

		const levelRows: BenchLevelRow[] = bench.levels.map((lvl) => ({
			bench_id: benchId,
			level: lvl.level,
			description: lvl.description,
		}));

		if (levelRows.length === 0) continue;

		const { data: insertedLevels, error: levelErr } = await supabaseService
			.from("bench_levels")
			.insert(levelRows)
			.select("id, level");

		if (levelErr || !insertedLevels) {
			console.error(
				`[Benches] error inserting levels for ${bench.id}:`,
				levelErr,
			);
			continue;
		}

		totalLevels += insertedLevels.length;

		// build level number → UUID lookup for this bench
		const levelLookup = new Map<number, UUID>(
			insertedLevels.map((l) => [l.level, l.id]),
		);

		const levelItemRows: BenchLevelItemRow[] = [];

		for (const lvl of bench.levels) {
			const levelId = levelLookup.get(lvl.level);
			if (!levelId) {
				console.warn(`[Benches] level ${lvl.level} not found for ${bench.id}`);
				continue;
			}

			for (const req of lvl.requirementItemIds) {
				const itemId = lookups.items.get(req.itemId);
				if (!itemId) {
					missingItems.add(req.itemId);
					continue;
				}

				levelItemRows.push({
					level_id: levelId,
					item_id: itemId,
					quantity: req.quantity,
				});
			}
		}

		if (levelItemRows.length > 0) {
			for (let i = 0; i < levelItemRows.length; i += BATCH_SIZE) {
				const batch = levelItemRows.slice(i, i + BATCH_SIZE);
				const { error: itemErr } = await supabaseService
					.from("bench_level_items")
					.insert(batch);

				if (itemErr) {
					console.error(
						`[Benches] error inserting level items for ${bench.id}:`,
						itemErr,
					);
				}
			}
			totalLevelItems += levelItemRows.length;
		}
	}

	if (missingItems.size > 0) {
		console.warn(`[Benches] missing items: ${[...missingItems].join(", ")}`);
	}

	console.log(
		`[Benches] inserted ${totalLevels} levels, ${totalLevelItems} level items`,
	);
	console.log("[Benches] ingestion complete");

	return slugToId;
}

export async function getBenchLookup(): Promise<Map<string, UUID>> {
	const { data, error } = await supabaseService
		.from("benches")
		.select("id, slug");

	if (error) {
		console.error("[Benches] error fetching lookup:", error);
		return new Map();
	}

	const lookup = new Map<string, UUID>(data?.map((r) => [r.slug, r.id]) ?? []);

	console.log(`[Benches] built slug→id lookup with ${lookup.size} benches`);
	return lookup;
}
