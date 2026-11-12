import { BaseForgeClient as CoreBaseForgeClient } from "./client.js";
import { BaseForgeAttachmentClient } from "./attachments.js";
import type { BaseForgeConfig } from "./types.js";
import type {
  AttachToNoteParams,
  AttachmentFile,
  AttachmentListResponse,
  AttachmentUploadResult,
  ListAttachmentsParams,
  UploadAttachmentParams,
} from "./attachments.js";

/**
 * Public SDK client.
 *
 * The original REST client remains the superclass, so all existing methods and constructor
 * behaviour stay compatible. Attachment methods are delegated to the binary-focused client to
 * keep multipart/FormData concerns isolated without forcing consumers to create a second client.
 */
export class BaseForgeClient extends CoreBaseForgeClient {
  readonly attachments: BaseForgeAttachmentClient;

  constructor(config: BaseForgeConfig) {
    super(config);
    this.attachments = new BaseForgeAttachmentClient(config);
  }

  uploadAttachment(params: UploadAttachmentParams): Promise<AttachmentUploadResult> {
    return this.attachments.uploadAttachment(params);
  }

  listAttachments(params: ListAttachmentsParams = {}): Promise<AttachmentListResponse> {
    return this.attachments.listAttachments(params);
  }

  getAttachment(id: string): Promise<AttachmentFile> {
    return this.attachments.getAttachment(id);
  }

  attachToNote(params: AttachToNoteParams): Promise<Record<string, unknown>> {
    return this.attachments.attachToNote(params);
  }
}
