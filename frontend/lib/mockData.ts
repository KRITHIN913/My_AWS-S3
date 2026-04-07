import type { Profile, UsageCurrent, Bucket, Invoice, Alert } from './api';

export const mockProfile: Profile = {
  id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
  slug: 'acme',
  displayName: 'Acme Corp',
  email: 'admin@acme.io',
  planId: null,
};

export const mockUsage: UsageCurrent = {
  period: '2026-04',
  storageBytes: '45432943616',
  ingressBytes: '3328599654',
  egressBytes: '8378120192',
  bucketCount: '4',
  limits: {
    maxStorageBytes: '107374182400',
    maxMonthlyIngressBytes: '10737418240',
    maxMonthlyEgressBytes: '10737418240',
    maxBuckets: '10',
  },
  pctUsed: {
    storage: 42,
    ingress: 31,
    egress: 78,
    buckets: 40,
  },
};

export const mockBuckets: Bucket[] = [
  {
    id: 'b1',
    name: 'acme-assets',
    lastKnownSizeBytes: '12884901888',
    status: 'active',
    createdAt: '2026-01-15T08:00:00Z',
  },
  {
    id: 'b2',
    name: 'acme-backups',
    lastKnownSizeBytes: '21474836480',
    status: 'active',
    createdAt: '2026-01-20T09:30:00Z',
  },
  {
    id: 'b3',
    name: 'acme-logs',
    lastKnownSizeBytes: '5368709120',
    status: 'active',
    createdAt: '2026-02-01T10:00:00Z',
  },
  {
    id: 'b4',
    name: 'acme-uploads',
    lastKnownSizeBytes: '5704203008',
    status: 'suspended',
    createdAt: '2026-02-10T11:15:00Z',
  },
];

export const mockInvoices: Invoice[] = [
  {
    id: 'inv-1',
    billingPeriod: '2026-04',
    status: 'draft',
    storageByteAvg: '45432943616',
    ingressBytes: '3328599654',
    egressBytes: '8378120192',
    bucketCount: 4,
    totalChargeUcents: '940000',
    finalisedAt: null,
  },
  {
    id: 'inv-2',
    billingPeriod: '2026-03',
    status: 'finalised',
    storageByteAvg: '41126461440',
    ingressBytes: '2969446400',
    egressBytes: '7516192768',
    bucketCount: 4,
    totalChargeUcents: '850000',
    finalisedAt: '2026-04-01T00:00:00Z',
  },
  {
    id: 'inv-3',
    billingPeriod: '2026-02',
    status: 'finalised',
    storageByteAvg: '37748736000',
    ingressBytes: '2684354560',
    egressBytes: '6442450944',
    bucketCount: 3,
    totalChargeUcents: '760000',
    finalisedAt: '2026-03-01T00:00:00Z',
  },
  {
    id: 'inv-4',
    billingPeriod: '2026-01',
    status: 'finalised',
    storageByteAvg: '32212254720',
    ingressBytes: '2147483648',
    egressBytes: '5368709120',
    bucketCount: 3,
    totalChargeUcents: '650000',
    finalisedAt: '2026-02-01T00:00:00Z',
  },
  {
    id: 'inv-5',
    billingPeriod: '2025-12',
    status: 'void',
    storageByteAvg: '21474836480',
    ingressBytes: '1073741824',
    egressBytes: '2147483648',
    bucketCount: 2,
    totalChargeUcents: '120000',
    finalisedAt: null,
  },
];

export const mockAlerts: Alert[] = [
  {
    id: 'al-1',
    breachType: 'egress_warning',
    currentValue: '8378120192',
    limitValue: '10737418240',
    detectedAt: '2026-04-02T14:30:00Z',
    webhookDispatched: false,
  },
  {
    id: 'al-2',
    breachType: 'storage_warning',
    currentValue: '45432943616',
    limitValue: '107374182400',
    detectedAt: '2026-04-01T10:00:00Z',
    webhookDispatched: false,
  },
];
