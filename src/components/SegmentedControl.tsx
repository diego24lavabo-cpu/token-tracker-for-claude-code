export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
}

interface SegmentedControlProps<T extends string> {
  /** Accessible name of the group. */
  label: string;
  options: readonly SegmentedOption<T>[];
  value: T;
  onChange: (value: T) => void;
  /** `neutral` highlights the selection in white, `accent` in orange. */
  tone: 'neutral' | 'accent';
  /** `small` fits in a card header. */
  size?: 'normal' | 'small';
  /** Turns the control off and says why, for a page the choice does not apply to. */
  disabledReason?: string;
}

/** A row of mutually exclusive buttons. */
export function SegmentedControl<T extends string>({
  label,
  options,
  value,
  onChange,
  tone,
  size = 'normal',
  disabledReason,
}: SegmentedControlProps<T>) {
  const disabled = disabledReason !== undefined;
  const className = [
    'segmented',
    `segmented--${tone}`,
    size === 'small' ? 'segmented--small' : '',
    disabled ? 'is-disabled' : '',
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <div
      className={className}
      role="group"
      aria-label={disabled ? `${label}: ${disabledReason}` : label}
      title={disabledReason}
    >
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          className="segmented-option"
          aria-pressed={option.value === value}
          title={disabledReason ?? option.label}
          disabled={disabled}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
