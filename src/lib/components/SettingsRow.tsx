import type { ReactNode } from "react";

import { InfoIcon } from "./icons";

type Props = {
  icon: ReactNode;
  title: string;
  description?: ReactNode;
  helpTooltip?: string;
  accessory?: ReactNode;
  actions?: ReactNode;
  testId?: string;
};

/**
 * Raycast-style settings list row. Icon column on the left, title + optional
 * description in the middle, an accessory (slider / toggle / chip cluster) on
 * the right, and an optional secondary action bar that sits below aligned
 * with the body column.
 */
export function SettingsRow({
  icon,
  title,
  description,
  helpTooltip,
  accessory,
  actions,
  testId,
}: Props) {
  const className = description === undefined ? "row" : "row row--with-desc";
  return (
    <li className={className} data-testid={testId}>
      <div className="row__main">
        <span className="row__icon" aria-hidden="true">
          {icon}
        </span>
        <div className="row__body">
          <span className="row__title-line">
            <span className="row__title">{title}</span>
            {helpTooltip !== undefined && (
              <button
                type="button"
                className="row__info"
                title={helpTooltip}
                aria-label={helpTooltip}
              >
                <InfoIcon />
              </button>
            )}
          </span>
          {description !== undefined && (
            <span className="row__description">{description}</span>
          )}
        </div>
        {accessory !== undefined && (
          <div className="row__accessory">{accessory}</div>
        )}
      </div>
      {actions !== undefined && <div className="row__actions">{actions}</div>}
    </li>
  );
}
