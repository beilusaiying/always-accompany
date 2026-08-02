const esbuild = require("esbuild");

const isWatch = process.argv.includes("--watch");

/** @type {import('esbuild').BuildOptions} */
const buildOptions = {
  entryPoints: ["src/extension.ts"],
  bundle: true,
  outfile: "dist/extension.js",
  external: ["vscode"],
  format: "cjs",
  platform: "node",
  target: "node18",
  sourcemap: true,
  minify: false,
};

/** @type {import('esbuild').BuildOptions} */
const workerBuildOptions = {
  entryPoints: ["src/services/tools/node-search-worker.ts"],
  bundle: true,
  outfile: "dist/node-search-worker.js",
  format: "cjs",
  platform: "node",
  target: "node18",
  sourcemap: true,
  minify: false,
};

async function main() {
  if (isWatch) {
    const [extensionCtx, workerCtx] = await Promise.all([
      esbuild.context(buildOptions),
      esbuild.context(workerBuildOptions),
    ]);
    await Promise.all([extensionCtx.watch(), workerCtx.watch()]);
    console.log("[YonBan] 监听模式已启动...");
  } else {
    await Promise.all([
      esbuild.build(buildOptions),
      esbuild.build(workerBuildOptions),
    ]);
    console.log("[YonBan] 构建完成");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
