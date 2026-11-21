import test from "node:test";
import assert from "node:assert/strict";
import {
  defaultPanelPreferences,
  resolvePanelWidths,
  readPanelPreferences,
  savePanelPreferences,
  panelAccountKey,
} from "../src/utils/panel-layout.ts";

test("desktop widths preserve minimum chat space for every right panel and collapsed sidebars", () => {
  for (const viewport of [1200, 1440, 1920])
    for (const mode of ["workbench", "quiz", "reader", "mindmap"])
      for (const collapsed of [false, true]) {
        const widths = resolvePanelWidths(
          viewport,
          {
            ...defaultPanelPreferences(),
            sidebar: 420,
            workbench: 480,
            quiz: 0.95,
            reader: 0.95,
            mindmap: 0.95,
          },
          mode,
          collapsed,
          false,
        );
        assert.ok(widths.chat >= 360);
        assert.ok(widths.sidebar + widths.right + widths.chat + widths.gutters <= viewport);
        assert.ok(widths.right >= (mode === "workbench" ? 280 : 360));
      }
});
test("expanded panels initially split the remaining width equally and narrow screens disable drag", () => {
  const widths = resolvePanelWidths(1440, defaultPanelPreferences(), "quiz", false, false);
  assert.equal(widths.chat, widths.right);
  assert.equal(
    resolvePanelWidths(900, defaultPanelPreferences(), "quiz", false, false).desktop,
    false,
  );
  assert.equal(
    resolvePanelWidths(1440, defaultPanelPreferences(), "workbench", false, true).right,
    40,
  );
});
test("preferences are account scoped and malformed storage never breaks the layout", () => {
  const data = new Map();
  const storage = { getItem: (k) => data.get(k) || null, setItem: (k, v) => data.set(k, v) };
  savePanelPreferences(storage, "alice", {
    ...defaultPanelPreferences(),
    sidebar: 380,
    quiz: 0.65,
  });
  assert.equal(readPanelPreferences(storage, "alice").sidebar, 380);
  assert.equal(readPanelPreferences(storage, "bob").sidebar, 300);
  data.set("rag:panel-layout:v1:alice", "{broken");
  assert.deepEqual(readPanelPreferences(storage, "alice"), defaultPanelPreferences());
  data.set("rag:panel-layout:v1:alice", JSON.stringify({ sidebar: 999, quiz: -1 }));
  assert.equal(readPanelPreferences(storage, "alice").sidebar, 420);
  assert.equal(readPanelPreferences(storage, "alice").quiz, 0.1);
  assert.equal(panelAccountKey("bad-token", "alice"), "alice");
  const token =
    "x." + Buffer.from(JSON.stringify({ userId: 7, sub: "alice" })).toString("base64url") + ".x";
  assert.equal(panelAccountKey(token, "renamed"), "user-7");
});
