/** 与后端 trashService.TrashPreview 对应的预览结构。 */
export interface TrashPreview {
  kind: "text" | "markdown" | "outline" | "table" | "board";
  text?: string;
  outline?: Array<{ level: number; label: string }>;
  table?: { columns: string[]; rows: string[][] };
  board?: { shapes: number; texts: number };
}
