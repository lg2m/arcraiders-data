import path from "node:path";

import { upsertMaps } from "./ingest/maps";
import { upsertItems } from "./ingest/items";
import { upsertBots } from "./ingest/bots";
import { upsertTraders } from "./ingest/traders";
import { upsertTrades } from "./ingest/trades";
import { upsertBenches } from "./ingest/hideout";
import { upsertQuests } from "./ingest/quests";
import { upsertProjects } from "./ingest/projects";

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
	const questLookup = await upsertQuests(baseDir, {
		items: itemLookup,
		maps: mapLookup,
		traders: traderLookup,
	});
	console.log();

	// projects - depends on items
	const projectLookup = await upsertProjects(baseDir, { items: itemLookup });
	console.log();

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
	console.log(`  Projects: ${projectLookup.size}`);
}

main().catch(console.error);
