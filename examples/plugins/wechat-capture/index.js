// Host owns consent, destination selection, and the persistent capture queue.
globalThis.__baseforgePluginModule = { actions: {
  "capture-article": async ({ input, baseforge }) => {
    const key = `assistant:${input.itemId}`;
    const prior = await baseforge.storage.get({ key });
    if (prior) return prior;
    const note = await baseforge.capture.importUrl({ url: input.url, notebookId: input.notebookId });
    await baseforge.storage.set({ key, value: note });
    return note;
  },
} };
