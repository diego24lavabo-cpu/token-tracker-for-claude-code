interface KpiCardProps {
  label: string;
  /** Already formatted. */
  value: string;
  /** The line under the value. */
  hint: string;
}

/** One headline number with a label above and a short line below. */
export function KpiCard({ label, value, hint }: KpiCardProps) {
  return (
    <div className="card kpi-card">
      <div className="kpi-label">{label}</div>
      <div className="kpi-value num">{value}</div>
      <div className="kpi-hint">{hint}</div>
    </div>
  );
}
