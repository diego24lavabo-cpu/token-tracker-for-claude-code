import { MachineSelector } from './MachineSelector';
import { PeriodSelector } from './PeriodSelector';

/** The header shared by every page: title and subtitle on the left, selectors on the right. */
export function Header({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <div className="page-header">
      <div>
        <h1 className="page-title">{title}</h1>
        <p className="page-subtitle">{subtitle}</p>
      </div>
      <div className="page-controls">
        <MachineSelector />
        <PeriodSelector />
      </div>
    </div>
  );
}
