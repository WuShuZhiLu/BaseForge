import type { Migration } from "./migrations.impl.js";

export const NOTEBOOK_IS_FAVORITE_SCHEMA_VERSION = 132;

export const notebookIsFavoriteMigration: Migration = {
  version: NOTEBOOK_IS_FAVORITE_SCHEMA_VERSION,
  name: "notebook-is-favorite",
  up: (db) => {
    const columns = db.prepare("PRAGMA table_info(notebooks)").all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === "isFavorite")) {
      db.prepare("ALTER TABLE notebooks ADD COLUMN isFavorite INTEGER NOT NULL DEFAULT 0").run();
    }
  },
};
