/** The app mark: three stacked bars, echoing the daily token chart. Decorative. */
export function Logo({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" aria-hidden="true" focusable="false">
      <rect x="2" y="10.5" width="4" height="7.5" rx="1" fill="var(--accent)" />
      <rect x="2" y="7" width="4" height="2.5" rx="1" fill="var(--accent-output)" />
      <rect x="8" y="6" width="4" height="12" rx="1" fill="var(--accent)" />
      <rect x="8" y="2.5" width="4" height="2.5" rx="1" fill="var(--accent-output)" />
      <rect x="14" y="8.5" width="4" height="9.5" rx="1" fill="var(--accent)" />
      <rect x="14" y="5" width="4" height="2.5" rx="1" fill="var(--accent-output)" />
    </svg>
  );
}
