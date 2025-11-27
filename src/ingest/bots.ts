import path from "node:path";
import type { UUID } from "node:crypto";

import { z } from "zod";

import { contentHash, readJsonArray } from "../lib/utils";
import { mapIdEnumSchema } from "./maps";
import { supabaseService } from "../lib/supabase-client";

const BATCH_SIZE = 100;

export const botTypeEnumSchema = z.enum([
  "Reconnaissance",
  "Heavy Assault",
  "Heavy Artillery",
  "Area Denial",
  "Medium Drone",
  "Siege Engine",
  "Explosive",
  "Flying Artillery",
  "Sniper Turret",
  "Scout Drone",
  "Boss",
  "Ambush Predator",
  "Defense System",
  "Flying Drone",
  "Queen of Queens",
  "Close quaters predator",
]);

export const botThreatEnumSchema = z.enum([
  "Low",
  "Moderate",
  "High",
  "Critical",
  "Extreme",
]);

const botSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  image: z.url(),
  type: botTypeEnumSchema,
  threat: botThreatEnumSchema,
  weakness: z.string(),
  maps: z.array(mapIdEnumSchema),
  destroyXp: z.number(),
  lootXp: z.number(),
  drops: z.array(z.string()),
});

type RawBot = z.infer<typeof botSchema>;

interface BotRow {
  slug: string;
  name: string;
  description: string;
  image_url: string;
  type: string;
  threat: string;
  weakness: string;
  destroy_xp: number;
  loot_xp: number;
  content_hash: string;
  source_json: RawBot;
}

interface BotMapRow {
  bot_id: UUID;
  map_id: UUID;
}

interface BotDropRow {
  bot_id: UUID;
  item_id: UUID;
}

function transformToRow(bot: RawBot): BotRow {
  return {
    slug: bot.id,
    name: bot.name,
    description: bot.description,
    image_url: bot.image,
    type: bot.type,
    threat: bot.threat,
    weakness: bot.weakness,
    destroy_xp: bot.destroyXp,
    loot_xp: bot.lootXp,
    content_hash: contentHash(bot),
    source_json: bot,
  };
}

interface LookupMaps {
  items: Map<string, UUID>;
  maps: Map<string, UUID>;
}

export async function upsertBots(baseDir: string, lookups: LookupMaps): Promise<Map<string, UUID>> {
  const file = path.join(baseDir, "bots.json");
  const bots = readJsonArray(file, botSchema);

  if (!bots || bots.length === 0) {
    console.warn("[Bots] no bots found or failed to parse");
    return new Map();
  }

  console.log(`[Bots] found ${bots.length} bots`);

  const { data: existing, error: fetchErr } = await supabaseService
    .from("bots")
    .select("id, slug, content_hash");

  if (fetchErr) {
    console.error("[Bots] error fetching existing:", fetchErr);
    return new Map<string, UUID>();
  }

  const existingBySlug = new Map(
    existing?.map((r) => [r.slug, { id: r.id, hash: r.content_hash }]) ?? []
  );

  const toUpsert: BotRow[] = [];
  const unchanged: string[] = [];

  for (const bot of bots) {
    const row = transformToRow(bot);
    const existing = existingBySlug.get(row.slug);

    if (existing?.hash === row.content_hash) {
      unchanged.push(row.slug);
      continue;
    }

    toUpsert.push(row);
  }

  console.log(`[Bots] ${unchanged.length} unchanged, ${toUpsert.length} to upsert`);

  if (toUpsert.length > 0) {
    for (let i = 0; i < toUpsert.length; i += BATCH_SIZE) {
      const batch = toUpsert.slice(i, i + BATCH_SIZE);
      const { error } = await supabaseService
        .from("bots")
        .upsert(batch, { onConflict: "slug" });

      if (error) {
        console.error(`[Bots] batch upsert error (batch ${i / BATCH_SIZE + 1}):`, error);
      }
    }
  }

  const { data: allBots, error: lookupErr } = await supabaseService
    .from("bots")
    .select("id, slug");

  if (lookupErr) {
    console.error("[Bots] error fetching lookup:", lookupErr);
    return new Map<string, UUID>();
  }

  const botSlugToId = new Map<string, UUID>(
    allBots?.map((r) => [r.slug, r.id]) ?? []
  );

  console.log(`[Bots] built slug→id lookup with ${botSlugToId.size} bots`);

  const botMapRows: BotMapRow[] = [];
  const botDropRows: BotDropRow[] = [];

  const missingMaps = new Set<string>();
  const missingItems = new Set<string>();

  for (const bot of bots) {
    const botId = botSlugToId.get(bot.id);
    if (!botId) {
      console.warn(`[Bots] bot ${bot.id} not found in lookup after upsert`);
      continue;
    }

    // Bot → Map relations
    for (const mapSlug of bot.maps) {
      const mapId = lookups.maps.get(mapSlug);
      if (!mapId) {
        missingMaps.add(mapSlug);
        continue;
      }
      botMapRows.push({ bot_id: botId, map_id: mapId });
    }

    // Bot → Item drops
    for (const itemSlug of bot.drops) {
      const itemId = lookups.items.get(itemSlug);
      if (!itemId) {
        missingItems.add(itemSlug);
        continue;
      }
      botDropRows.push({ bot_id: botId, item_id: itemId });
    }
  }

  if (missingMaps.size > 0) {
    console.warn(`[Bots] missing maps: ${[...missingMaps].join(", ")}`);
  }

  if (missingItems.size > 0) {
    console.warn(`[Bots] missing items (not in items lookup): ${[...missingItems].join(", ")}`);
  }

  const botIds = [...botSlugToId.values()];

  if (botIds.length > 0) {
    await supabaseService.from("bot_maps").delete().in("bot_id", botIds);
    await supabaseService.from("bot_drops").delete().in("bot_id", botIds);
  }

  if (botMapRows.length > 0) {
    for (let i = 0; i < botMapRows.length; i += BATCH_SIZE) {
      const batch = botMapRows.slice(i, i + BATCH_SIZE);
      const { error } = await supabaseService.from("bot_maps").insert(batch);
      if (error) {
        console.error("[Bots] bot_maps insert error:", error);
      }
    }
    console.log(`[Bots] inserted ${botMapRows.length} bot_maps relations`);
  }

  if (botDropRows.length > 0) {
    for (let i = 0; i < botDropRows.length; i += BATCH_SIZE) {
      const batch = botDropRows.slice(i, i + BATCH_SIZE);
      const { error } = await supabaseService.from("bot_drops").insert(batch);
      if (error) {
        console.error("[Bots] bot_drops insert error:", error);
      }
    }
    console.log(`[Bots] inserted ${botDropRows.length} bot_drops relations`);
  }

  console.log("[Bots] ingestion complete");

  return botSlugToId;
}
