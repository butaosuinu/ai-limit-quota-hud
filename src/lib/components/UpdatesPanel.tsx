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
  updaterAvailableAtom,
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
  const updaterAvailable = useAtomValue(updaterAvailableAtom);
  const checkForUpdates = useSetAtom(checkForUpdatesAtom);
  const downloadAndInstall = useSetAtom(downloadAndInstallAtom);
  const relaunchApp = useSetAtom(relaunchAfterUpdateAtom);

  const checkUpdatesToggleLabel = _(msg`起動時にアップデートを確認`);

  const chip = renderChip(status, _);
  const isChecking = status.kind === "checking";
  const isDownloading = status.kind === "downloading";
  // A `ready` state means an install already finished and a relaunch is
  // pending. Running another `check()` here would replace `ready` and
  // hide the relaunch button, so the user could forget to restart.
  const isReady = status.kind === "ready";
  // Builds without `TAURI_UPDATER_PUBKEY` ship without the plugin; surface
  // that here as "unavailable" rather than failing at click time.
  const checkDisabled =
    !updaterAvailable || isChecking || isDownloading || isReady;

  return (
    <section className="settings__section" data-testid="updates-panel">
      <div className="settings__section-head">
        <span className="settings__section-label">
          <Trans>アップデート</Trans>
        </span>
      </div>

      {!updaterAvailable && (
        <p
          className="settings__note"
          data-testid="updates-unavailable-notice"
          role="note"
        >
          <Trans>
            このビルドには自動アップデート機能が含まれていません。リリースバイナリを再取得してください。
          </Trans>
        </p>
      )}

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
                disabled={checkDisabled}
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

        <StatusRow
          status={status}
          updaterAvailable={updaterAvailable}
          translate={_}
          onDownload={() => {
            void downloadAndInstall();
          }}
          onRelaunch={() => {
            void relaunchApp();
          }}
        />
      </ul>
    </section>
  );
}

function StatusRow({
  status,
  updaterAvailable,
  translate,
  onDownload,
  onRelaunch,
}: {
  status: UpdateStatus;
  updaterAvailable: boolean;
  translate: (m: MessageDescriptor) => string;
  onDownload: () => void;
  onRelaunch: () => void;
}) {
  if (status.kind === "available") {
    return (
      <SettingsRow
        testId="updates-available-row"
        icon={<DownloadIcon />}
        title={translate(msg`新しいバージョンが利用可能`)}
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
              disabled={!updaterAvailable}
              onClick={onDownload}
            >
              <DownloadIcon />
              <Trans>ダウンロード</Trans>
            </button>
          </>
        }
      />
    );
  }
  if (status.kind === "downloading") {
    return (
      <SettingsRow
        testId="updates-downloading-row"
        icon={<DownloadIcon />}
        title={translate(msg`ダウンロード中...`)}
        description={
          <span className="mono-value" data-testid="updates-download-progress">
            {status.progress.toString()} B
          </span>
        }
      />
    );
  }
  if (status.kind === "ready") {
    return (
      <SettingsRow
        testId="updates-ready-row"
        icon={<DownloadIcon />}
        title={translate(msg`アップデートの準備完了`)}
        description={translate(msg`再起動してアップデートを適用します`)}
        actions={
          <button
            type="button"
            className="btn btn--primary"
            data-testid="updates-relaunch-button"
            onClick={onRelaunch}
          >
            <Trans>再起動して適用</Trans>
          </button>
        }
      />
    );
  }
  return null;
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
