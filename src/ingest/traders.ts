import path from "node:path";
import type { UUID } from "node:crypto";

import { z } from "zod";

import { contentHash, readJsonArray } from "../lib/utils";
import { supabaseService } from "../lib/supabase-client";

export const traderIdEnumSchema = z.enum(["apollo", "celeste", "lance", "shani", "tian_wen"]);

const traderSchema = z.object({
  id: traderIdEnumSchema,
  name: z.enum(["Apollo", "Celeste", "Lance", "Shani", "Tian Wen"]),
  description: z.string(),
  image: z.url(),
});

type RawTrader = z.infer<typeof traderSchema>;

interface TraderRow {
  slug: string;
  name: string;
  description: string;
  image_url: string;
  content_hash: string;
  source_json: RawTrader;
}

function transformToRow(trader: RawTrader): TraderRow {
  return {
    slug: trader.id,
    name: trader.name,
    description: trader.description,
    image_url: trader.image,
    content_hash: contentHash(trader),
    source_json: trader,
  };
}

export async function upsertTraders(baseDir: string): Promise<Map<string, UUID>> {
  const file = path.join(baseDir, "traders.json");
  const traders = readJsonArray(file, traderSchema);

  if (!traders || traders.length === 0) {
    console.warn("[Traders] no traders found or failed to parse");
    return new Map();
  }

  console.log(`[Traders] found ${traders.length} traders`);

  // Fetch existing for change detection
  const { data: existing, error: fetchErr } = await supabaseService
    .from("traders")
    .select("id, slug, content_hash");

  if (fetchErr) {
    console.error("[Traders] error fetching existing:", fetchErr);
    return new Map();
  }

  const existingBySlug = new Map(
    existing?.map((r) => [r.slug, { id: r.id, hash: r.content_hash }]) ?? []
  );

  // Determine which need upsert
  const toUpsert: TraderRow[] = [];
  const unchanged: string[] = [];

  for (const trader of traders) {
    const row = transformToRow(trader);
    const existing = existingBySlug.get(row.slug);

    if (existing?.hash === row.content_hash) {
      unchanged.push(row.slug);
      continue;
    }

    toUpsert.push(row);
  }

  console.log(`[Traders] ${unchanged.length} unchanged, ${toUpsert.length} to upsert`);

  // Upsert (no batching needed for ~5 traders)
  if (toUpsert.length > 0) {
    const { error } = await supabaseService
      .from("traders")
      .upsert(toUpsert, { onConflict: "slug" });

    if (error) {
      console.error("[Traders] upsert error:", error);
    }
  }

  // Build and return lookup
  return getTraderLookup();
}

export async function getTraderLookup(): Promise<Map<string, UUID>> {
  const { data, error } = await supabaseService
    .from("traders")
    .select("id, slug");

  if (error) {
    console.error("[Traders] error fetching lookup:", error);
    return new Map();
  }

  const lookup = new Map<string, UUID>(
    data?.map((r) => [r.slug, r.id]) ?? []
  );

  console.log(`[Traders] built slug→id lookup with ${lookup.size} traders`);
  return lookup;
}
