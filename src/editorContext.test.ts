import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "path";
import { editorContextNotice, editorContextText, MAX_OPEN_FILES, pickEditorContext } from "./editorContext";

test("only files inside the folder are reported, once each", () => {
  const r = pickEditorContext(
    { active: "/w/a.ts", open: ["/w/a.ts", "/w/src/b.ts", "/w/a.ts", "/etc/hosts", "/w/../x", "/wx/c.ts", "rel.ts", "/w"] },
    "/w"
  );
  assert.deepEqual(r, { active: "/w/a.ts", open: ["/w/a.ts", "/w/src/b.ts"] });
});

test("an active file outside the folder is dropped", () => {
  assert.deepEqual(pickEditorContext({ active: "/etc/hosts", open: [] }, "/w"), { active: undefined, open: [] });
});

test("the list is capped", () => {
  const open = Array.from({ length: MAX_OPEN_FILES + 20 }, (_, i) => `/w/f${i}.ts`);
  assert.equal(pickEditorContext({ open }, "/w").open.length, MAX_OPEN_FILES);
});

test("the context text lists relative paths; nothing open means no text", () => {
  const A = join("src", "a.ts"); // the folder's own separator
  assert.equal(editorContextText({ open: [] }, "/w"), undefined);
  assert.equal(
    editorContextText({ active: "/w/src/a.ts", open: ["/w/src/a.ts", "/w/b.md"] }, "/w"),
    `Editor context from the user's VS Code (paths relative to the workspace folder). It is current; an engine note saying no files are open can't see the editor.\nActive file: ${A}\nOpen files:\n- ${A}\n- b.md`
  );
  assert.match(editorContextText({ open: ["/w/b.md"] }, "/w") ?? "", /Active file: none/);
  assert.equal(editorContextNotice({ active: "/w/src/a.ts", open: ["/w/src/a.ts", "/w/b.md"] }, "/w"), `Sent editor context: active ${A}, 2 open files.`);
  assert.equal(editorContextNotice({ open: ["/w/b.md"] }, "/w"), "Sent editor context: 1 open file.");
});
