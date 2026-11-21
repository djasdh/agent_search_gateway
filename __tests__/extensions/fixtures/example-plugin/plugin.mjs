/**
 * 测试夹具：一个中性的示例插件入口。
 *
 * 只通过 setup(ctx) 使用宿主原语，不 import 任何网关内部模块。
 */
export async function setup(ctx) {
  ctx.log(`example-plugin: action=${ctx.action}`);
  ctx.progress("checking", ctx.plugin.id);

  if (ctx.action === "uninstall") {
    const removed = await ctx.backendState.read("demo");
    await ctx.backendState.clear("demo");
    ctx.log("example-plugin: uninstall done");
    return { action: ctx.action, removed };
  }

  const backendDir = ctx.paths.backendDir("demo");
  await ctx.mkdir(backendDir, { recursive: true });
  const marker = `${backendDir}/marker.txt`;
  await ctx.writeFile(marker, "hello from setup\n");

  const before = await ctx.state.read();
  await ctx.state.write({ installed: true, action: ctx.action });
  await ctx.backendState.write("demo", { version: ctx.plugin.version });

  ctx.progress("done", backendDir);
  return {
    action: ctx.action,
    backends: [...ctx.backends],
    plugin: ctx.plugin,
    host: ctx.host,
    pluginDir: ctx.paths.pluginDir,
    dataDir: ctx.paths.dataDir,
    tempDir: ctx.paths.tempDir,
    marker: await ctx.readFile(marker),
    before,
    backendState: await ctx.backendState.read("demo"),
  };
}
