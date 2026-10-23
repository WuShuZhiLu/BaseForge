/**
 * 头像裁切弹窗：react-easy-crop 方形裁切 + 缩放，确认后输出 512×512 PNG File。
 */
import { useCallback, useState } from "react";
import Cropper, { type Area } from "react-easy-crop";
import { Loader2 } from "lucide-react";

const OUTPUT_SIZE = 512;

interface AvatarCropDialogProps {
  imageSrc: string;
  onConfirm: (file: File) => void;
  onCancel: () => void;
}

async function cropToSquareFile(imageSrc: string, area: Area, quality: number): Promise<File> {
  const img = new Image();
  img.src = imageSrc;
  await img.decode();

  const canvas = document.createElement("canvas");
  canvas.width = OUTPUT_SIZE;
  canvas.height = OUTPUT_SIZE;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas 不可用");
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(img, area.x, area.y, area.width, area.height, 0, 0, OUTPUT_SIZE, OUTPUT_SIZE);

  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png", quality));
  if (!blob) throw new Error("图片导出失败");
  return new File([blob], "avatar.png", { type: "image/png" });
}

export default function AvatarCropDialog({ imageSrc, onConfirm, onCancel }: AvatarCropDialogProps) {
  const [crop, setCrop] = useState({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const [areaPixels, setAreaPixels] = useState<Area | null>(null);
  const [exporting, setExporting] = useState(false);

  const onCropComplete = useCallback((_: Area, cropped: Area) => setAreaPixels(cropped), []);

  const handleConfirm = useCallback(async () => {
    if (!areaPixels) return;
    setExporting(true);
    try {
      const file = await cropToSquareFile(imageSrc, areaPixels, 0.92);
      onConfirm(file);
    } finally {
      setExporting(false);
    }
  }, [areaPixels, imageSrc, onConfirm]);

  return (
    <div className="fixed inset-0 z-[300] flex items-center justify-center bg-black/50 p-4" onMouseDown={(e) => { if (e.target === e.currentTarget) onCancel(); }}>
      <div className="w-full max-w-sm rounded-xl border border-app-border bg-app-elevated p-4 shadow-xl">
        <p className="mb-3 text-sm font-semibold text-tx-primary">选择头像区域</p>
        <div className="relative h-64 w-full overflow-hidden rounded-lg bg-app-bg">
          <Cropper
            image={imageSrc}
            crop={crop}
            zoom={zoom}
            aspect={1}
            onCropChange={setCrop}
            onZoomChange={setZoom}
            onCropComplete={onCropComplete}
            showGrid={false}
            restrictPosition={true}
          />
        </div>
        <div className="mt-3 flex items-center gap-2">
          <span className="shrink-0 text-xs text-tx-tertiary">缩放</span>
          <input
            type="range"
            min={1}
            max={3}
            step={0.01}
            value={zoom}
            onChange={(e) => setZoom(Number(e.target.value))}
            className="min-w-0 flex-1 accent-accent-primary"
          />
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-md border border-app-border px-3 py-1.5 text-sm text-tx-secondary transition-colors hover:bg-app-hover"
          >
            取消
          </button>
          <button
            type="button"
            disabled={exporting}
            onClick={() => void handleConfirm()}
            className="flex items-center gap-1.5 rounded-md bg-accent-primary px-3 py-1.5 text-sm font-medium text-white transition-colors hover:opacity-90 disabled:opacity-50"
          >
            {exporting && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            确认并上传
          </button>
        </div>
      </div>
    </div>
  );
}
