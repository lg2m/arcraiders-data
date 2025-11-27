import path from "node:path";

import { z } from "zod";

import { supabaseService } from "./lib/supabase-client";
import { readJsonArray } from "./lib/utils";
import { upsertMaps } from "./ingest/maps";
import { upsertItems } from "./ingest/items";
import { upsertBots } from "./ingest/bots";
import { upsertTraders } from "./ingest/traders";
import { upsertTrades } from "./ingest/trades";
import { upsertBenches } from "./ingest/hideout";
import { upsertQuests } from "./ingest/quests";

const projectSchema = z.object({
	id: z.string(),
	name: z.string(),
	description: z.string(),
	phases: z.array(
		z.object({
			phase: z.number(),
			name: z.string(),
			description: z.string().nullable(),
			requirementItemIds: z.array(
				z.object({
					itemId: z.string(),
					quantity: z.number(),
				}),
			),
			requirementCategories: z.array(
				z.object({
					category: z.string(),
					valueRequired: z.number(),
				}),
			),
		}),
	),
});

function toId(str: string) {
	return str.trim().toLowerCase().replace(/\s+/g, "_");
}

async function upsertProjects(baseDir: string) {
	const file = path.join(baseDir, "projects.json");
	const projects = readJsonArray(file, projectSchema);

	console.log(`Ingesting ${projects.length} projects`);

	for (const p of projects) {
		const { error: coreErr } = await supabaseService.from("projects").upsert(
			{
				id: p.id,
				name: p.name,
				description: p.description,
				source_json: p as any,
			},
			{ onConflict: "id" },
		);
		if (coreErr) {
			console.error("projects upsert error", p.id, coreErr);
			continue;
		}

		const { data: existingPhases, error: existingErr } = await supabaseService
			.from("project_phases")
			.select("id, phase_number")
			.eq("project_id", toId(p.id));

		if (existingErr) {
			console.error("project_phases fetch error", p.id, existingErr);
			continue;
		}

		if (existingPhases && existingPhases.length > 0) {
			const ids = existingPhases.map((ph) => ph.id);
			await supabaseService
				.from("project_phase_items")
				.delete()
				.in("phase_id", ids);
			await supabaseService
				.from("project_phase_value_requirements")
				.delete()
				.in("phase_id", ids);
			await supabaseService
				.from("project_phases")
				.delete()
				.eq("project_id", toId(p.id));
		}

		for (const phase of p.phases) {
			const { data: inserted, error: insErr } = await supabaseService
				.from("project_phases")
				.insert({
					project_id: p.id,
					phase_number: phase.phase,
					name: phase.name,
					description: phase.description,
				})
				.select("id")
				.single();

			if (insErr || !inserted) {
				console.error("project_phases insert error", p.id, phase.phase, insErr);
				continue;
			}

			const phaseId = inserted.id;

			// Item requirements
			if (phase.requirementItemIds.length > 0) {
				// Ensure items exist
				const ids = phase.requirementItemIds.map((r) => r.itemId);
				await supabaseService.from("items").upsert(
					[...new Set(ids)].map((id) => ({ id })),
					{ onConflict: "id" },
				);

				await supabaseService.from("project_phase_items").insert(
					phase.requirementItemIds.map((r) => ({
						phase_id: phaseId,
						item_id: r.itemId,
						quantity: r.quantity,
					})),
				);
			}

			// Value requirements
			if (phase.requirementCategories.length > 0) {
				await supabaseService.from("project_phase_value_requirements").insert(
					phase.requirementCategories.map((rc) => ({
						phase_id: phaseId,
						category: rc.category,
						value_required: rc.valueRequired,
					})),
				);
			}
		}
	}
}

async function main() {
	const baseDir = path.resolve(__dirname, "../data");

	console.log(`Starting ingestion from ${baseDir}\n`);

	const startTime = Date.now();

	console.log("=".repeat(60));
	console.log("Foundation entities");
	console.log("=".repeat(60));

	// maps - no deps
	const mapLookup = await upsertMaps(baseDir);
	console.log();

	// items - self-referential
	const itemLookup = await upsertItems(baseDir);
	console.log();

	console.log("=".repeat(60));
	console.log("Dependent entities");
	console.log("=".repeat(60));

	const lookups = {
		items: itemLookup,
		maps: mapLookup,
	};

	// bots - combined lookup obj
	const botLookup = await upsertBots(baseDir, lookups);
	console.log();

	// traders - no deps
	const traderLookup = await upsertTraders(baseDir);
	console.log();

	console.log("=".repeat(60));
	console.log("Complex entities");
	console.log("=".repeat(60));

	// trades - depends on traders and items
	await upsertTrades(baseDir, { items: itemLookup, traders: traderLookup });
	console.log();

	// quests - depends on traders, maps, and items
	const questLookup = await upsertQuests(baseDir, { items: itemLookup, maps: mapLookup, traders: traderLookup });
	console.log();

	// projects - depends on items
	//

	// hideout/benches - depends on items
	const benchLookup = await upsertBenches(baseDir, { items: itemLookup });
	console.log();

	const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
	console.log("=".repeat(60));
	console.log(`Ingestion complete in ${elapsed}s`);
	console.log("=".repeat(60));

	console.log("\nLookup sizes:");
	console.log(`  Maps:  ${mapLookup.size}`);
	console.log(`  Items: ${itemLookup.size}`);
	console.log(`  Bots:  ${botLookup.size}`);
	console.log(`  Traders: ${traderLookup.size}`);
	console.log(`  Benches: ${benchLookup.size}`);
	console.log(`  Quests:  ${questLookup.size}`);
}

main().catch(console.error);
