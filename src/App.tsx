import { Overlay } from "./lib/components/Overlay";
import { SettingsPanel } from "./lib/components/SettingsPanel";

type Props = {
  windowLabel: string;
};

export function App({ windowLabel }: Props) {
  if (windowLabel === "settings") return <SettingsPanel />;
  return <Overlay />;
}
