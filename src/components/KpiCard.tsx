interface KpiCardProps {
  label: string;
  /** Already formatted. */
  value: string;
  /** The line under the value. */
  hint: string;
  /** A tooltip explaining how the number is counted. */
  title?: string;
  /** A smaller value, for a word where the others have a number. */
  compact?: boolean;
}

/** One headline number with a label above and a short line below. */
export function KpiCard({ label, value, hint, title, compact }: KpiCardProps) {
  return (
    <div className="card kpi-card" title={title}>
      <div className="kpi-label">{label}</div>
      <div className={compact ? 'kpi-value kpi-value--compact num' : 'kpi-value num'}>{value}</div>
      <div className="kpi-hint">{hint}</div>
    </div>
  );
}
