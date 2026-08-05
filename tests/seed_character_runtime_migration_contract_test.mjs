import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const authSource = fs.readFileSync(
	path.join(repoRoot, "src/yonban/core/functions/security/auth.mjs"),
	"utf8",
);

const normalizedSha256 = (text) => crypto.createHash("sha256")
	.update(String(text).replace(/\r\n/g, "\n"))
	.digest("hex");

Deno.test("legacy seed character migration is exact, bounded, and idempotent", () => {
	assert.match(authSource, /LEGACY_SEED_CHAR_MAIN_SHA256\s*=\s*['"]194114873c67a675799987721f73c650775d5c85b5e737f19239dd1643d374cb['"]/);
	assert.match(authSource, /FIXED_SEED_CHAR_MAIN_SHA256\s*=\s*['"]d2253a266aea5999ddebeed43dec8efa770aa5df85846caa501091996c373ed2['"]/);
	assert.match(authSource, /path\.join\(userdir,\s*['"]chars['"],\s*['"]新的开始['"],\s*['"]main\.mjs['"]\)/);
	assert.match(authSource, /normalizedTextSha256\(target\)\s*!==\s*LEGACY_SEED_CHAR_MAIN_SHA256/);
	assert.match(authSource, /normalizedTextSha256\(template\)\s*!==\s*FIXED_SEED_CHAR_MAIN_SHA256/);
	assert.match(authSource, /nicerWriteFileSync\(target,\s*fs\.readFileSync\(template\)\)/);
	assert.doesNotMatch(authSource, /migrateKnownSeedCharacterRuntime[\s\S]{0,1800}chardata\.json/);

	const template = fs.readFileSync(
		path.join(repoRoot, "default/templates/user/chars/新的开始/main.mjs"),
		"utf8",
	);
	assert.equal(
		normalizedSha256(template),
		"d2253a266aea5999ddebeed43dec8efa770aa5df85846caa501091996c373ed2",
		"the guarded replacement hash must match the shipped fixed template",
	);
	assert.doesNotMatch(template, /wrapUntrusted\s*\(/,
		"the fixed seed runtime must not mark user-authored character fields as external content");
});
