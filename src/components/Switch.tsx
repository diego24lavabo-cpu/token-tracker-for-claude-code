interface SwitchProps {
  /** Accessible name, read with the on/off state. */
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  /** Shown as a tooltip, for example why the switch is off. */
  title?: string;
}

/** An on/off toggle. A real button with `role="switch"`, so Space and Enter work. */
export function Switch({ label, checked, onChange, disabled, title }: SwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      className="switch"
      aria-checked={checked}
      aria-label={label}
      title={title}
      disabled={disabled}
      onClick={() => onChange(!checked)}
    >
      <span className="switch-thumb" aria-hidden="true" />
    </button>
  );
}
