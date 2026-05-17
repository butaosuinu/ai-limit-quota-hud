import { msg } from "@lingui/core/macro";
import type { MessageDescriptor } from "@lingui/core";
import { Trans } from "@lingui/react/macro";
import { useLingui } from "@lingui/react";
import { useAtomValue, useSetAtom } from "jotai";

import {
  overlaySettingsAtom,
  updateOverlaySettingsAtom,
} from "../atoms/overlayAtoms";
import {
  type UpdateStatus,
  checkForUpdatesAtom,
  currentVersionAtom,
  downloadAndInstallAtom,
  relaunchAfterUpdateAtom,
  updateStatusAtom,
} from "../atoms/updateAtoms";
import { SettingsRow } from "./SettingsRow";
import { ToggleSwitch } from "./ToggleSwitch";
import { DownloadIcon, InfoIcon, ResetIcon } from "./icons";

/**
 * Auto-updater section of the settings panel.
 *
 * Section layout / chip styling mirrors `WebviewProvidersPanel`. State is
 * driven entirely by `updateStatusAtom`: the action buttons collapse to no-ops
 * when the current state can't service them, so the panel stays readable in
 * every branch of the discriminated union.
 */
export function UpdatesPanel() {
  const { _ } = useLingui();
  const settings = useAtomValue(overlaySettingsAtom);
  const updateSettings = useSetAtom(updateOverlaySettingsAtom);
  const status = useAtomValue(updateStatusAtom);
  const currentVersion = useAtomValue(currentVersionAtom);
  const checkForUpdates = useSetAtom(checkForUpdatesAtom);
  const downloadAndInstall = useSetAtom(downloadAndInstallAtom);
  const relaunchApp = useSetAtom(relaunchAfterUpdateAtom);

  const checkUpdatesToggleLabel = _(msg`起動時にアップデートを確認`);

  const chip = renderChip(status, _);
  const isChecking = status.kind === "checking";
  const isDownloading = status.kind === "downloading";

  return (
    <section className="settings__section" data-testid="updates-panel">
      <div className="settings__section-head">
        <span className="settings__section-label">
          <Trans>アップデート</Trans>
        </span>
      </div>

      {status.kind === "error" && (
        <p className="provider-error" data-testid="updates-error" role="alert">
          {status.message}
        </p>
      )}

      <ul className="settings__card">
        <SettingsRow
          icon={<InfoIcon />}
          title={_(msg`現在のバージョン`)}
          description={_(msg`インストールされている QuotaHUD のバージョン番号`)}
          accessory={
            <span className="mono-value" data-testid="updates-current-version">
              {currentVersion ?? "—"}
            </span>
          }
        />

        <SettingsRow
          icon={<ResetIcon />}
          title={_(msg`アップデートを確認`)}
          description={_(msg`最新リリースを GitHub から取得してチェックします`)}
          accessory={
            <>
              <span
                className={chip.className}
                data-testid="updates-status-chip"
              >
                {chip.label}
              </span>
              <button
                type="button"
                className="btn btn--primary"
                data-testid="updates-check-button"
                disabled={isChecking || isDownloading}
                onClick={() => {
                  void checkForUpdates();
                }}
              >
                <Trans>今すぐ確認</Trans>
              </button>
            </>
          }
        />

        <SettingsRow
          icon={<InfoIcon />}
          title={_(msg`起動時にアップデートを確認`)}
          description={_(msg`アプリ起動時に自動でアップデートをチェックします`)}
          accessory={
            <ToggleSwitch
              id="check-updates-on-startup"
              label={checkUpdatesToggleLabel}
              checked={settings.checkUpdatesOnStartup}
              testId="updates-startup-toggle"
              onChange={(next) => {
                void updateSettings({ checkUpdatesOnStartup: next });
              }}
            />
          }
        />

        {status.kind === "available" && (
          <SettingsRow
            testId="updates-available-row"
            icon={<DownloadIcon />}
            title={_(msg`新しいバージョンが利用可能`)}
            description={<span className="mono-value">v{status.version}</span>}
            actions={
              <>
                {status.notes.length > 0 && (
                  <pre
                    className="release-notes"
                    data-testid="updates-release-notes"
                  >
                    {status.notes}
                  </pre>
                )}
                <button
                  type="button"
                  className="btn btn--primary"
                  data-testid="updates-download-button"
                  onClick={() => {
                    void downloadAndInstall();
                  }}
                >
                  <DownloadIcon />
                  <Trans>ダウンロード</Trans>
                </button>
              </>
            }
          />
        )}

        {status.kind === "downloading" && (
          <SettingsRow
            testId="updates-downloading-row"
            icon={<DownloadIcon />}
            title={_(msg`ダウンロード中...`)}
            description={
              <span
                className="mono-value"
                data-testid="updates-download-progress"
              >
                {status.progress.toString()} B
              </span>
            }
          />
        )}

        {status.kind === "ready" && (
          <SettingsRow
            testId="updates-ready-row"
            icon={<DownloadIcon />}
            title={_(msg`アップデートの準備完了`)}
            description={_(msg`再起動してアップデートを適用します`)}
            actions={
              <button
                type="button"
                className="btn btn--primary"
                data-testid="updates-relaunch-button"
                onClick={() => {
                  void relaunchApp();
                }}
              >
                <Trans>再起動して適用</Trans>
              </button>
            }
          />
        )}
      </ul>
    </section>
  );
}

type Chip = { className: string; label: MessageDescriptor };

const CHIP_BY_KIND: Record<UpdateStatus["kind"], Chip> = {
  idle: { className: "chip chip--off", label: msg`待機中` },
  checking: { className: "chip chip--off", label: msg`確認中…` },
  available: { className: "chip chip--on", label: msg`利用可能` },
  downloading: { className: "chip chip--off", label: msg`ダウンロード中` },
  ready: { className: "chip chip--on", label: msg`再起動が必要` },
  error: { className: "chip chip--off", label: msg`エラー` },
};

function renderChip(
  status: UpdateStatus,
  translate: (descriptor: MessageDescriptor) => string,
): { className: string; label: string } {
  const chip = CHIP_BY_KIND[status.kind];
  return { className: chip.className, label: translate(chip.label) };
}
