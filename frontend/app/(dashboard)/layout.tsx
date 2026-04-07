'use client';
import Sidebar from '@/components/layout/Sidebar';
import Topbar from '@/components/layout/Topbar';
import { useRequireAuth, useTenantMeta } from '@/lib/hooks/useAuth';

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const isAuthed = useRequireAuth();
  const meta = useTenantMeta();

  // While checking auth or redirecting, render nothing
  if (!isAuthed) return null;

  return (
    <div className="flex h-screen overflow-hidden">
      <Sidebar />
      <div className="flex flex-1 flex-col overflow-hidden">
        <Topbar displayName={meta?.displayName} />
        <main className="flex-1 overflow-y-auto bg-[#f4f6f8] p-6">{children}</main>
      </div>
    </div>
  );
}
