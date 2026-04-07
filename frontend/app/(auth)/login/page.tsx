'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { login, ApiError } from '@/lib/api';

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);

    try {
      await login(email, password);
      router.push('/dashboard');
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.status === 401 || err.status === 403) {
          setError('Invalid email or password.');
        } else if (err.status === 429) {
          setError('Rate limit reached. Try again shortly.');
        } else {
          setError('Server error. Contact support.');
        }
      } else {
        setError('Something went wrong. Try again.');
      }
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="w-full max-w-sm">
      {/* Logo */}
      <div className="flex items-center justify-center gap-3 mb-8">
        <div
          className="w-9 h-9 rounded-full flex items-center justify-center text-white font-bold text-[16px]"
          style={{ background: '#ff808f' }}
        >
          S
        </div>
        <span className="text-[20px] font-semibold text-gray-900">StorageOS</span>
      </div>

      <div className="bg-white border border-[#e5e7eb] rounded-lg p-8">
        <h1 className="text-[18px] font-semibold text-gray-900 mb-1 text-center">
          Sign in to StorageOS
        </h1>
        <p className="text-[13px] text-gray-400 text-center mb-6">
          Sign in to your account
        </p>

        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <div>
            <label
              className="block text-[13px] font-medium text-gray-700 mb-1.5"
              htmlFor="login-email"
            >
              Email
            </label>
            <input
              id="login-email"
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@company.com"
              className="w-full h-9 px-3 border border-[#e5e7eb] rounded-md text-[13px] text-gray-900 placeholder-gray-400 outline-none focus:ring-2 focus:ring-[#ff808f]/40 focus:border-[#ff808f]"
            />
          </div>

          <div>
            <label
              className="block text-[13px] font-medium text-gray-700 mb-1.5"
              htmlFor="login-password"
            >
              Password
            </label>
            <input
              id="login-password"
              type="password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
              className="w-full h-9 px-3 border border-[#e5e7eb] rounded-md text-[13px] text-gray-900 placeholder-gray-400 outline-none focus:ring-2 focus:ring-[#ff808f]/40 focus:border-[#ff808f]"
            />
          </div>

          {error && (
            <p className="text-[13px] text-[#dc2626]">{error}</p>
          )}

          <button
            type="submit"
            disabled={loading}
            className="w-full h-10 text-white rounded-md text-[14px] font-semibold hover:opacity-90 transition-opacity disabled:opacity-60 mt-2"
            style={{ background: '#ff808f' }}
          >
            {loading ? 'Signing in...' : 'Sign in'}
          </button>
        </form>

        <p className="text-center text-[12px] text-gray-400 mt-5">
          Don&apos;t have an account? Contact your admin.
        </p>
      </div>
    </div>
  );
}
