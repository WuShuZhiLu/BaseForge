// Hello BaseForge —— 最小 sandbox-js 示例入口。
// manifest.json 的 actions[].id 与此处的 actions 键一一对应。
globalThis.__baseforgePluginModule = {
  actions: {
    hello: async ({ input }) => {
      const name = input && typeof input.name === "string" && input.name.trim()
        ? input.name.trim()
        : "BaseForge";
      // 演示 external:fetch 白名单的声明（api.example.com 在 permissionConfig.externalFetchHosts 里），
      // 示例本身不发起真实请求，直接返回问候语。
      return { greeting: `Hello, ${name}!` };
    },
  },
};
