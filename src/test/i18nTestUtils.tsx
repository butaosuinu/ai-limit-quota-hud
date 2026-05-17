import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import type { ReactNode } from "react";

import { messages } from "../locales/ja/messages";

i18n.load("ja", messages);
i18n.activate("ja");

export function withI18n(children: ReactNode): ReactNode {
  return <I18nProvider i18n={i18n}>{children}</I18nProvider>;
}
