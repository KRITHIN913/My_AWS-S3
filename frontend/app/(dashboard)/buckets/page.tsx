'use client';
import { useState } from 'react';
import { useBuckets } from '@/lib/hooks/useBuckets';
import { createBucket, deleteBucket } from '@/lib/api';

// ─── Helpers ─────────────────────────────────────────────────

function formatBytes(bytes: string | number): string {
  const n = typeof bytes === 'string' ? parseInt(bytes, 10) : bytes;
  if (isNaN(n) || n === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(n) / Math.log(1024));
  return `${(n / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
}

function formatDate(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString('en-US', {
    year: 'numeric', month: 'short', day: 'numeric',
  });
}

// ─── Create Bucket Dialog ─────────────────────────────────────

function CreateBucketDialog({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [name, setName] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const BUCKET_REGEX = /^[a-z0-9][a-z0-9\-]{1,61}[a-z0-9]$/;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');

    if (!BUCKET_REGEX.test(name)) {
      setError(
        'Name must be 3–63 lowercase letters, numbers, or hyphens — no leading/trailing hyphens.',
      );
      return;
    }

    setLoading(true);
    try {
      await createBucket(name);
      setName('');
      onCreated();
      onClose();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to create bucket.');
    } finally {
      setLoading(false);
    }
  }

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="w-full max-w-md rounded-xl border border-gray-200 bg-white p-6 shadow-xl">
        <div className="flex items-center justify-between mb-5">
          <h2 className="text-[17px] font-semibold text-gray-900">Create bucket</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 transition-colors">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <div>
            <label className="block text-[12px] font-medium text-gray-500 mb-1.5">
              Bucket name
            </label>
            <input
              autoFocus
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value.toLowerCase())}
              placeholder="my-bucket-name"
              className="w-full rounded-lg px-3.5 py-2.5 text-[14px] text-gray-900 border border-gray-200 bg-gray-50 outline-none focus:border-brand focus:ring-2 focus:ring-brand/20 transition-all"
            />
            <p className="text-[11px] text-gray-400 mt-1.5">
              3–63 characters · lowercase letters, numbers, hyphens only
            </p>
          </div>

          {/* Info box */}
          <div className="rounded-lg p-3 text-[12px] text-gray-500 leading-relaxed bg-gray-50 border border-gray-100">
            <span className="text-gray-700 font-medium">Region:</span> us-east-1 &nbsp;·&nbsp;
            <span className="text-gray-700 font-medium">Access:</span> Private &nbsp;·&nbsp;
            <span className="text-gray-700 font-medium">Versioning:</span> Off
          </div>

          {error && (
            <p className="text-[13px] text-red-600 bg-red-50 border border-red-100 rounded-lg px-3 py-2">{error}</p>
          )}

          <div className="flex gap-2 pt-1">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 rounded-lg py-2.5 text-[13px] font-medium text-gray-500 bg-gray-50 border border-gray-200 hover:bg-gray-100 transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={loading || !name}
              className="flex-1 rounded-lg py-2.5 text-[13px] font-medium text-white bg-brand hover:opacity-90 disabled:opacity-50 transition-all"
            >
              {loading ? 'Creating…' : 'Create bucket'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ─── Bucket Row ───────────────────────────────────────────────

function BucketRow({
  bucket,
  onDelete,
}: {
  bucket: { id: string; name: string; status: string; lastKnownSizeBytes: string; createdAt: string };
  onDelete: (name: string) => void;
}) {
  const isDeleted = bucket.status === 'deleted';
  const [confirming, setConfirming] = useState(false);

  return (
    <tr className="border-b border-gray-100 hover:bg-gray-50/50 transition-colors">
      <td className="py-3.5 px-4">
        <div className="flex items-center gap-2.5">
          <div className="w-7 h-7 rounded-md flex items-center justify-center shrink-0 bg-brand/10">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#ff808f" strokeWidth="2">
              <path d="M22 12H2M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10 10-4.5 10-10S17.5 2 12 2z" />
            </svg>
          </div>
          <span className="text-[13px] font-medium text-gray-900">{bucket.name}</span>
        </div>
      </td>
      <td className="py-3.5 px-4 text-[13px] text-gray-500">{formatBytes(bucket.lastKnownSizeBytes)}</td>
      <td className="py-3.5 px-4">
        <span
          className="px-2 py-0.5 rounded-full text-[11px] font-medium"
          style={{
            background: isDeleted ? '#fef2f2' : '#f0fdf4',
            color: isDeleted ? '#dc2626' : '#16a34a',
          }}
        >
          {bucket.status}
        </span>
      </td>
      <td className="py-3.5 px-4 text-[13px] text-gray-400">{formatDate(bucket.createdAt)}</td>
      <td className="py-3.5 px-4 text-right">
        {!isDeleted && (
          confirming ? (
            <div className="flex items-center justify-end gap-2">
              <span className="text-[12px] text-gray-400">Delete?</span>
              <button
                onClick={() => { onDelete(bucket.name); setConfirming(false); }}
                className="text-[12px] text-red-500 hover:text-red-600 font-medium"
              >Yes</button>
              <button
                onClick={() => setConfirming(false)}
                className="text-[12px] text-gray-400 hover:text-gray-600"
              >No</button>
            </div>
          ) : (
            <button
              onClick={() => setConfirming(true)}
              className="text-[12px] text-gray-400 hover:text-red-500 transition-colors"
            >
              Delete
            </button>
          )
        )}
      </td>
    </tr>
  );
}

// ─── Main Buckets Page ────────────────────────────────────────

export default function BucketsPage() {
  const { buckets, isLoading, mutate } = useBuckets();
  const [showDialog, setShowDialog] = useState(false);
  const [tab, setTab] = useState<'active' | 'archived'>('active');

  const activeBuckets   = buckets.filter(b => b.status !== 'deleted');
  const archivedBuckets = buckets.filter(b => b.status === 'deleted');
  const displayed       = tab === 'active' ? activeBuckets : archivedBuckets;

  async function handleDelete(name: string) {
    try {
      await deleteBucket(name);
      await mutate();
    } catch {
      // silently fail; bucket row stays
    }
  }

  return (
    <div className="flex flex-col gap-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-[22px] font-semibold text-gray-900 tracking-tight">Buckets</h1>
          <p className="text-gray-400 text-[13px] mt-0.5">
            Manage your S3-compatible storage buckets
          </p>
        </div>
        <button
          id="create-bucket-btn"
          onClick={() => setShowDialog(true)}
          className="flex items-center gap-2 rounded-lg px-4 py-2.5 text-[13px] font-medium text-white bg-brand transition-all hover:opacity-90 active:scale-[0.98]"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
            <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
          </svg>
          Create bucket
        </button>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 p-1 rounded-lg w-fit bg-white border border-gray-200">
        {(['active', 'archived'] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-4 py-1.5 rounded-md text-[13px] font-medium transition-all ${
              tab === t
                ? 'bg-brand/10 text-brand'
                : 'text-gray-400 hover:text-gray-600'
            }`}
          >
            {t.charAt(0).toUpperCase() + t.slice(1)}
            <span className="ml-1.5 px-1.5 py-0.5 rounded-full text-[10px] bg-gray-100 text-gray-500">
              {t === 'active' ? activeBuckets.length : archivedBuckets.length}
            </span>
          </button>
        ))}
      </div>

      {/* Table */}
      <div className="rounded-xl overflow-hidden bg-white border border-gray-200">
        {isLoading ? (
          <div className="flex items-center justify-center py-16 text-gray-400 text-[14px]">
            Loading buckets…
          </div>
        ) : displayed.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 gap-3">
            <div className="w-12 h-12 rounded-full flex items-center justify-center bg-brand/10">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#ff808f" strokeWidth="1.5">
                <path d="M22 12H2M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10 10-4.5 10-10S17.5 2 12 2z" />
              </svg>
            </div>
            <p className="text-gray-400 text-[14px]">
              {tab === 'active' ? 'No active buckets. Create one to get started.' : 'No archived buckets.'}
            </p>
            {tab === 'active' && (
              <button
                onClick={() => setShowDialog(true)}
                className="text-[13px] font-medium px-4 py-2 rounded-lg bg-brand/10 text-brand hover:bg-brand/20 transition-all"
              >
                + Create your first bucket
              </button>
            )}
          </div>
        ) : (
          <table className="w-full">
            <thead>
              <tr className="border-b border-gray-100">
                {['Name', 'Size', 'Status', 'Created', ''].map((h) => (
                  <th key={h} className="py-3 px-4 text-left text-[11px] font-medium uppercase tracking-wider text-gray-400">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {displayed.map((bucket) => (
                <BucketRow key={bucket.id} bucket={bucket} onDelete={handleDelete} />
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Dialog */}
      <CreateBucketDialog
        open={showDialog}
        onClose={() => setShowDialog(false)}
        onCreated={() => mutate()}
      />
    </div>
  );
}
