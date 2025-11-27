import fs from "node:fs";
import path from "node:path";

interface FieldInfo {
	count: number;
	types: Set<string>;
	samples: unknown[];
	nullable: boolean;
}

function getType(value: unknown): string {
	if (value === null) {
		return "null";
	}
	if (Array.isArray(value)) {
		if (value.length === 0) {
			return "array<unknown>";
		}
		const innerTypes = [...new Set(value.map(getType))];
		return `array<${innerTypes.join("|")}>`;
	}
	if (typeof value === "object") {
		const keys = Object.keys(value).sort().join(",");
		return `object{${keys}}`;
	}
	return typeof value;
}

function analyzeItemsDir(itemsDir: string) {
	const fields = new Map<string, FieldInfo>();
	const files = fs.readdirSync(itemsDir).filter((f) => f.endsWith(".json"));

	console.log(`Scanning ${files.length} item files...\n`);

	for (const file of files) {
		const raw = fs.readFileSync(path.join(itemsDir, file), "utf-8");
		const item = JSON.parse(raw);

		for (const [key, value] of Object.entries(item)) {
			if (!fields.has(key)) {
				fields.set(key, {
					count: 0,
					types: new Set(),
					samples: [],
					nullable: false,
				});
			}

			const info = fields.get(key)!;
			info.count++;
			info.types.add(getType(value));

			if (value === null) {
				info.nullable = true;
			} else if (info.samples.length < 3) {
				// Keep up to 3 unique non-null samples
				const sampleStr = JSON.stringify(value);
				if (!info.samples.some((s) => JSON.stringify(s) === sampleStr)) {
					info.samples.push(value);
				}
			}
		}
	}

	// sort by frequency descending
	const sorted = [...fields.entries()].sort((a, b) => b[1].count - a[1].count);

	console.log("=".repeat(80));
	console.log("ANALYSIS");
	console.log("=".repeat(80));

	for (const [key, info] of sorted) {
		const pct = ((info.count / files.length) * 100).toFixed(1);
		const nullable = info.nullable ? " (nullable)" : "";
		const types = [...info.types].join(" | ");

		console.log(`\n${key}`);
		console.log(
			`  Present: ${info.count}/${files.length} (${pct}%)${nullable}`,
		);
		console.log(`  Types: ${types}`);
		console.log(`  Samples: ${JSON.stringify(info.samples).slice(0, 200)}`);
	}

	console.log("\n" + "=".repeat(80));
	console.log("SUMMARY");
	console.log("=".repeat(80));

	const required = sorted.filter(([_, info]) => info.count === files.length);
	const common = sorted.filter(
		([_, info]) =>
			info.count >= files.length * 0.5 && info.count < files.length,
	);
	const sparse = sorted.filter(([_, info]) => info.count < files.length * 0.5);

	console.log(
		`\nRequired fields (100%): ${required.map(([k]) => k).join(", ")}`,
	);
	console.log(
		`\nCommon fields (50-99%): ${common.map(([k, info]) => `${k}(${info.count})`).join(", ")}`,
	);
	console.log(
		`\nSparse fields (<50%): ${sparse.map(([k, info]) => `${k}(${info.count})`).join(", ")}`,
	);
}

function main() {
	analyzeItemsDir("./data/items");
}

main();
