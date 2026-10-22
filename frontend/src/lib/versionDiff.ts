/**
 * 版本历史 v2 P2：行级文本 diff（纯前端，比较 contentText）。
 * LCS 动态规划；超过行数上限返回 null（调用方展示降级提示）。
 */
export interface DiffLine {
  type: "same" | "add" | "del";
  text: string;
}

export const DIFF_MAX_LINES = 1000;

export function diffLines(oldText: string, newText: string): DiffLine[] | null {
  const a = (oldText ?? "").split("\n");
  const b = (newText ?? "").split("\n");
  if (a.length > DIFF_MAX_LINES || b.length > DIFF_MAX_LINES) return null;

  const n = a.length;
  const m = b.length;
  // dp[i][j] = a[i..] 与 b[j..] 的 LCS 长度（滚动行省内存：仅两行）
  let prev = new Uint32Array(m + 1);
  let curr = new Uint32Array(m + 1);
  // 完整表用于回溯：n*m 上限 1000*1000 = 4MB（Uint32），可接受
  const table: Uint32Array[] = new Array(n + 1);
  table[n] = prev;
  for (let i = n - 1; i >= 0; i--) {
    curr = new Uint32Array(m + 1);
    for (let j = m - 1; j >= 0; j--) {
      curr[j] = a[i] === b[j] ? prev[j + 1] + 1 : Math.max(prev[j], curr[j + 1]);
    }
    table[i] = curr;
    prev = curr;
  }

  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ type: "same", text: a[i] });
      i += 1;
      j += 1;
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      out.push({ type: "del", text: a[i] });
      i += 1;
    } else {
      out.push({ type: "add", text: b[j] });
      j += 1;
    }
  }
  while (i < n) {
    out.push({ type: "del", text: a[i] });
    i += 1;
  }
  while (j < m) {
    out.push({ type: "add", text: b[j] });
    j += 1;
  }
  return out;
}

export function diffStats(lines: DiffLine[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of lines) {
    if (line.type === "add") added += 1;
    else if (line.type === "del") removed += 1;
  }
  return { added, removed };
}
