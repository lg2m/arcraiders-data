import fs from "node:fs";
import path from "node:path";

import { z } from "zod";

import { supabaseService } from "./lib/supabase-client";
import { contentHash, readJson, readJsonArray } from "./lib/utils";
import { mapIdEnumSchema, upsertMaps } from "./ingest/maps";
import { upsertItems } from "./ingest/items";
import { upsertBots } from "./ingest/bots";
import { traderIdEnumSchema, upsertTraders } from "./ingest/traders";

const hideoutIdEnumSchema = z.enum(["workbench", "gunsmith", "utility_station", "stash", "scrappy", "refiner", "medical_lab", "explosives_station", "gear_bench"]);

const hideoutSchema = z.object({
  id: hideoutIdEnumSchema,
  name: z.string(),
  image: z.url().nullable(),
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
  )
});

const tradeSchema = z.object({
  traderId: traderIdEnumSchema,
  itemId: z.string(),
  quantity: z.number(),
  cost: z.object({
    itemId: z.string(),
    quantity: z.number(),
  }),
  dailyLimit: z.number().nullable()
});

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
          quantity: z.number()
        })
      ),
      requirementCategories: z.array(
        z.object({
          category: z.string(),
          valueRequired: z.number()
        })
      )
    })
  )
});

const questSchema = z.object({
  id: z.string(),
  updatedAt: z.string(),
  videoUrl: z.url().nullable(),
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

function toId(str: string) {
  return str
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_");
}

async function upsertTrades(baseDir: string) {
  const file = path.join(baseDir, 'trades.json');
  const trades = readJsonArray(file, tradeSchema);

  console.log(`Ingesting ${trades.length} trades`);

  // Ensure items exist for all seen itemIds
  const allItemIds = new Set<string>();
  for (const t of trades) {
    allItemIds.add(t.itemId);
    allItemIds.add(t.cost.itemId);
  }
  await supabaseService
    .from('items')
    .upsert([...allItemIds].map((id) => ({ id })), { onConflict: 'id' });

  for (const t of trades) {
    const { error: coreErr } = await supabaseService
      .from('trades')
      .upsert(
        {
          trader_id: t.traderId,
          item_id: t.itemId,
          quantity: t.quantity,
          cost_item_id: t.cost.itemId,
          cost_quantity: t.cost.quantity,
          daily_limit: t.dailyLimit ?? null,
          source_json: t as any
        },
        { onConflict: 'trader_id,item_id,cost_item_id' }
      );
    if (coreErr) {
      console.error('trades upsert error', t.traderId, t.itemId, coreErr);
    }
  }
}

async function upsertProjects(baseDir: string) {
  const file = path.join(baseDir, "projects.json");
  const projects = readJsonArray(file, projectSchema);

  console.log(`Ingesting ${projects.length} projects`);

  for (const p of projects) {
    const { error: coreErr } = await supabaseService
      .from('projects')
      .upsert(
        {
          id: p.id,
          name: p.name,
          description: p.description,
          source_json: p as any
        },
        { onConflict: 'id' }
      );
    if (coreErr) {
      console.error('projects upsert error', p.id, coreErr);
      continue;
    }

    const { data: existingPhases, error: existingErr } = await supabaseService
      .from('project_phases')
      .select('id, phase_number')
      .eq('project_id', toId(p.id));

    if (existingErr) {
      console.error('project_phases fetch error', p.id, existingErr);
      continue;
    }

    if (existingPhases && existingPhases.length > 0) {
      const ids = existingPhases.map((ph) => ph.id);
      await supabaseService.from('project_phase_items').delete().in('phase_id', ids);
      await supabaseService
        .from('project_phase_value_requirements')
        .delete()
        .in('phase_id', ids);
      await supabaseService.from('project_phases').delete().eq('project_id', toId(p.id));
    }

    for (const phase of p.phases) {
      const { data: inserted, error: insErr } = await supabaseService
        .from('project_phases')
        .insert(
          {
            project_id: p.id,
            phase_number: phase.phase,
            name: phase.name,
            description: phase.description,
          }
        )
        .select('id')
        .single();

      if (insErr || !inserted) {
        console.error('project_phases insert error', p.id, phase.phase, insErr);
        continue;
      }

      const phaseId = inserted.id;

      // Item requirements
      if (phase.requirementItemIds.length > 0) {
        // Ensure items exist
        const ids = phase.requirementItemIds.map((r) => r.itemId);
        await supabaseService
          .from('items')
          .upsert([...new Set(ids)].map((id) => ({ id })), { onConflict: 'id' });

        await supabaseService.from('project_phase_items').insert(
          phase.requirementItemIds.map((r) => ({
            phase_id: phaseId,
            item_id: r.itemId,
            quantity: r.quantity
          }))
        );
      }

      // Value requirements
      if (phase.requirementCategories.length > 0) {
        await supabaseService.from('project_phase_value_requirements').insert(
          phase.requirementCategories.map((rc) => ({
            phase_id: phaseId,
            category: rc.category,
            value_required: rc.valueRequired
          }))
        );
      }
    }
  }
}

async function upsertQuests(baseDir: string) {
  const questsDir = path.join(baseDir, "quests");
  if (!fs.existsSync(questsDir)) {
    console.warn(`quests directory not found at ${questsDir}`);
    return;
  }

  const files = fs
    .readdirSync(questsDir)
    .filter((f) => f.endsWith('.json'));

  console.log(`Ingesting ${files.length} quest JSON files`);

  const quests: z.infer<typeof questSchema>[] = [];
  for (const file of files) {
    const fullPath = path.join(questsDir, file);
    const quest = readJson(fullPath, questSchema);
    if (quest) {
      quests.push(quest);
    }
  }

  const itemIds = new Set<string>();
  const mapIds = new Set<string>();

  for (const q of quests) {
    q.mapIds.forEach((m) => mapIds.add(m));
    q.requiredItemIds.forEach((ri) => itemIds.add(ri.itemId));
    q.grantedItemIds.forEach((gi) => itemIds.add(gi.itemId));
    q.rewardItemIds.forEach((ri) => itemIds.add(ri.itemId));
  }

  if (itemIds.size > 0) {
    await supabaseService
      .from('items')
      .upsert(
        [...itemIds].map((id) => ({ id })),
        { onConflict: 'id' }
      );
  }

  if (mapIds.size > 0) {
    await supabaseService
      .from('maps')
      .upsert(
        [...mapIds].map((id) => ({ id })),
        { onConflict: 'id' }
      );
  }

  // Upsert quests + child tables
  for (const q of quests) {
    // Upsert quest core row
    const { error: questErr } = await supabaseService
      .from('quests')
      .upsert(
        {
          id: q.id,
          name: q.name,
          trader_id: q.traderId,
          description: q.description,
          xp: q.xp,
          source_json: q as any
        },
        { onConflict: 'id' }
      );

    if (questErr) {
      console.error('quests upsert error', q.id, questErr);
      continue;
    }

    // quest_maps
    await supabaseService.from('quest_maps').delete().eq('quest_id', q.id);
    if (q.mapIds.length > 0) {
      const mapRows = q.mapIds.map((mapId) => ({
        quest_id: q.id,
        map_id: mapId
      }));
      const { error } = await supabaseService.from('quest_maps').insert(mapRows);
      if (error) console.error('quest_maps insert error', q.id, error);
    }

    // quest_objectives
    await supabaseService.from('quest_objectives').delete().eq('quest_id', q.id);
    if (q.objectives.length > 0) {
      const objectiveRows = q.objectives.map((text, index) => ({
        quest_id: q.id,
        index_in_quest: index,
        text
      }));
      const { error } = await supabaseService
        .from('quest_objectives')
        .insert(objectiveRows);
      if (error) console.error('quest_objectives insert error', q.id, error);
    }

    // quest_other_requirements
    await supabaseService.from('quest_other_requirements').delete().eq('quest_id', q.id);
    if (q.otherRequirements.length > 0) {
      const reqRows = q.otherRequirements.map((text, index) => ({
        quest_id: q.id,
        index_in_quest: index,
        text
      }));
      const { error } = await supabaseService
        .from('quest_other_requirements')
        .insert(reqRows);
      if (error) console.error('quest_other_requirements insert error', q.id, error);
    }

    // quest_items – required, granted, reward
    await supabaseService.from('quest_items').delete().eq('quest_id', q.id);

    const questItemRows: {
      quest_id: string;
      item_id: string;
      quantity: number;
      kind: 'required' | 'granted' | 'reward';
    }[] = [];

    for (const ri of q.requiredItemIds) {
      questItemRows.push({
        quest_id: q.id,
        item_id: ri.itemId,
        quantity: ri.quantity,
        kind: 'required'
      });
    }
    for (const gi of q.grantedItemIds) {
      questItemRows.push({
        quest_id: q.id,
        item_id: gi.itemId,
        quantity: gi.quantity,
        kind: 'granted'
      });
    }
    for (const ri of q.rewardItemIds) {
      questItemRows.push({
        quest_id: q.id,
        item_id: ri.itemId,
        quantity: ri.quantity,
        kind: 'reward'
      });
    }

    if (questItemRows.length > 0) {
      const { error } = await supabaseService.from('quest_items').insert(questItemRows);
      if (error) console.error('quest_items insert error', q.id, error);
    }

    // quest_relations – previous & next
    await supabaseService.from('quest_relations').delete().eq('quest_id', q.id);

    const relationRows: {
      quest_id: string;
      related_quest_id: string;
      kind: 'previous' | 'next';
    }[] = [];

    for (const prevId of q.previousQuestIds) {
      relationRows.push({
        quest_id: q.id,
        related_quest_id: prevId,
        kind: 'previous'
      });
    }
    for (const nextId of q.nextQuestIds) {
      relationRows.push({
        quest_id: q.id,
        related_quest_id: nextId,
        kind: 'next'
      });
    }

    if (relationRows.length > 0) {
      const { error } = await supabaseService
        .from('quest_relations')
        .insert(relationRows);
      if (error) console.error('quest_relations insert error', q.id, error);
    }
  }

  console.log('Quest ingest complete');
}

async function upsertHideoutBenches(baseDir: string) {
  const hideoutDir = path.join(baseDir, "hideout");
  if (!fs.existsSync(hideoutDir)) {
    console.warn(`hideout directory not found at ${hideoutDir}`);
    return;
  }

  const files = fs
    .readdirSync(hideoutDir)
    .filter((f) => f.endsWith('.json'));

  console.log(`Ingesting ${files.length} hideout JSON files`);

  const benches: z.infer<typeof hideoutSchema>[] = [];
  for (const file of files) {
    const fullPath = path.join(hideoutDir, file);
    const bench = readJson(fullPath, hideoutSchema);
    if (bench) {
      benches.push(bench);
    }
  }


  for (const b of benches) {
    await supabaseService.from("benches").upsert({
      id: b.id,
      name: b.name,
      image_uri: b.image,
      max_level: b.maxLevel,
      source_json: b,
    },
      { onConflict: "id" });

    const { data: existing, error: existingErr } = await supabaseService.from("bench_levels").select("id").eq("bench_id", b.id);
    if (existingErr) {
      console.error(existingErr);
    }

    if (existing) {
      const ids = existing.map((l) => l.id);
      await supabaseService.from("bench_level_items").delete().in("level_id", ids);
      await supabaseService.from("bench_levels").delete().eq("bench_id", b.id);
    }

    for (const lvl of b.levels) {
      const { data: insertedLevel, error: insErr } = await supabaseService
        .from("bench_levels")
        .insert(
          {
            bench_id: b.id,
            level: lvl.level,
            description: lvl.description,
          }
        )
        .select("id")
        .single();

      if (insErr || !insertedLevel) {
        console.error("Error inserting bench level", b.id, lvl.level, insErr);
        continue;
      }

      // upsert items
      const levelId = insertedLevel.id;

      for (const r of lvl.requirementItemIds) {
        // ensure item exists
        await supabaseService.from("items").upsert({ id: r.itemId }, { onConflict: "id" });

        await supabaseService.from("bench_level_items").insert({
          level_id: levelId,
          item_id: r.itemId,
          quantity: r.quantity
        });
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

  // rest have multi deps

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
  console.log("=".repeat(60));
  console.log(`Ingestion complete in ${elapsed}s`);
  console.log("=".repeat(60));

  console.log("\nLookup sizes:");
  console.log(`  Maps:  ${mapLookup.size}`);
  console.log(`  Items: ${itemLookup.size}`);
  console.log(`  Bots:  ${botLookup.size}`);
  console.log(`  Traders: ${traderLookup.size}`);
}

main().catch(console.error);
