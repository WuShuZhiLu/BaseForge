import type { Note } from "@/types";
import { getBaseUrl } from "@/lib/api";
import {
  getNote as getCachedNote,
  isNoteDetailCached,
  putNote,
  type CachedNote,
} from "@/lib/localStore";
import {
  hasPersistentNoteAttachmentReference,
  primeNoteAttachmentAccess,
} from "@/lib/noteAttachmentAccessPriming";
import {
  reportTransientNoteImageSource,
  stabilizeNoteMutationPayload,
} from "@/lib/noteContentPersistence";

export interface CacheFirstNoteLoadOptions {
  noteId: string;
  fetchRemote: () => Promise<Note>;
  onRevalidated?: (remote: Note, cached: CachedNote) => void | Promise<void>;
  /**
   * Optional override for runtime prerequisites before a note becomes visible.
   * The historical name is retained for compatibility, but this hook now runs for both cached
   * and first-load remote notes. The default prepares signed attachment access for persisted
   * `/api/attachments/<id>` refs. Failures stay non-fatal so offline cached-note opening works.
   */
  beforeUseCached?: (cached: CachedNote) => void | Promise<void>;
}

export interface RevalidatedNoteGuardInput {
  current: Note | null | undefined;
  cached: Note;
  remote: Note;
  hasDraft: boolean;
  pendingNoteId: string | null;
}

export function canApplyRevalidatedNote({
  current,
  cached,
  remote,
  hasDraft,
  pendingNoteId,
}: RevalidatedNoteGuardInput): boolean {
  if (!current || hasDraft || pendingNoteId) return false;
  if (current.id !== cached.id || remote.id !== cached.id) return false;
  if (remote.version <= cached.version) return false;

  return current.version === cached.version
    && current.title === cached.title
    && current.content === cached.content
    && current.contentText === cached.contentText
    && current.updatedAt === cached.updatedAt;
}

async function persistDetail(note: Note): Promise<void> {
  try {
    const stableNote = stabilizeNoteMutationPayload(note);
    await putNote({ ...stableNote, __detailCached: true });
  } catch (error) {
    reportTransientNoteImageSource(error, { operation: "persistNoteDetail", noteId: note.id });
  }
}

async function prepareNoteRuntime(note: CachedNote): Promise<void> {
  if (!hasPersistentNoteAttachmentReference(note.content)) return;
  await primeNoteAttachmentAccess(note.id, getBaseUrl());
}

export async function loadNoteCacheFirst({
  noteId,
  fetchRemote,
  onRevalidated,
  beforeUseCached = prepareNoteRuntime,
}: CacheFirstNoteLoadOptions): Promise<Note> {
  const cached = await getCachedNote(noteId);
  if (cached && isNoteDetailCached(cached)) {
    // Start freshness revalidation immediately, but never publish the remote replacement before
    // its media/runtime prerequisites are ready. This matters on Android LAN HTTP where the note
    // body can arrive through CapacitorHttp while attachment signed-URL exchange needs its own
    // native transport.
    void fetchRemote()
      .then(async (remote) => {
        await persistDetail(remote);
        try {
          await beforeUseCached(remote);
        } catch (error) {
          console.warn("[noteLoadSource] revalidated-note preparation failed:", error);
        }
        await onRevalidated?.(remote, cached);
      })
      .catch((error) => {
        console.warn("[noteLoadSource] background revalidation failed:", error);
      });

    try {
      await beforeUseCached(cached);
    } catch (error) {
      // Cached notes must remain available offline. The background revalidation above may still
      // recover the runtime prerequisite when connectivity returns.
      console.warn("[noteLoadSource] cached-note preparation failed:", error);
    }
    return cached;
  }

  const remote = await fetchRemote();
  await persistDetail(remote);
  try {
    // First-load notes used to skip attachment priming entirely. On Android this allowed the
    // editor/video NodeView to mount with an unsigned /api/attachments/<id> source and fail before
    // the access map existed. Prepare the same runtime contract as the cache-first path.
    await beforeUseCached(remote);
  } catch (error) {
    console.warn("[noteLoadSource] remote-note preparation failed:", error);
  }
  return remote;
}
