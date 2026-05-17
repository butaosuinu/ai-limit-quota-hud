import { defineConfig } from "@lingui/conf";

export default defineConfig({
  sourceLocale: "ja",
  locales: ["ja", "en"],
  catalogs: [
    {
      path: "src/locales/{locale}/messages",
      include: [
        "src/lib/components/SettingsPanel.tsx",
        "src/lib/components/WebviewProvidersPanel.tsx",
        "src/lib/components/UpdatesPanel.tsx",
        "src/lib/atoms/providerSettingsAtom.ts",
        "src/lib/atoms/updateAtoms.ts",
        "src/lib/i18n.ts",
      ],
    },
  ],
  format: "po",
  compileNamespace: "ts",
});
