import { ArrowRight } from 'lucide-react';
import { useNavigate } from 'react-router-dom';

interface ShortcutCardProps {
  label: string;
  /** The headline, already formatted. */
  headline: string;
  /** The line under the headline, already formatted. */
  detail: string;
  /** Route of the section the card opens. */
  to: string;
}

/** A card that shows one headline figure of a section and opens that section. */
export function ShortcutCard({ label, headline, detail, to }: ShortcutCardProps) {
  const navigate = useNavigate();

  return (
    <button type="button" className="card shortcut-card" onClick={() => void navigate(to)}>
      <span className="shortcut-label">
        {label}
        <ArrowRight size={14} strokeWidth={2} aria-hidden="true" />
      </span>
      <span className="shortcut-headline" title={headline}>
        {headline}
      </span>
      <span className="shortcut-detail num">{detail}</span>
    </button>
  );
}
