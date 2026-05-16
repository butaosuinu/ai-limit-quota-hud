import type { ReactNode } from "react";

type Props = {
  icon: ReactNode;
  title: string;
  description?: ReactNode;
  help?: ReactNode;
  accessory?: ReactNode;
  actions?: ReactNode;
  testId?: string;
};

/**
 * Raycast-style settings list row. Icon column on the left, title + optional
 * description (and optional dimmer help line) in the middle, an accessory
 * (slider / toggle / chip cluster) on the right, and an optional secondary
 * action bar below the body column.
 */
export function SettingsRow({
  icon,
  title,
  description,
  help,
  accessory,
  actions,
  testId,
}: Props) {
  const hasSubtext = description !== undefined || help !== undefined;
  const className = hasSubtext ? "row row--with-desc" : "row";
  return (
    <li className={className} data-testid={testId}>
      <div className="row__main">
        <span className="row__icon" aria-hidden="true">
          {icon}
        </span>
        <div className="row__body">
          <span className="row__title">{title}</span>
          {description !== undefined && (
            <span className="row__description">{description}</span>
          )}
          {help !== undefined && <span className="row__help">{help}</span>}
        </div>
        {accessory !== undefined && (
          <div className="row__accessory">{accessory}</div>
        )}
      </div>
      {actions !== undefined && <div className="row__actions">{actions}</div>}
    </li>
  );
}
