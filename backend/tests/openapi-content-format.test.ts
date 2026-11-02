import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

test("OpenAPI note schemas include contentFormat", () => {
  const source = readFileSync(path.resolve("src/services/openapi.ts"), "utf8");

  // contentFormat 的 enum 会随产品支持的内容格式扩展（board / mindmap / pdf / plain 等），
  // 因此只断言核心三种格式始终在列，而不是锁定整个枚举字面量。
  const enums = [...source.matchAll(/contentFormat:\s*\{\s*type:\s*"string",\s*enum:\s*\[([^\]]*)\]/g)]
    .map((match) => match[1].split(",").map((value) => value.trim().replace(/^"|"$/g, "")));

  assert.ok(enums.length >= 3, "expected contentFormat enum on Note schema and on post/put request bodies");
  for (const values of enums) {
    for (const format of ["tiptap-json", "markdown", "html"]) {
      assert.ok(values.includes(format), `contentFormat enum missing "${format}": ${values.join(", ")}`);
    }
  }

  assert.match(source, /post:\s*\{[\s\S]*contentFormat:\s*\{\s*type:\s*"string"[\s\S]*default:\s*"tiptap-json"/);
  assert.match(source, /put:\s*\{[\s\S]*contentFormat:\s*\{\s*type:\s*"string"[\s\S]*version:\s*\{\s*type:\s*"integer"/);
});
