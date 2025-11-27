import { createHash } from "node:crypto";
import fs from "node:fs";

import { z } from "zod";

export function contentHash(obj: unknown): string {
	const stable = JSON.stringify(obj, Object.keys(obj as object).sort());
	return createHash("sha256").update(stable).digest("hex").slice(0, 16);
}

export function readJson<T>(filePath: string, schema: z.ZodType<T>): T {
	const raw = fs.readFileSync(filePath, "utf-8");
	const parsed = JSON.parse(raw);
	const result = schema.safeParse(parsed);
	if (!result.success) {
		console.error(`[Error] Failed parsing ${filePath}`, result.error.issues);
		throw new Error("Schema parse error");
	}
	return result.data;
}

export function readJsonArray<T>(filePath: string, schema: z.ZodType<T>): T[] {
	const raw = fs.readFileSync(filePath, "utf-8");
	const parsed = JSON.parse(raw);
	const result = schema.array().safeParse(parsed);
	if (!result.success) {
		console.error(`[Error] Failed parsing ${filePath}`, result.error.issues);
		throw new Error("Schema parse error");
	}
	return result.data;
}
