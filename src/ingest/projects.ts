import path from "node:path";
import type { UUID } from "node:crypto";

import { z } from "zod";

import { contentHash, readJsonArray } from "../lib/utils";
import { supabaseService } from "../lib/supabase-client";

const BATCH_SIZE = 100;

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

type RawProject = z.infer<typeof projectSchema>;

interface ProjectRow {
	slug: string;
	name: string;
	description: string;
	content_hash: string;
	source_json: RawProject;
}

interface ProjectPhaseRow {
	project_id: UUID;
	phase_number: number;
	name: string;
	description: string | null;
}

interface ProjectPhaseItemRow {
	phase_id: UUID;
	item_id: UUID;
	quantity: number;
}

interface ProjectPhaseCategoryRow {
	phase_id: UUID;
	category: string;
	value_required: number;
}

interface LookupMaps {
	items: Map<string, UUID>;
}

function transformToRow(project: RawProject): ProjectRow {
	return {
		slug: project.id,
		name: project.name,
		description: project.description,
		content_hash: contentHash(project),
		source_json: project,
	};
}

export async function upsertProjects(
	baseDir: string,
	lookups: LookupMaps,
): Promise<Map<string, UUID>> {
	const file = path.join(baseDir, "projects.json");
	const projects = readJsonArray(file, projectSchema);

	if (!projects || projects.length === 0) {
		console.warn("[Projects] no projects found or failed to parse");
		return new Map();
	}

	console.log(`[Projects] found ${projects.length} projects`);

	const missingItems = new Set<string>();

	for (const p of projects) {
		for (const phase of p.phases) {
			for (const req of phase.requirementItemIds) {
				if (!lookups.items.has(req.itemId)) {
					missingItems.add(req.itemId);
				}
			}
		}
	}

	if (missingItems.size > 0) {
		console.warn(`[Projects] missing items: ${[...missingItems].join(", ")}`);
	}

	const { data: existing, error: fetchErr } = await supabaseService
		.from("projects")
		.select("id, slug, content_hash");

	if (fetchErr) {
		console.error("[Projects] error fetching existing:", fetchErr);
		return new Map();
	}

	const existingBySlug = new Map(
		existing?.map((r) => [r.slug, { id: r.id, hash: r.content_hash }]) ?? [],
	);

	const toUpsert: ProjectRow[] = [];
	const unchanged: string[] = [];
	const changedSlugs: string[] = [];

	for (const project of projects) {
		const row = transformToRow(project);
		const existing = existingBySlug.get(row.slug);

		if (existing?.hash === row.content_hash) {
			unchanged.push(row.slug);
			continue;
		}

		toUpsert.push(row);
		changedSlugs.push(row.slug);
	}

	console.log(
		`[Projects] ${unchanged.length} unchanged, ${toUpsert.length} to upsert`,
	);

	if (toUpsert.length > 0) {
		const { error } = await supabaseService
			.from("projects")
			.upsert(toUpsert, { onConflict: "slug" });

		if (error) {
			console.error("[Projects] upsert error:", error);
		}
	}

	const slugToId = await getProjectLookup();

	if (changedSlugs.length === 0) {
		console.log("[Projects] no changes, skipping phase updates");
		return slugToId;
	}

	// get IDs of changed projects
	const changedProjectIds = changedSlugs
		.map((slug) => slugToId.get(slug))
		.filter((id): id is UUID => id !== undefined);

	if (changedProjectIds.length > 0) {
		const { error: delErr } = await supabaseService
			.from("project_phases")
			.delete()
			.in("project_id", changedProjectIds);

		if (delErr) {
			console.error("[Projects] error deleting old phases:", delErr);
		}
	}

	let totalPhases = 0;
	let totalPhaseItems = 0;
	let totalPhaseCategories = 0;

	for (const project of projects) {
		if (!changedSlugs.includes(project.id)) continue;

		const projectId = slugToId.get(project.id);
		if (!projectId) {
			console.warn(`[Projects] project ${project.id} not found in lookup`);
			continue;
		}

		// insert all phases for this project
		const phaseRows: ProjectPhaseRow[] = project.phases.map((phase) => ({
			project_id: projectId,
			phase_number: phase.phase,
			name: phase.name,
			description: phase.description,
		}));

		if (phaseRows.length === 0) continue;

		const { data: insertedPhases, error: phaseErr } = await supabaseService
			.from("project_phases")
			.insert(phaseRows)
			.select("id, phase_number");

		if (phaseErr || !insertedPhases) {
			console.error(
				`[Projects] error inserting phases for ${project.id}:`,
				phaseErr,
			);
			continue;
		}

		totalPhases += insertedPhases.length;

		// build phase_number → UUID lookup for this project
		const phaseLookup = new Map<number, UUID>(
			insertedPhases.map((p) => [p.phase_number, p.id]),
		);

		// build phase items and category rows
		const phaseItemRows: ProjectPhaseItemRow[] = [];
		const phaseCategoryRows: ProjectPhaseCategoryRow[] = [];

		for (const phase of project.phases) {
			const phaseId = phaseLookup.get(phase.phase);
			if (!phaseId) {
				console.warn(
					`[Projects] phase ${phase.phase} not found for ${project.id}`,
				);
				continue;
			}

			// item requirements
			for (const req of phase.requirementItemIds) {
				const itemId = lookups.items.get(req.itemId);
				if (!itemId) continue; // Already warned above

				phaseItemRows.push({
					phase_id: phaseId,
					item_id: itemId,
					quantity: req.quantity,
				});
			}

			// category requirements
			for (const cat of phase.requirementCategories) {
				phaseCategoryRows.push({
					phase_id: phaseId,
					category: cat.category,
					value_required: cat.valueRequired,
				});
			}
		}

		if (phaseItemRows.length > 0) {
			for (let i = 0; i < phaseItemRows.length; i += BATCH_SIZE) {
				const batch = phaseItemRows.slice(i, i + BATCH_SIZE);
				const { error: itemErr } = await supabaseService
					.from("project_phase_items")
					.insert(batch);

				if (itemErr) {
					console.error(
						`[Projects] error inserting phase items for ${project.id}:`,
						itemErr,
					);
				}
			}
			totalPhaseItems += phaseItemRows.length;
		}

		if (phaseCategoryRows.length > 0) {
			for (let i = 0; i < phaseCategoryRows.length; i += BATCH_SIZE) {
				const batch = phaseCategoryRows.slice(i, i + BATCH_SIZE);
				const { error: catErr } = await supabaseService
					.from("project_phase_categories")
					.insert(batch);

				if (catErr) {
					console.error(
						`[Projects] error inserting phase categories for ${project.id}:`,
						catErr,
					);
				}
			}
			totalPhaseCategories += phaseCategoryRows.length;
		}
	}

	console.log(
		`[Projects] inserted ${totalPhases} phases, ${totalPhaseItems} phase items, ${totalPhaseCategories} phase categories`,
	);
	console.log("[Projects] ingestion complete");

	return slugToId;
}

export async function getProjectLookup(): Promise<Map<string, UUID>> {
	const { data, error } = await supabaseService
		.from("projects")
		.select("id, slug");

	if (error) {
		console.error("[Projects] error fetching lookup:", error);
		return new Map();
	}

	const lookup = new Map<string, UUID>(data?.map((r) => [r.slug, r.id]) ?? []);

	console.log(`[Projects] built slug→id lookup with ${lookup.size} projects`);
	return lookup;
}
