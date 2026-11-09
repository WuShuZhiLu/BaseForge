# Changelog

[简体中文](./CHANGELOG.md)

This file is maintained by hand; the release process only quotes the corresponding version section as the release notes.

Format:

- `## Unreleased` always stays at the top: record additions, fixes and changes for the next release; entries may reference issues and commits.
- When releasing, rename `## Unreleased` to `## vX.Y.Z - YYYY-MM-DD` and add a fresh empty `## Unreleased` above it.
- Group entries by type: Added / Fixed / Improved / Docs / Refactored / Other.
- Trailing short hashes reference the corresponding commits; issues are marked as `#N`.

## Unreleased

0.2.0 is in development. This section currently records the main changes to date; remaining entries will be added before release.

### Added

**Remote documents (core capability)**

- WebDAV onboarding now matches SMB: connection validation plus directory browsing to pick a root path, support for multiple root directories, and a fix for being unable to return to the root. SMB switched to `smb3-client` for share auto-discovery, multiple shares per configuration, and credentials moved to a separate secret store (`333d9eca6`, `be1a47dd5`, `28b527c7f`, `af06c6cdc`)
- Remote documents can be linked into a knowledge base on demand; linked notes carry a cloud badge consistently across the tree, overview, search and favorites (`91d34c955`, `84bfd74be`, `1d62b7157`)
- Remote files moved from a builtin plugin to a core capability: no enable/disable toggle, with a fixed entry at Files → Sources → Remote Files (`7b456c9cd`)

**MCP as the external interface**

- MCP server repackaged as a single file with pure token authentication and consistent BaseForge branding; dead tools left over from AI chat removed, remote-file / export-share tools and token scopes completed (`80b943b38`, `c38a13a0c`)

**Multi-format documents**

- PDF editor switched to continuous scrolling with highlight, note, rectangle, arrow and freehand annotations; toolbar atoms extracted for reuse across editor types (`1b255b1d0`, `a8ec4d0fb`)
- Word original preview switched to high-fidelity `docx-preview` rendering, with a dedicated `contentFormat=docx` path and a simplified empty-library entry (`29b9f8660`, `2e67e8864`)
- Excel import added, routed through the official knowledge-tree sheet path, and the generated sheet opens automatically (`2a898b392`, `149e08517`, `e1bbbfb62`)

**Other**

- Desktop builds now embed a Node 22 binary, so the backend's `node:sqlite` no longer depends on Electron's built-in Node 20 (`bc4bb2dd7`)
- Knowledge base icons changed from emoji to colored line icons with five book-cover colors (`15aa24f65`)
- File manager batch selection: select-all across pages plus Ctrl / Shift multi-select (`0909c8651`)
- Dependency download source switcher added; the default public registry can be switched to a domestic mirror (`118dda8ac`)

### Fixed

- Container base image upgraded to `node:22-alpine` to fix startup crashes; `ffmpeg` now uses the system package to avoid `ffmpeg-static` download timeouts during builds (`dc3a1c522`, `e0b2e1c42`)
- Startup now waits for the backend before rendering; the local JWT secret is persisted (`99e843e1e`)
- Missing Chinese glyphs and blank pages in PDF: added pdfjs cMap / standard font resources and fixed lazy-render timing (`8df9e7f86`)
- PDF import attachment backfill lacked a version number and was blocked by the safety layer, so annotations never reached the database (`5f2fb94b6`)
- nowen document package imports produced full block-authority mismatch and empty derived text (`42cd337c3`)
- Derived data is rebuilt after full restore; root-level documents from a complete backup are merged into an "Unsorted" knowledge base (`a553eec9b`, `c186b384d`)
- Persistent editor tabs are cleared on logout; returning to a knowledge base no longer jumps back to a deleted document (`d2bf93789`, `479b02f95`)
- Word import validation relaxed: `contentText` comparison now uses a length ratio (`3aa5ba645`)
- WebDAV root is no longer mounted as an item and the storage list tolerates transient failures; linking into a knowledge base no longer triggers an automatic redirect (`345a90092`, `1d62b7157`)
- Image version follows CHANGELOG; release repository default no longer points at upstream nowen-note (`7bf93860f`, `4436c13e3`)
- The `latest` tag is applied locally before being pushed (`72b96e6fc`)

### Improved

- SMB directory listing is now near-instant, and refresh prunes deleted shares / mount roots (`0a218cc15`)
- Toolbars unified to a single row across local / remote files, trash and sharing; batch bars now pop below the top bar and match the prototype (`e29f040fd`, `42ce67beb`, `86fae0445`, `c31907fc8`, `5b74eedef`)
- List-page copy trimmed; search placeholder wired to i18n (`common.search`) and follows the UI language (`9213ba7cc`, `09f585583`)

### Docs

- Removed 58 upstream implementation plans / design drafts under `docs/superpowers/`, plus the outdated tutorial plan and the issue #210 sign-off document (`8a7a16f6d`)
- Release pipeline documentation updated alongside the draft → publish change (`507178a8a`)

### Refactored

- Settings page regrouped, data management merged into the backup center, scope narrowed to space / system; browser runtime no longer shows the "Sync" entry, modal animations removed and first-frame identity data cached (`02f363639`, `c36c6e72d`, `c5a2f239c`, `c0299118f`, `43f9883bf`)
- MCP single-file packaging, editor toolbar atoms and remote-files de-pluginification are listed under Added (`80b943b38`, `a8ec4d0fb`, `7b456c9cd`)
- Removed the top note tab bar `NoteTabsBar` (`9302b3067`)

### Other

- **Removed diary and AI chat modules**: including the AI navigation entry, dead i18n keys and migrations v139 / v140 for existing tables; also fixed v139 aborting startup on existing databases because an FTS trigger referenced an unregistered custom function (`da7f2d21d`)
- Deleted obsolete one-off scripts and orphaned tests (`becc0c67a`)
- New databases now start empty: default sample content and the first-login guide seed removed (`530c9b9f9`)
- Releases changed to draft → publish: Gitea promotes the release after sync, `docker latest` moves only after the release gate, with a new Gitea workflow dispatch script and regression test (`507178a8a`)
- Image push switched to a configurable repository list instead of hard-coded addresses (`d6b991e4f`)
- Version bumped to `0.2.0` (`e559e348c`)

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
