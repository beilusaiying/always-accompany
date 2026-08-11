import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));
const SELF = fileURLToPath(import.meta.url);
const SOURCE_EXTENSIONS = new Set(['.js', '.mjs', '.ts', '.json', '.jsonc', '.yaml', '.yml', '.toml']);
const EXCLUDED_DIRECTORIES = new Set([
  '.git', 'node_modules', 'data', 'dist', 'build', 'coverage', 'vendor', 'output',
]);
const EXCLUDED_FILES = new Set([
  SELF,
  path.join(REPO_ROOT, 'scripts', 'release', 'release-manifest.json'),
]);
const FORBIDDEN_PATHS = [
  ['repository-external personal log directory', /\.\.[\\/]beilu的工作日志和项目日志(?:[\\/]|['"`])/i],
  ['personal Windows workspace', /[A-Za-z]:[\\/](?:project|shajiuguan|测试)(?:[\\/]|['"`])/i],
  ['hard-coded Windows temp artifact', /[A-Za-z]:[\\/]tmp[\\/][^'"`\r\n]+/i],
  ['personal Windows user home', /[A-Za-z]:[\\/]Users[\\/](?!Public(?:[\\/]|$))[^\\/'"`\r\n]+/i],
];

async function collectSourceFiles(directory, output = []) {
  for await (const entry of Deno.readDir(directory)) {
    if (entry.isDirectory && EXCLUDED_DIRECTORIES.has(entry.name)) continue;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory) await collectSourceFiles(absolute, output);
    else if (entry.isFile && SOURCE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) output.push(absolute);
  }
  return output;
}

Deno.test('source/config/test files contain no personal absolute or external-worklog paths', async () => {
  const violations = [];
  for (const file of await collectSourceFiles(REPO_ROOT)) {
    if (EXCLUDED_FILES.has(file) || file.endsWith('package-lock.json')) continue;
    const source = await Deno.readTextFile(file);
    const lines = source.split(/\r?\n/);
    for (let index = 0; index < lines.length; index++) {
      const candidate = lines[index].trim();
      if (candidate.startsWith('//') || candidate.startsWith('*') || candidate.startsWith('/*')) continue;
      for (const [label, pattern] of FORBIDDEN_PATHS) {
        if (pattern.test(candidate)) {
          violations.push(`${path.relative(REPO_ROOT, file)}:${index + 1} [${label}] ${candidate}`);
        }
      }
    }
  }
  assert.deepEqual(violations, [], `personal/local paths must use URL/path/env APIs:\n${violations.join('\n')}`);
});
