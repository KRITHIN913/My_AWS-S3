'use client';
import useSWR from 'swr';
import { fetchInvoices, type Invoice } from '@/lib/api';
import { mockInvoices } from '@/lib/mockData';

export function useInvoices() {
  const isMock = process.env['NEXT_PUBLIC_USE_MOCK'] === 'true';

  const { data, error, isLoading, mutate } = useSWR<{ invoices: Invoice[] }>(
    isMock ? null : '/billing/invoices',
    isMock ? null : fetchInvoices,
    { shouldRetryOnError: false, revalidateOnFocus: false, dedupingInterval: 60_000 },
  );

  if (isMock) {
    return {
      invoices: mockInvoices,
      error: null,
      isLoading: false,
      mutate: async () => undefined,
    };
  }

  return { invoices: data?.invoices ?? [], error, isLoading, mutate };
}
