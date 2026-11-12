import React from "react";

export const OPEN_KNOWLEDGE_TREE_EVENT = "baseforge:open-knowledge-tree";

/**
 * Compatibility mount kept for older imports.
 *
 * The unified knowledge tree now lives inside the existing SidebarMobile on both
 * desktop and mobile. Opening/focusing it is handled by SidebarMobile so this mount
 * must not render a second drawer or floating launcher.
 */
export default function KnowledgeTreeDrawer() {
  return null;
}
