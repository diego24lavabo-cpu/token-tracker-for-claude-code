import { MachineSelector } from './MachineSelector';
import { PeriodSelector } from './PeriodSelector';

interface HeaderProps {
  title: string;
  subtitle: string;
  /** Set on a page that ignores the period: the period selector is off and says why. */
  periodIgnored?: string;
}

/** The header shared by every page: title and subtitle on the left, selectors on the right. */
export function Header({ title, subtitle, periodIgnored }: HeaderProps) {
  return (
    <div className="page-header">
      <div>
        <h1 className="page-title">{title}</h1>
        <p className="page-subtitle">{subtitle}</p>
      </div>
      <div className="page-controls">
        <MachineSelector />
        <PeriodSelector disabledReason={periodIgnored} />
      </div>
    </div>
  );
}
