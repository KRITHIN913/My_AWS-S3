
interface AlertBannerProps {
  message: string;
  ctaLabel: string;
  onCta: () => void;
}

export default function AlertBanner({ message, ctaLabel, onCta }: AlertBannerProps) {
  if (!message) return null;

  return (
    <div className="flex items-center gap-3 bg-[#fff5f5] border border-[#fca5a5] rounded-lg p-3 px-4 mb-4">
      <div className="w-2 h-2 rounded-full bg-[#dc2626] shrink-0" />
      <p className="flex-1 text-[13px] text-[#991b1b]">{message}</p>
      <button
        onClick={onCta}
        className="bg-[#dc2626] text-white text-[12px] px-3 py-1.5 rounded hover:bg-red-700 transition-colors whitespace-nowrap"
      >
        {ctaLabel}
      </button>
    </div>
  );
}
