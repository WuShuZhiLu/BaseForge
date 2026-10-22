import { describe, expect, it } from "vitest";
import {
  MAX_SAVE_VERSION_DESCRIPTION_LENGTH,
  MAX_SAVE_VERSION_LABEL_LENGTH,
  validateSaveVersionInput,
} from "../SaveVersionDialog";

describe("validateSaveVersionInput", () => {
  it("accepts empty label and description (server applies default name)", () => {
    expect(validateSaveVersionInput("", "")).toBeNull();
  });

  it("accepts input at the exact length limits", () => {
    expect(validateSaveVersionInput("a".repeat(MAX_SAVE_VERSION_LABEL_LENGTH), "d".repeat(MAX_SAVE_VERSION_DESCRIPTION_LENGTH))).toBeNull();
  });

  it("rejects a label over 80 characters", () => {
    expect(validateSaveVersionInput("a".repeat(MAX_SAVE_VERSION_LABEL_LENGTH + 1), "")).toBe(
      "versions.saveDialog.labelTooLong",
    );
  });

  it("rejects a description over 500 characters", () => {
    expect(validateSaveVersionInput("", "d".repeat(MAX_SAVE_VERSION_DESCRIPTION_LENGTH + 1))).toBe(
      "versions.saveDialog.descriptionTooLong",
    );
  });
});
