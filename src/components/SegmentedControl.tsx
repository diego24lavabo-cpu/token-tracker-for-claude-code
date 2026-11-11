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
}

/** A row of mutually exclusive buttons. */
export function SegmentedControl<T extends string>({
  label,
  options,
  value,
  onChange,
  tone,
  size = 'normal',
}: SegmentedControlProps<T>) {
  const className = `segmented segmented--${tone}${size === 'small' ? ' segmented--small' : ''}`;
  return (
    <div className={className} role="group" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          className="segmented-option"
          aria-pressed={option.value === value}
          title={option.label}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
