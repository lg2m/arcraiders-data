import path from "node:path";
import type { UUID } from "node:crypto";

import { z } from "zod";

import { contentHash, readJsonArray } from "../lib/utils";
import { supabaseService } from "../lib/supabase-client";

export const mapIdEnumSchema = z.enum([
	"dam_battlegrounds",
	"buried_city",
	"the_spaceport",
	"the_blue_gate",
	"stella_montis",
]);

const mapSchema = z.object({
	id: mapIdEnumSchema,
	name: z.string(),
	description: z.string(),
	image: z.array(z.url()),
});

type RawMap = z.infer<typeof mapSchema>;

interface MapRow {
	slug: string;
	name: string;
	description: string;
	image_url: string[];
	content_hash: string;
	source_json: RawMap;
}

export async function upsertMaps(baseDir: string): Promise<Map<string, UUID>> {
	const file = path.join(baseDir, "maps.json");
	const maps = readJsonArray(file, mapSchema);

	if (!maps || maps.length === 0) {
		console.warn("[Maps] no maps found or failed to parse");
		return new Map();
	}

	console.log(`[Maps] found ${maps.length} maps`);

	const { data: existing } = await supabaseService
		.from("maps")
		.select("id, slug, content_hash");

	const existingBySlug = new Map(existing?.map((r) => [r.slug, r]) ?? []);

	const toUpsert: MapRow[] = [];
	const unchanged: string[] = [];

	for (const m of maps) {
		const hash = contentHash(m);
		const existing = existingBySlug.get(m.id);

		if (existing?.content_hash === hash) {
			unchanged.push(m.id);
			continue;
		}

		toUpsert.push({
			slug: m.id,
			name: m.name,
			description: m.description,
			image_url: m.image,
			content_hash: hash,
			source_json: m,
		});
	}

	console.log(
		`[Maps] ${unchanged.length} unchanged, ${toUpsert.length} to upsert`,
	);

	if (toUpsert.length > 0) {
		const { error } = await supabaseService
			.from("maps")
			.upsert(toUpsert, { onConflict: "slug" });

		if (error) {
			console.error("[Maps] upsert error:", error);
		}
	}

	return getMapLookup();
}

export async function getMapLookup(): Promise<Map<string, UUID>> {
	const { data, error } = await supabaseService.from("maps").select("id, slug");

	if (error) {
		console.error("[Maps] error fetching lookup:", error);
		return new Map();
	}

	const lookup = new Map<string, UUID>(data?.map((r) => [r.slug, r.id]) ?? []);

	console.log(`[Maps] built slug→id lookup with ${lookup.size} maps`);
	return lookup;
}
