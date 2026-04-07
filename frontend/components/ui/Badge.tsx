import clsx from 'clsx';

type Variant = 'active' | 'success' | 'warning' | 'danger' | 'neutral';

interface BadgeProps {
  children: React.ReactNode;
  variant?: Variant;
}

const variantClasses: Record<Variant, string> = {
  active:  'bg-[#dcfce7] text-[#15803d]',
  success: 'bg-[#dcfce7] text-[#15803d]',
  warning: 'bg-[#ffecdd] text-[#ff808f]',
  danger:  'bg-[#fee2e2] text-[#dc2626]',
  neutral: 'bg-gray-100 text-gray-500',
};

export default function Badge({ children, variant = 'neutral' }: BadgeProps) {
  return (
    <span
      className={clsx(
        'inline-flex items-center px-2 py-0.5 rounded text-[11px] font-semibold capitalize',
        variantClasses[variant],
      )}
    >
      {children}
    </span>
  );
}
