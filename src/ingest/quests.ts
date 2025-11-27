import path from "node:path";
import fs from "node:fs";
import type { UUID } from "node:crypto";

import { z } from "zod";

import { contentHash, readJson } from "../lib/utils";
import { supabaseService } from "../lib/supabase-client";
import { mapIdEnumSchema } from "./maps";
import { traderIdEnumSchema } from "./traders";

const BATCH_SIZE = 100;

const questSchema = z.object({
	id: z.string(),
	updatedAt: z.string(),
	videoUrl: z.string().url().nullable(),
	mapIds: z.array(mapIdEnumSchema),
	name: z.string(),
	traderId: traderIdEnumSchema,
	description: z.string(),
	objectives: z.array(z.string()),
	otherRequirements: z.array(z.string()),
	requiredItemIds: z.array(
		z.object({
			itemId: z.string(),
			quantity: z.number(),
		}),
	),
	grantedItemIds: z.array(
		z.object({
			itemId: z.string(),
			quantity: z.number(),
		}),
	),
	rewardItemIds: z.array(
		z.object({
			itemId: z.string(),
			quantity: z.number(),
		}),
	),
	xp: z.number(),
	previousQuestIds: z.array(z.string()),
	nextQuestIds: z.array(z.string()),
});

type RawQuest = z.infer<typeof questSchema>;

interface QuestRow {
	slug: string;
	name: string;
	description: string;
	trader_id: UUID;
	xp: number;
	content_hash: string;
	source_json: RawQuest;
}

interface QuestMapRow {
	quest_id: UUID;
	map_id: UUID;
}

interface QuestObjectiveRow {
	quest_id: UUID;
	index_in_quest: number;
	text: string;
}

interface QuestOtherRequirementRow {
	quest_id: UUID;
	index_in_quest: number;
	text: string;
}

interface QuestItemRow {
	quest_id: UUID;
	item_id: UUID;
	quantity: number;
	kind: "required" | "granted" | "reward";
}

interface QuestRelationRow {
	quest_id: UUID;
	related_quest_id: UUID;
	kind: "previous" | "next";
}

interface LookupMaps {
	items: Map<string, UUID>;
	maps: Map<string, UUID>;
	traders: Map<string, UUID>;
}

export async function upsertQuests(
	baseDir: string,
	lookups: LookupMaps,
): Promise<Map<string, UUID>> {
	const dir = path.join(baseDir, "quests");
	if (!fs.existsSync(dir)) {
		console.warn(`[Quests] directory not found at ${dir}`);
		return new Map();
	}

	const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
	console.log(`[Quests] found ${files.length} quest JSON files`);

	// read all quests
	const quests: RawQuest[] = [];
	for (const file of files) {
		const quest = readJson(path.join(dir, file), questSchema);
		if (quest) quests.push(quest);
	}
	console.log(`[Quests] parsed ${quests.length} quests successfully`);

	const missingTraders = new Set<string>();
	const missingMaps = new Set<string>();
	const missingItems = new Set<string>();

	for (const q of quests) {
		if (!lookups.traders.has(q.traderId)) {
			missingTraders.add(q.traderId);
		}
		for (const mapId of q.mapIds) {
			if (!lookups.maps.has(mapId)) {
				missingMaps.add(mapId);
			}
		}
		for (const ri of q.requiredItemIds) {
			if (!lookups.items.has(ri.itemId)) {
				missingItems.add(ri.itemId);
			}
		}
		for (const gi of q.grantedItemIds) {
			if (!lookups.items.has(gi.itemId)) {
				missingItems.add(gi.itemId);
			}
		}
		for (const ri of q.rewardItemIds) {
			if (!lookups.items.has(ri.itemId)) {
				missingItems.add(ri.itemId);
			}
		}
	}

	if (missingTraders.size > 0) {
		console.warn(`[Quests] missing traders: ${[...missingTraders].join(", ")}`);
	}
	if (missingMaps.size > 0) {
		console.warn(`[Quests] missing maps: ${[...missingMaps].join(", ")}`);
	}
	if (missingItems.size > 0) {
		console.warn(`[Quests] missing items: ${[...missingItems].join(", ")}`);
	}

	const { data: existing, error: fetchErr } = await supabaseService
		.from("quests")
		.select("id, slug, content_hash");

	if (fetchErr) {
		console.error("[Quests] error fetching existing:", fetchErr);
		return new Map();
	}

	const existingBySlug = new Map(
		existing?.map((r) => [r.slug, { id: r.id, hash: r.content_hash }]) ?? [],
	);

	const toUpsert: QuestRow[] = [];
	const unchanged: string[] = [];
	const changedSlugs: string[] = [];
	let skipped = 0;

	for (const q of quests) {
		const traderId = lookups.traders.get(q.traderId);
		if (!traderId) {
			skipped++;
			continue;
		}

		const hash = contentHash(q);
		const existing = existingBySlug.get(q.id);

		if (existing?.hash === hash) {
			unchanged.push(q.id);
			continue;
		}

		toUpsert.push({
			slug: q.id,
			name: q.name,
			description: q.description,
			trader_id: traderId,
			xp: q.xp,
			content_hash: hash,
			source_json: q,
		});
		changedSlugs.push(q.id);
	}

	if (skipped > 0) {
		console.warn(`[Quests] skipped ${skipped} quests due to missing trader FK`);
	}

	console.log(
		`[Quests] ${unchanged.length} unchanged, ${toUpsert.length} to upsert`,
	);

	if (toUpsert.length > 0) {
		for (let i = 0; i < toUpsert.length; i += BATCH_SIZE) {
			const batch = toUpsert.slice(i, i + BATCH_SIZE);
			const { error } = await supabaseService
				.from("quests")
				.upsert(batch, { onConflict: "slug" });

			if (error) {
				console.error(
					`[Quests] batch upsert error (batch ${i / BATCH_SIZE + 1}):`,
					error,
				);
			}
		}
	}

	const slugToId = await getQuestLookup();

	if (changedSlugs.length === 0) {
		console.log("[Quests] no changes, skipping child table updates");
		return slugToId;
	}

	// get UUIDs of changed quests
	const changedQuestIds = changedSlugs
		.map((slug) => slugToId.get(slug))
		.filter((id): id is UUID => id !== undefined);

	if (changedQuestIds.length > 0) {
		await supabaseService
			.from("quest_maps")
			.delete()
			.in("quest_id", changedQuestIds);
		await supabaseService
			.from("quest_objectives")
			.delete()
			.in("quest_id", changedQuestIds);
		await supabaseService
			.from("quest_other_requirements")
			.delete()
			.in("quest_id", changedQuestIds);
		await supabaseService
			.from("quest_items")
			.delete()
			.in("quest_id", changedQuestIds);
		await supabaseService
			.from("quest_relations")
			.delete()
			.in("quest_id", changedQuestIds);
	}

	const questMapRows: QuestMapRow[] = [];
	const objectiveRows: QuestObjectiveRow[] = [];
	const otherRequirementRows: QuestOtherRequirementRow[] = [];
	const questItemRows: QuestItemRow[] = [];
	const relationRows: QuestRelationRow[] = [];

	const missingRelatedQuests = new Set<string>();

	for (const q of quests) {
		if (!changedSlugs.includes(q.id)) continue;

		const questId = slugToId.get(q.id);
		if (!questId) continue;

		// quest → map relations
		for (const mapSlug of q.mapIds) {
			const mapId = lookups.maps.get(mapSlug);
			if (mapId) {
				questMapRows.push({ quest_id: questId, map_id: mapId });
			}
		}

		// objectives (ordered)
		for (let i = 0; i < q.objectives.length; i++) {
			objectiveRows.push({
				quest_id: questId,
				index_in_quest: i,
				text: q.objectives[i] ?? "",
			});
		}

		// other requirements (ordered)
		for (let i = 0; i < q.otherRequirements.length; i++) {
			otherRequirementRows.push({
				quest_id: questId,
				index_in_quest: i,
				text: q.otherRequirements[i] ?? "",
			});
		}

		// quest items (required, granted, reward)
		for (const ri of q.requiredItemIds) {
			const itemId = lookups.items.get(ri.itemId);
			if (itemId) {
				questItemRows.push({
					quest_id: questId,
					item_id: itemId,
					quantity: ri.quantity,
					kind: "required",
				});
			}
		}
		for (const gi of q.grantedItemIds) {
			const itemId = lookups.items.get(gi.itemId);
			if (itemId) {
				questItemRows.push({
					quest_id: questId,
					item_id: itemId,
					quantity: gi.quantity,
					kind: "granted",
				});
			}
		}
		for (const ri of q.rewardItemIds) {
			const itemId = lookups.items.get(ri.itemId);
			if (itemId) {
				questItemRows.push({
					quest_id: questId,
					item_id: itemId,
					quantity: ri.quantity,
					kind: "reward",
				});
			}
		}

		// quest relations (previous/next) - self-referential
		for (const prevSlug of q.previousQuestIds) {
			const relatedId = slugToId.get(prevSlug);
			if (relatedId) {
				relationRows.push({
					quest_id: questId,
					related_quest_id: relatedId,
					kind: "previous",
				});
			} else {
				missingRelatedQuests.add(prevSlug);
			}
		}
		for (const nextSlug of q.nextQuestIds) {
			const relatedId = slugToId.get(nextSlug);
			if (relatedId) {
				relationRows.push({
					quest_id: questId,
					related_quest_id: relatedId,
					kind: "next",
				});
			} else {
				missingRelatedQuests.add(nextSlug);
			}
		}
	}

	if (missingRelatedQuests.size > 0) {
		console.warn(
			`[Quests] missing related quests for relations: ${[...missingRelatedQuests].join(", ")}`,
		);
	}

	// quest maps
	if (questMapRows.length > 0) {
		for (let i = 0; i < questMapRows.length; i += BATCH_SIZE) {
			const batch = questMapRows.slice(i, i + BATCH_SIZE);
			const { error } = await supabaseService.from("quest_maps").insert(batch);
			if (error) console.error("[Quests] quest_maps insert error:", error);
		}
		console.log(`[Quests] inserted ${questMapRows.length} quest_maps`);
	}

	// Objectives
	if (objectiveRows.length > 0) {
		for (let i = 0; i < objectiveRows.length; i += BATCH_SIZE) {
			const batch = objectiveRows.slice(i, i + BATCH_SIZE);
			const { error } = await supabaseService
				.from("quest_objectives")
				.insert(batch);
			if (error)
				console.error("[Quests] quest_objectives insert error:", error);
		}
		console.log(`[Quests] inserted ${objectiveRows.length} quest_objectives`);
	}

	// other requirements
	if (otherRequirementRows.length > 0) {
		for (let i = 0; i < otherRequirementRows.length; i += BATCH_SIZE) {
			const batch = otherRequirementRows.slice(i, i + BATCH_SIZE);
			const { error } = await supabaseService
				.from("quest_other_requirements")
				.insert(batch);
			if (error)
				console.error("[Quests] quest_other_requirements insert error:", error);
		}
		console.log(
			`[Quests] inserted ${otherRequirementRows.length} quest_other_requirements`,
		);
	}

	// quest items
	if (questItemRows.length > 0) {
		for (let i = 0; i < questItemRows.length; i += BATCH_SIZE) {
			const batch = questItemRows.slice(i, i + BATCH_SIZE);
			const { error } = await supabaseService.from("quest_items").insert(batch);
			if (error) console.error("[Quests] quest_items insert error:", error);
		}
		console.log(`[Quests] inserted ${questItemRows.length} quest_items`);
	}

	// quest relations
	if (relationRows.length > 0) {
		for (let i = 0; i < relationRows.length; i += BATCH_SIZE) {
			const batch = relationRows.slice(i, i + BATCH_SIZE);
			const { error } = await supabaseService
				.from("quest_relations")
				.insert(batch);
			if (error) console.error("[Quests] quest_relations insert error:", error);
		}
		console.log(`[Quests] inserted ${relationRows.length} quest_relations`);
	}

	console.log("[Quests] ingestion complete");

	return slugToId;
}

export async function getQuestLookup(): Promise<Map<string, UUID>> {
	const { data, error } = await supabaseService
		.from("quests")
		.select("id, slug");

	if (error) {
		console.error("[Quests] error fetching lookup:", error);
		return new Map();
	}

	const lookup = new Map<string, UUID>(data?.map((r) => [r.slug, r.id]) ?? []);

	console.log(`[Quests] built slug→id lookup with ${lookup.size} quests`);
	return lookup;
}
