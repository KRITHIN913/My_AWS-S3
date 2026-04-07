
interface UsageBarProps {
  pct: number;
  warn?: boolean;
}

export default function UsageBar({ pct, warn = false }: UsageBarProps) {
  const clamped = Math.min(100, Math.max(0, pct));
  return (
    <div className="h-[6px] w-full rounded-[3px] bg-[#f0f0f0] overflow-hidden">
      <div
        className="h-full rounded-[3px] transition-all duration-500"
        style={{
          width: `${clamped}%`,
          backgroundColor: warn ? '#dc2626' : '#ff808f',
        }}
      />
    </div>
  );
}
