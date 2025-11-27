import path from "node:path";
import fs from "node:fs";
import type { UUID } from "node:crypto";

import { z } from "zod";

import { contentHash, readJson } from "../lib/utils";
import { supabaseService } from "../lib/supabase-client";

const BATCH_SIZE = 100;

const itemSchema = z.object({
	// required fields
	id: z.string(),
	name: z.string(),
	description: z.string(),
	type: z.string(),
	rarity: z.string(),
	updatedAt: z.string(),

	// common optionals
	imageFilename: z.string().optional(),
	weightKg: z.number().optional(),
	value: z.number().optional(),
	stackSize: z.number().optional(),
	foundIn: z.string().optional(),
	stationLevelRequired: z.number().optional(),

	// Weapon stats
	isWeapon: z.boolean().optional(),
	damage: z.number().optional(),
	fireRate: z.number().optional(),
	range: z.number().nullable().optional(),
	stability: z.number().optional(),
	agility: z.number().optional(),
	stealth: z.number().nullable().optional(),
	durability: z.number().optional(),

	// Flags
	blueprintLocked: z.boolean().optional(),

	// Complex nested data - keep as raw objects
	effects: z.record(z.string(), z.unknown()).optional(),
	recyclesInto: z.record(z.string(), z.number()).optional(),
	recipe: z.record(z.string(), z.number()).optional(),
	salvagesInto: z.record(z.string(), z.number()).optional(),
	upgradeCost: z.record(z.string(), z.number()).optional(),
	repairCost: z.record(z.string(), z.number()).optional(),
	repairMaterials: z.record(z.string(), z.unknown()).optional(),

	// craft bench is sometimes a string & array
	craftBench: z.union([z.string(), z.array(z.string())]).optional(),

	// compatibility (array of item names)
	compatibleWith: z.array(z.string()).optional(),

	// TODO: need to figure this out
	// sparse fields dumping into metadata
	tip: z.string().optional(),
	_note: z.string().optional(),
	station: z.string().optional(),
	weight: z.number().optional(),
	shieldCharge: z.number().optional(),
	damageMitigation: z.number().optional(),
	movementSpeedModifier: z.number().optional(),
	increasedFireRate: z.number().optional(),
	reducedReloadTime: z.number().optional(),
	reducedDurabilityBurnRate: z.number().optional(),
	repairDurability: z.number().optional(),
});

type RawItem = z.infer<typeof itemSchema>;

// Database row types
interface ItemRow {
	slug: string;
	name: string;
	description: string;
	type: string;
	rarity: string;
	image_url: string | null;
	weight_kg: number | null;
	value: number | null;
	stack_size: number | null;
	found_in: string | null;
	station_level_required: number | null;
	is_weapon: boolean;
	damage: number | null;
	fire_rate: number | null;
	range: number | null;
	stability: number | null;
	agility: number | null;
	stealth: number | null;
	durability: number | null;
	blueprint_locked: boolean | null;
	effects: Record<string, unknown> | null;
	metadata: Record<string, unknown> | null;
	content_hash: string;
	source_json: RawItem;
}

interface MaterialRelationRow {
	item_id: UUID;
	material_item_id: UUID;
	quantity: number;
	kind:
		| "recipe"
		| "recycles_into"
		| "salvages_into"
		| "upgrade_cost"
		| "repair_cost";
}

interface CraftBenchRow {
	item_id: UUID;
	bench_slug: string;
}

interface CompatibilityRow {
	item_id: UUID;
	compatible_with_name: string;
}

function transformToRow(item: RawItem): ItemRow {
	const metadata: Record<string, unknown> = {};

	if (item.tip) {
		metadata.tip = item.tip;
	}
	if (item._note) {
		metadata._note = item._note;
	}
	if (item.station) {
		metadata.station = item.station;
	}
	if (item.weight !== undefined) {
		metadata.weight = item.weight;
	}
	if (item.shieldCharge !== undefined) {
		metadata.shieldCharge = item.shieldCharge;
	}
	if (item.damageMitigation !== undefined) {
		metadata.damageMitigation = item.damageMitigation;
	}
	if (item.movementSpeedModifier !== undefined) {
		metadata.movementSpeedModifier = item.movementSpeedModifier;
	}
	if (item.increasedFireRate !== undefined) {
		metadata.increasedFireRate = item.increasedFireRate;
	}
	if (item.reducedReloadTime !== undefined) {
		metadata.reducedReloadTime = item.reducedReloadTime;
	}
	if (item.reducedDurabilityBurnRate !== undefined) {
		metadata.reducedDurabilityBurnRate = item.reducedDurabilityBurnRate;
	}
	if (item.repairDurability !== undefined) {
		metadata.repairDurability = item.repairDurability;
	}
	if (item.repairMaterials) {
		metadata.repairMaterials = item.repairMaterials;
	}

	return {
		slug: item.id,
		name: item.name,
		description: item.description,
		type: item.type,
		rarity: item.rarity,
		image_url: item.imageFilename ?? null,
		weight_kg: item.weightKg ?? null,
		value: item.value ?? null,
		stack_size: item.stackSize ?? null,
		found_in: item.foundIn ?? null,
		station_level_required: item.stationLevelRequired ?? null,
		is_weapon: item.isWeapon ?? false,
		damage: item.damage ?? null,
		fire_rate: item.fireRate ?? null,
		range: item.range ?? null,
		stability: item.stability ?? null,
		agility: item.agility ?? null,
		stealth: item.stealth ?? null,
		durability: item.durability ?? null,
		blueprint_locked: item.blueprintLocked ?? null,
		effects: item.effects ?? null,
		metadata: Object.keys(metadata).length > 0 ? metadata : null,
		content_hash: contentHash(item),
		source_json: item,
	};
}

export async function upsertItems(baseDir: string): Promise<Map<string, UUID>> {
	const dir = path.join(baseDir, "items");
	if (!fs.existsSync(dir)) {
		console.warn(`[Items] directory not found at ${dir}`);
		return new Map();
	}

	const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
	console.log(`[Items] found ${files.length} item JSON files`);

	const items: RawItem[] = [];
	for (const file of files) {
		const item = readJson(path.join(dir, file), itemSchema);
		if (item) {
			items.push(item);
		}
	}
	console.log(`[Items] parsed ${items.length} items successfully`);

	const { data: existing, error: fetchErr } = await supabaseService
		.from("items")
		.select("id, slug, content_hash");

	if (fetchErr) {
		console.error("[Items] error fetching existing items:", fetchErr);
		return new Map();
	}

	const existingBySlug = new Map(
		existing?.map((r) => [r.slug, { id: r.id, hash: r.content_hash }]) ?? [],
	);

	const toUpsert: ItemRow[] = [];
	const unchanged: string[] = [];

	for (const item of items) {
		const row = transformToRow(item);
		const existing = existingBySlug.get(row.slug);

		if (existing?.hash === row.content_hash) {
			unchanged.push(row.slug);
			continue;
		}

		toUpsert.push(row);
	}

	console.log(
		`[Items] ${unchanged.length} unchanged, ${toUpsert.length} to upsert`,
	);

	if (toUpsert.length > 0) {
		for (let i = 0; i < toUpsert.length; i += BATCH_SIZE) {
			const batch = toUpsert.slice(i, i + BATCH_SIZE);
			const { error } = await supabaseService
				.from("items")
				.upsert(batch, { onConflict: "slug" });

			if (error) {
				console.error(
					`[Items] batch upsert error (batch ${i / BATCH_SIZE + 1}):`,
					error,
				);
			}
		}
	}

	// build lookup (includes newly inserted)
	const slugToId = await getItemLookup();

	const materialRelations: MaterialRelationRow[] = [];
	const craftBenchRows: CraftBenchRow[] = [];
	const compatibilityRows: CompatibilityRow[] = [];

	const missingMaterials = new Set<string>();

	for (const item of items) {
		const itemId = slugToId.get(item.id);
		if (!itemId) {
			console.warn(`[Items] item ${item.id} not found in lookup after upsert`);
			continue;
		}

		// material relations (recipe, recyclesInto, etc.)
		const relationTypes = [
			{ key: "recipe", type: "recipe" as const },
			{ key: "recyclesInto", type: "recycles_into" as const },
			{ key: "salvagesInto", type: "salvages_into" as const },
			{ key: "upgradeCost", type: "upgrade_cost" as const },
			{ key: "repairCost", type: "repair_cost" as const },
		];

		for (const { key, type } of relationTypes) {
			const data = item[key as keyof RawItem] as
				| Record<string, number>
				| undefined;
			if (!data) {
				continue;
			}

			for (const [materialSlug, quantity] of Object.entries(data)) {
				const materialId = slugToId.get(materialSlug);
				if (!materialId) {
					missingMaterials.add(materialSlug);
					continue;
				}

				materialRelations.push({
					item_id: itemId,
					material_item_id: materialId,
					quantity,
					kind: type,
				});
			}
		}

		// craft benches
		if (item.craftBench) {
			const benches = Array.isArray(item.craftBench)
				? item.craftBench
				: [item.craftBench];
			for (const bench of benches) {
				craftBenchRows.push({ item_id: itemId, bench_slug: bench });
			}
		}

		// compatibilities
		if (item.compatibleWith) {
			for (const name of item.compatibleWith) {
				compatibilityRows.push({ item_id: itemId, compatible_with_name: name });
			}
		}
	}

	if (missingMaterials.size > 0) {
		console.warn(
			`[Items] missing material items (not in items dir): ${[...missingMaterials].join(", ")}`,
		);
	}

	const itemIds = [...slugToId.values()];

	// clear existing relationships for these items
	if (itemIds.length > 0) {
		await supabaseService
			.from("item_material_relations")
			.delete()
			.in("item_id", itemIds);
		await supabaseService
			.from("item_craft_benches")
			.delete()
			.in("item_id", itemIds);
		await supabaseService
			.from("item_compatibilities")
			.delete()
			.in("item_id", itemIds);
	}

	if (materialRelations.length > 0) {
		for (let i = 0; i < materialRelations.length; i += BATCH_SIZE) {
			const batch = materialRelations.slice(i, i + BATCH_SIZE);
			const { error } = await supabaseService
				.from("item_material_relations")
				.insert(batch);
			if (error) {
				console.error("[Items] material_relations insert error:", error);
			}
		}
		console.log(
			`[Items] inserted ${materialRelations.length} material relations`,
		);
	}

	if (craftBenchRows.length > 0) {
		for (let i = 0; i < craftBenchRows.length; i += BATCH_SIZE) {
			const batch = craftBenchRows.slice(i, i + BATCH_SIZE);
			const { error } = await supabaseService
				.from("item_craft_benches")
				.insert(batch);
			if (error) {
				console.error("[Items] craft_benches insert error:", error);
			}
		}
		console.log(
			`[Items] inserted ${craftBenchRows.length} craft bench relations`,
		);
	}

	if (compatibilityRows.length > 0) {
		for (let i = 0; i < compatibilityRows.length; i += BATCH_SIZE) {
			const batch = compatibilityRows.slice(i, i + BATCH_SIZE);
			const { error } = await supabaseService
				.from("item_compatibilities")
				.insert(batch);
			if (error) {
				console.error("[Items] compatibilities insert error:", error);
			}
		}
		console.log(
			`[Items] inserted ${compatibilityRows.length} compatibility relations`,
		);
	}

	console.log("[Items] ingestion complete");

	return slugToId;
}

export async function getItemLookup(): Promise<Map<string, UUID>> {
	const { data, error } = await supabaseService
		.from("items")
		.select("id, slug");

	if (error) {
		console.error("[Items] error fetching lookup:", error);
		return new Map();
	}

	const lookup = new Map<string, UUID>(data?.map((r) => [r.slug, r.id]) ?? []);

	console.log(`[Items] built slug→id lookup with ${lookup.size} items`);
	return lookup;
}
