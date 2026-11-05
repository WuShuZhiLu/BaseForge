# Changelog

[简体中文](./CHANGELOG.md)

This file is maintained by hand; the release process only quotes the corresponding version section as the release notes.

Format:

- `## Unreleased` always stays at the top: record additions, fixes and changes for the next release; entries may reference issues and commits.
- When releasing, rename `## Unreleased` to `## vX.Y.Z - YYYY-MM-DD` and add a fresh empty `## Unreleased` above it.
- Group entries by type: Added / Fixed / Improved / Docs / Refactored / Other.

## Unreleased

## v0.1.0 - 2026-11-05

BaseForge forked from nowen note **v1.4.16** and absorbed the functional and framework updates of upstream **v1.5.1** (sync engine, encrypted notes / encrypted blocks, task center, plugin platform foundation, notifications / comments / trash, data management / backup, note appearance themes, i18n, and more). The entries below cover the changes BaseForge made after the fork. The first alpha release ships a Docker image only — no desktop or mobile builds.

### Added

**Documents & blocks**

- Knowledge bases now support six document formats: Markdown, rich text, plain text (`contentFormat plain`), board (`contentFormat board` + Excalidraw editor), mind map (normalized as a knowledge-base document, migration 131) and lightweight sheet. The create menu offers type selection and create-then-rename; `.txt` stays plain text.
- Block embeds: boards (`![[board:<id>]]`), mind maps and lightweight sheets (`![[sheet:id]]`) can be inserted into rich text as reference blocks and mixed with paragraphs. All three embed cards share a code-block-style shell that follows the app theme; block handles now manage atomic and embedded blocks, and the Markdown reference round-trip is complete.
- Anonymous documents: inserted blocks become anonymous immediately, with reference-count GC and filtering across the whole chain. Knowledge-tree deep links for mind maps and sheets, post-creation rename, and instant refresh after version restore.
- Word imports become document content (DocxIR → Tiptap adapter, original file kept as an attachment, fallback report). PDF keeps the original plus an annotation layer (controlled paginated viewer, page-anchored annotations).
- Import and export: Yuque import, Word/PDF import, Excel/CSV → lightweight sheet, multi-format export of folders, and localizing remote images.

**Knowledge bases & spaces**

- Knowledge base v2: single-tree inline expansion, library overview page, in-library tree space and the two-level `/kb/:id` entry state; overview statistics are aggregated server-side (document count, non-whitespace word count, contributors).
- Knowledge tree: drag and drop with before/after drop targets, favorites (scoped to the focused range), rename, create, copy-as-reference instead of duplicate, and multi-format folder export. Document pinning removed.
- Spaces: avatar upload and cropping, member management (search to add, owner transfer, invite code reset), and attachment share links (password, expiration, usage limit, revoked on close).

**Editor**

- Block-based rich text: column drag-to-resize, highlight blocks, emoji, collapsible blocks, block dragging and block-handle menus, copy and paste; `locateBlock` now falls back for atomic blocks.
- Split editing (full-width tab bar + full-width toolbar, two panes bound to fixed documents), unified find/replace popover (regex capture groups, live debounce), three-state outline popover, Markdown preview by default, default code-block theme following light/dark mode, and consistent blockquote height.
- Version history v2: automatic/manual versions, retention policies, two-phase attachment GC. The panel is rebuilt with adaptive sizing, multi-format previews, line-level diff and publishing; save semantics are tightened so only explicit actions create versions while ordinary edits stay as local drafts.

**Framework & navigation**

- The Rail now switches sidebar panels, with account actions consolidated in the user menu; sidebar panel framework, panel content layer and tool tabs (keepAlive), plus the "Open editors" tabs at the bottom of the sidebar.
- Rail tool group consolidated, tool entries moved to the bottom sidebar toolbar; mind map center removed from primary navigation; "File Management" renamed to "Attachments"; badge groups support drag sorting, and the two display modes keep icons at zero scale and zero shift.
- Three-region coordination, favorites merged into the knowledge base panel, plugin workspace and module path routing; a single route owner `AppRouteSync`, tab persistence with dead-tab 404 self-healing, and open/close routed through the load coordinator.

**Modules & plugins**

- Share Center: one unified list for five share channels, default expiration, attachment visitor page; icons differentiated by file type and single-select categories.
- File Manager: rebuilt around three sources (mutually exclusive sources, complete filters, upload routing, synced counts), document reference categories, batch archiving, video posters, and sidebar category/sort/view/group settings.
- Trash: upgraded to a recovery center with previews for all content types, restore to a chosen location, multi-select type filter as a trigger row with a two-column checkbox popover, and sidebar sorting.
- Plugin platform: contribution contract and runtime, editor command contribution point, external-domain allowlist (exact domains only) with rate limiting and rejection auditing, authorization page showing external domains, marketplace / manage / configure three-section layout, real source labels for built-in plugins, and plugins inherited from upstream disabled by default.
- Project management plugin (projects / work items / kanban + activity feed + two-way git sync); remote files plugin (WebDAV / SMB / Baidu Netdisk connections to remote NAS, with read, edit and write-back; work in progress, read-only types and unsupported formats excluded).

### Improved

- Design language: the sidebar handles navigation only and the main area holds content only; File Manager, Share Center, Trash and Plugins share the 48/40 rhythm and the same sidebar filters, with the type filter extracted into a shared component; section headers use a solid dot at 12px/600 and Rail rows follow the global spec.
- Icons across the app: unified knowledge-tree icons, semantic node colors, solid folder / knowledge-base style, line-art treatment; knowledge base covers can change color; the insert-mind-map button uses the official icon.
- Runtime: `better-sqlite3` fully replaced by built-in `node:sqlite`, the dev chain pinned to Node.js 22+ with ABI detection; native `confirm` replaced by in-app confirmation dialogs (including a single-button alert API).
- Multiple domain audits after the 1.5.1 integration: sync engine, backup / web clipper, mind map / comments / multi-platform bridge, dead-code cleanup in the routing and tab chain, plus incremental integration of four upstream features.

### Fixed

- Knowledge base entry state: bouncing back from empty libraries, lost selection, URL losing focus, freezes on fast switching, drop targets and cross-library drags, split-view same-document and scroll position, stale `/notes/:id` URLs and an unreset editor after closing all tabs.
- Editor: accidental deletion in Markdown, broken export menu clicks, rich-text paste, note theme and note color toggles having no effect, color markers unified as vertical bars, missing toolbar collapse button, mind maps failing to open and Esc to go back, encrypted entry placement.
- Plugin contract aligned with the host schema, allowlist accepting exact domains only, sidebar panel runtime limits, install navigation / domain list visibility / slash-menu examples, sidebar restoration and empty-state fixes.
- Backup crashes and leftover gaps after the `node:sqlite` migration, share-link copy compatibility, short URLs with trailing slashes normalized, the medium-width window forcing the note list open, and Windows dev dependency `spawn EINVAL`.
