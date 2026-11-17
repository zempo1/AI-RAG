export type RightPanelMode = "workbench" | "quiz" | "reader" | "mindmap";
export interface PanelPreferences {
  sidebar: number;
  workbench: number;
  quiz: number;
  reader: number;
  mindmap: number;
}
export const defaultPanelPreferences = (): PanelPreferences => ({
  sidebar: 300,
  workbench: 300,
  quiz: 0.5,
  reader: 0.5,
  mindmap: 0.5,
});
export const clamp = (value: number, min: number, max: number) =>
  Math.min(Math.max(value, min), Math.max(min, max));
type PreferenceStorage = Pick<Storage, "getItem" | "setItem">;
const key = (account: string) => `rag:panel-layout:v1:${account}`;
export function panelAccountKey(token: string | null, username: string): string {
  try {
    const segment = (token || "").split(".")[1];
    const payload = JSON.parse(atob(segment.replace(/-/g, "+").replace(/_/g, "/")));
    if (Number.isSafeInteger(payload.userId) && payload.userId > 0) return `user-${payload.userId}`;
  } catch {
    /* An expired/malformed credential must not block layout initialization. */
  }
  return username || "anonymous";
}
export function readPanelPreferences(
  storage: PreferenceStorage,
  account: string,
): PanelPreferences {
  const defaults = defaultPanelPreferences();
  try {
    const value = JSON.parse(storage.getItem(key(account)) || "{}");
    for (const name of Object.keys(defaults) as (keyof PanelPreferences)[]) {
      if (typeof value?.[name] !== "number" || !Number.isFinite(value[name])) continue;
      defaults[name] =
        name === "sidebar"
          ? clamp(value[name], 240, 420)
          : name === "workbench"
            ? clamp(value[name], 280, 480)
            : clamp(value[name], 0.1, 0.9);
    }
  } catch {
    /* Storage may be unavailable or contain an older/corrupt value. */
  }
  return defaults;
}
export function savePanelPreferences(
  storage: PreferenceStorage,
  account: string,
  prefs: PanelPreferences,
) {
  try {
    storage.setItem(key(account), JSON.stringify(prefs));
  } catch {
    /* Width remains usable without persistence. */
  }
}
export function resolvePanelWidths(
  viewport: number,
  prefs: PanelPreferences,
  mode: RightPanelMode,
  sidebarCollapsed = false,
  workbenchCollapsed = false,
) {
  const desktop = viewport >= 1200;
  const rightCollapsed = mode === "workbench" && workbenchCollapsed;
  const gutters = desktop ? (sidebarCollapsed ? 0 : 6) + (rightCollapsed ? 0 : 6) : 0;
  const rightMin = rightCollapsed ? 40 : mode === "workbench" ? 280 : 360;
  const sidebar = sidebarCollapsed
    ? 72
    : clamp(prefs.sidebar, 240, Math.min(420, viewport - gutters - rightMin - 360));
  const available = Math.max(0, viewport - sidebar - gutters);
  const rightMax = mode === "workbench" ? Math.min(480, available - 360) : available - 360;
  const right = rightCollapsed
    ? 40
    : clamp(mode === "workbench" ? prefs.workbench : available * prefs[mode], rightMin, rightMax);
  return {
    desktop,
    sidebar,
    right,
    chat: Math.max(0, available - right),
    gutters,
    available,
    rightMin,
    rightMax,
    sidebarMax: Math.min(420, viewport - gutters - rightMin - 360),
  };
}
