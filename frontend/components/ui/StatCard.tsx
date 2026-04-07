
interface StatCardProps {
  label: string;
  value: string;
  sublabel?: string;
  children?: React.ReactNode;
}

export default function StatCard({ label, value, sublabel, children }: StatCardProps) {
  return (
    <div className="bg-white border border-[#e5e7eb] rounded-[8px] p-5">
      <p className="text-[11px] uppercase tracking-wide text-gray-400 font-medium mb-1">{label}</p>
      <p className="text-[22px] font-bold text-gray-900 leading-tight">{value}</p>
      {sublabel && <p className="text-[11px] text-gray-400 mt-0.5">{sublabel}</p>}
      {children && <div className="mt-3">{children}</div>}
    </div>
  );
}
