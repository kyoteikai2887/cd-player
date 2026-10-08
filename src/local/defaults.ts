import type { UserSettings } from "../contracts/player.ts";
import { createDemoSettings } from "../mock/fixtures/settings.ts";

/** Defaults are used only when no local collection exists; never migrate saved preferences. */
export function createLocalSettings(): UserSettings {
  const settings = createDemoSettings();
  return {
    ...settings,
    accentColor: "#DB7A3D",
    ui: {
      ...settings.ui,
      main: { ...settings.ui.main, materialTheme: "charcoal" },
    },
  };
}
