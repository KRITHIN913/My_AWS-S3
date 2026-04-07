/**
 * Typed API client — connects the Next.js frontend to the Fastify backend.
 *
 * Handles:
 *   - Bearer token auth via localStorage
 *   - Automatic redirect to /login on 401/403
 *   - ApiError class with HTTP status for UI error differentiation
 *   - Mock mode bypass via NEXT_PUBLIC_USE_MOCK
 */

const BASE = process.env['NEXT_PUBLIC_API_URL'] ?? 'http://localhost:3000';

function getKey(): string | null {
  if (typeof window === 'undefined') return null;
  return localStorage.getItem('api_key');
}

// ─── API Error Class ─────────────────────────────────────────

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

// ─── Core Fetch Wrapper ──────────────────────────────────────

async function apiFetch<T>(path: string, options?: RequestInit): Promise<T> {
  const key = getKey();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(key ? { Authorization: `Bearer ${key}` } : {}),
    ...((options?.headers as Record<string, string>) ?? {}),
  };

  const res = await fetch(`${BASE}${path}`, { ...options, headers });

  if (res.status === 401 || res.status === 403) {
    if (typeof window !== 'undefined') {
      localStorage.removeItem('api_key');
      localStorage.removeItem('tenant_meta');
      window.location.href = '/login';
    }
    throw new ApiError(res.status, 'Unauthorized');
  }

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new ApiError(
      res.status,
      (body as Record<string, string>)?.error ?? `HTTP ${res.status}`,
    );
  }

  // Handle empty responses (S3 returns 200 with empty body, DELETE returns 204)
  const contentLength = res.headers.get('content-length');
  if (res.status === 204 || contentLength === '0') {
    return undefined as T;
  }

  const text = await res.text();
  if (!text || text.trim() === '') {
    return undefined as T;
  }

  return JSON.parse(text) as T;
}

// ─── Types ───────────────────────────────────────────────────

export interface Profile {
  id: string;
  slug: string;
  displayName: string;
  email: string;
  planId: string | null;
}

export interface UsageCurrent {
  period: string;
  storageBytes: string;
  ingressBytes: string;
  egressBytes: string;
  bucketCount: string;
  limits: {
    maxStorageBytes: string;
    maxMonthlyIngressBytes: string;
    maxMonthlyEgressBytes: string;
    maxBuckets: string;
  };
  pctUsed: {
    storage: number;
    ingress: number;
    egress: number;
    buckets: number;
  };
}

export interface UsageHistoryItem {
  billingPeriod: string;
  storageByteAvg: string;
  ingressBytes: string;
  egressBytes: string;
  bucketCount: number;
  totalChargeUcents: string;
  status: string;
}

export interface Bucket {
  id: string;
  name: string;
  lastKnownSizeBytes: string;
  status: string;
  createdAt: string;
}

export interface Invoice {
  id: string;
  billingPeriod: string;
  status: string;
  storageByteAvg: string;
  ingressBytes: string;
  egressBytes: string;
  bucketCount: number;
  totalChargeUcents: string;
  finalisedAt: string | null;
}

export interface Alert {
  id: string;
  breachType: string;
  currentValue: string;
  limitValue: string;
  detectedAt: string;
  webhookDispatched: boolean;
}

export interface LoginResponse {
  apiKey: string;
  tenantId: string;
  slug: string;
  displayName: string;
  email: string;
}

// ─── Auth ────────────────────────────────────────────────────

export async function login(
  email: string,
  password: string,
): Promise<LoginResponse> {
  const data = await apiFetch<LoginResponse>('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  });

  // Persist key and tenant metadata immediately
  localStorage.setItem('api_key', data.apiKey);
  localStorage.setItem(
    'tenant_meta',
    JSON.stringify({
      slug: data.slug,
      displayName: data.displayName,
      email: data.email,
    }),
  );

  return data;
}

export function logout(): void {
  localStorage.removeItem('api_key');
  localStorage.removeItem('tenant_meta');
  window.location.href = '/login';
}

export function isAuthenticated(): boolean {
  if (typeof window === 'undefined') return false;
  return !!localStorage.getItem('api_key');
}

// ─── Data Fetchers ───────────────────────────────────────────

export const fetchProfile = (): Promise<{ profile: Profile }> =>
  apiFetch<{ profile: Profile }>('/portal/profile');

export const fetchUsage = (): Promise<UsageCurrent> =>
  apiFetch<UsageCurrent>('/portal/usage/current');

export const fetchHistory = (): Promise<{ history: UsageHistoryItem[] }> =>
  apiFetch<{ history: UsageHistoryItem[] }>('/portal/usage/history');

export const fetchBuckets = (): Promise<{ buckets: Bucket[] }> =>
  apiFetch<{ buckets: Bucket[] }>('/portal/buckets');

export const fetchInvoices = (): Promise<{ invoices: Invoice[] }> =>
  apiFetch<{ invoices: Invoice[] }>('/billing/invoices');

export const fetchAlerts = (): Promise<{ alerts: Alert[] }> =>
  apiFetch<{ alerts: Alert[] }>('/portal/alerts');

// S3 CreateBucket — PUT /:bucketName (S3 protocol — name in URL, no body)
export const createBucket = (name: string): Promise<void> =>
  apiFetch<void>(`/${encodeURIComponent(name)}`, {
    method: 'PUT',
  });

// Portal soft-delete — DELETE /portal/buckets/:name
export const deleteBucket = (name: string): Promise<{ ok: boolean }> =>
  apiFetch<{ ok: boolean }>(`/portal/buckets/${encodeURIComponent(name)}`, {
    method: 'DELETE',
  });
