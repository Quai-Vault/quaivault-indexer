# Frontend Integration Guide

This guide explains how to integrate a frontend application with the Quai Multisig Indexer via Supabase.

## Overview

The indexer continuously monitors the Quai blockchain for multisig wallet events and stores them in Supabase. Your frontend can:

1. **Query data** - Fetch wallets, transactions, and module state
2. **Subscribe to updates** - Get real-time notifications via Supabase Realtime
3. **Display activity** - Show deposits, confirmations, and execution status

## Multi-Network Support

The indexer supports multiple networks (testnet, mainnet) using PostgreSQL schemas within a single Supabase project. Each network has its own isolated schema:

```
Supabase Project
├── testnet (schema)
│   ├── wallets, transactions, confirmations, etc.
├── mainnet (schema)
│   ├── wallets, transactions, confirmations, etc.
└── public (schema - unused/legacy)
```

Your frontend should be configured to connect to the appropriate schema based on the network.

## Supabase Setup

### Install Dependencies

```bash
npm install @supabase/supabase-js
```

### Initialize Client (Single Network)

For a frontend targeting a single network:

```typescript
import { createClient } from '@supabase/supabase-js';

// Configure schema based on target network
const NETWORK_SCHEMA = process.env.VITE_NETWORK_SCHEMA || 'testnet'; // 'testnet' or 'mainnet'

const supabase = createClient(
  process.env.VITE_SUPABASE_URL!,
  process.env.VITE_SUPABASE_ANON_KEY!, // Use anon key, NOT service role key
  {
    db: {
      schema: NETWORK_SCHEMA
    }
  }
);
```

### Initialize Client (Multi-Network)

For a frontend that supports network switching:

```typescript
import { createClient, SupabaseClient } from '@supabase/supabase-js';

type NetworkSchema = 'testnet' | 'mainnet';

// Create clients for each network
function createNetworkClient(schema: NetworkSchema): SupabaseClient {
  return createClient(
    process.env.VITE_SUPABASE_URL!,
    process.env.VITE_SUPABASE_ANON_KEY!,
    {
      db: { schema }
    }
  );
}

// Network-specific clients
export const supabaseTestnet = createNetworkClient('testnet');
export const supabaseMainnet = createNetworkClient('mainnet');

// Or use a factory function
export function getSupabaseClient(network: NetworkSchema): SupabaseClient {
  return createNetworkClient(network);
}
```

### React Context for Network Selection

```typescript
import { createContext, useContext, useState, ReactNode } from 'react';
import { SupabaseClient } from '@supabase/supabase-js';

type Network = 'testnet' | 'mainnet';

interface NetworkContextValue {
  network: Network;
  setNetwork: (network: Network) => void;
  supabase: SupabaseClient;
}

const NetworkContext = createContext<NetworkContextValue | null>(null);

export function NetworkProvider({ children }: { children: ReactNode }) {
  const [network, setNetwork] = useState<Network>('testnet');

  const supabase = createClient(
    process.env.VITE_SUPABASE_URL!,
    process.env.VITE_SUPABASE_ANON_KEY!,
    { db: { schema: network } }
  );

  return (
    <NetworkContext.Provider value={{ network, setNetwork, supabase }}>
      {children}
    </NetworkContext.Provider>
  );
}

export function useNetwork() {
  const context = useContext(NetworkContext);
  if (!context) throw new Error('useNetwork must be used within NetworkProvider');
  return context;
}
```

**Important:** The frontend should use the **anon key** (public). The service role key is only for the indexer.

## Database Schema Reference

### Core Tables

| Table | Description | Key Fields |
|-------|-------------|------------|
| `wallets` | Deployed multisig wallets | `address`, `threshold`, `owner_count` |
| `wallet_owners` | Wallet owner addresses | `wallet_address`, `owner_address`, `is_active` |
| `transactions` | Proposed multisig transactions | `wallet_address`, `tx_hash`, `status`, `confirmation_count` |
| `confirmations` | Owner approvals | `wallet_address`, `tx_hash`, `owner_address`, `is_active` |
| `wallet_modules` | Enabled modules per wallet | `wallet_address`, `module_address`, `is_active` |
| `deposits` | QUAI received by wallets | `wallet_address`, `sender_address`, `amount` |

### Module Tables

| Table | Description |
|-------|-------------|
| `daily_limit_state` | Daily spending limit configuration |
| `whitelist_entries` | Whitelisted addresses for a wallet |
| `module_transactions` | Transactions executed via modules |

### Social Recovery Tables

| Table | Description |
|-------|-------------|
| `social_recovery_configs` | Recovery configuration (threshold, period) |
| `social_recovery_guardians` | Guardian addresses for recovery |
| `social_recoveries` | Recovery requests and their status |
| `social_recovery_approvals` | Guardian approvals for recoveries |

## Common Queries

### Get Wallets for an Owner

```typescript
async function getWalletsForOwner(ownerAddress: string) {
  const { data, error } = await supabase
    .from('wallet_owners')
    .select(`
      wallet_address,
      wallets (
        address,
        name,
        threshold,
        owner_count,
        created_at
      )
    `)
    .eq('owner_address', ownerAddress.toLowerCase())
    .eq('is_active', true);

  return data?.map(row => row.wallets) ?? [];
}
```

### Get Wallet Details with Owners

```typescript
async function getWalletDetails(walletAddress: string) {
  const [walletResult, ownersResult] = await Promise.all([
    supabase
      .from('wallets')
      .select('*')
      .eq('address', walletAddress.toLowerCase())
      .single(),
    supabase
      .from('wallet_owners')
      .select('owner_address')
      .eq('wallet_address', walletAddress.toLowerCase())
      .eq('is_active', true)
  ]);

  return {
    wallet: walletResult.data,
    owners: ownersResult.data?.map(row => row.owner_address) ?? []
  };
}
```

### Get Pending Transactions

```typescript
async function getPendingTransactions(walletAddress: string) {
  const { data, error } = await supabase
    .from('transactions')
    .select(`
      *,
      confirmations (
        owner_address,
        is_active
      )
    `)
    .eq('wallet_address', walletAddress.toLowerCase())
    .eq('status', 'pending')
    .order('created_at', { ascending: false });

  return data ?? [];
}
```

### Get Transaction History

```typescript
async function getTransactionHistory(
  walletAddress: string,
  limit = 50,
  offset = 0
) {
  const { data, error } = await supabase
    .from('transactions')
    .select('*')
    .eq('wallet_address', walletAddress.toLowerCase())
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  return data ?? [];
}
```

### Get Deposit History

```typescript
async function getDeposits(walletAddress: string) {
  const { data, error } = await supabase
    .from('deposits')
    .select('*')
    .eq('wallet_address', walletAddress.toLowerCase())
    .order('created_at', { ascending: false });

  return data ?? [];
}
```

### Get Enabled Modules

```typescript
async function getEnabledModules(walletAddress: string) {
  const { data, error } = await supabase
    .from('wallet_modules')
    .select('*')
    .eq('wallet_address', walletAddress.toLowerCase())
    .eq('is_active', true);

  return data ?? [];
}
```

### Get Daily Limit State

```typescript
async function getDailyLimitState(walletAddress: string) {
  const { data, error } = await supabase
    .from('daily_limit_state')
    .select('*')
    .eq('wallet_address', walletAddress.toLowerCase())
    .single();

  return data;
}
```

### Get Whitelist Entries

```typescript
async function getWhitelistEntries(walletAddress: string) {
  const { data, error } = await supabase
    .from('whitelist_entries')
    .select('*')
    .eq('wallet_address', walletAddress.toLowerCase())
    .eq('is_active', true);

  return data ?? [];
}
```

### Get Social Recovery Status

```typescript
async function getRecoveryStatus(walletAddress: string) {
  const [configResult, guardiansResult, activeRecoveryResult] = await Promise.all([
    supabase
      .from('social_recovery_configs')
      .select('*')
      .eq('wallet_address', walletAddress.toLowerCase())
      .single(),
    supabase
      .from('social_recovery_guardians')
      .select('guardian_address')
      .eq('wallet_address', walletAddress.toLowerCase())
      .eq('is_active', true),
    supabase
      .from('social_recoveries')
      .select(`
        *,
        social_recovery_approvals (
          guardian_address,
          is_active
        )
      `)
      .eq('wallet_address', walletAddress.toLowerCase())
      .eq('status', 'pending')
      .single()
  ]);

  return {
    config: configResult.data,
    guardians: guardiansResult.data?.map(row => row.guardian_address) ?? [],
    activeRecovery: activeRecoveryResult.data
  };
}
```

## Real-time Subscriptions

Supabase Realtime enables live updates without polling. Subscribe to tables that matter for your UI.

### Enable Realtime for Custom Schemas

By default, Supabase Realtime only monitors the `public` schema. For custom schemas (`testnet`, `mainnet`), you need to enable Realtime on each table. Run this in the Supabase SQL Editor:

```sql
-- Enable realtime for testnet tables
ALTER PUBLICATION supabase_realtime ADD TABLE testnet.wallets;
ALTER PUBLICATION supabase_realtime ADD TABLE testnet.wallet_owners;
ALTER PUBLICATION supabase_realtime ADD TABLE testnet.transactions;
ALTER PUBLICATION supabase_realtime ADD TABLE testnet.confirmations;
ALTER PUBLICATION supabase_realtime ADD TABLE testnet.deposits;
ALTER PUBLICATION supabase_realtime ADD TABLE testnet.wallet_modules;
ALTER PUBLICATION supabase_realtime ADD TABLE testnet.social_recoveries;
ALTER PUBLICATION supabase_realtime ADD TABLE testnet.social_recovery_approvals;

-- Enable realtime for mainnet tables
ALTER PUBLICATION supabase_realtime ADD TABLE mainnet.wallets;
ALTER PUBLICATION supabase_realtime ADD TABLE mainnet.wallet_owners;
ALTER PUBLICATION supabase_realtime ADD TABLE mainnet.transactions;
ALTER PUBLICATION supabase_realtime ADD TABLE mainnet.confirmations;
ALTER PUBLICATION supabase_realtime ADD TABLE mainnet.deposits;
ALTER PUBLICATION supabase_realtime ADD TABLE mainnet.wallet_modules;
ALTER PUBLICATION supabase_realtime ADD TABLE mainnet.social_recoveries;
ALTER PUBLICATION supabase_realtime ADD TABLE mainnet.social_recovery_approvals;
```

Alternatively, enable Realtime via the Supabase Dashboard: **Database → Replication → Add tables to `supabase_realtime`**.

**Important:** The `schema` parameter in subscriptions must match your network schema (`testnet` or `mainnet`).

### Subscribe to Wallet Transactions

```typescript
function subscribeToTransactions(
  supabase: SupabaseClient,
  schema: 'testnet' | 'mainnet',
  walletAddress: string,
  onInsert: (tx: Transaction) => void,
  onUpdate: (tx: Transaction) => void
) {
  const channel = supabase
    .channel(`transactions:${walletAddress}`)
    .on(
      'postgres_changes',
      {
        event: 'INSERT',
        schema: schema, // Use network schema, not 'public'
        table: 'transactions',
        filter: `wallet_address=eq.${walletAddress.toLowerCase()}`
      },
      (payload) => onInsert(payload.new as Transaction)
    )
    .on(
      'postgres_changes',
      {
        event: 'UPDATE',
        schema: schema,
        table: 'transactions',
        filter: `wallet_address=eq.${walletAddress.toLowerCase()}`
      },
      (payload) => onUpdate(payload.new as Transaction)
    )
    .subscribe();

  // Return unsubscribe function
  return () => supabase.removeChannel(channel);
}
```

### Subscribe to Confirmations

```typescript
function subscribeToConfirmations(
  supabase: SupabaseClient,
  schema: 'testnet' | 'mainnet',
  walletAddress: string,
  onConfirmation: (conf: Confirmation) => void
) {
  const channel = supabase
    .channel(`confirmations:${walletAddress}`)
    .on(
      'postgres_changes',
      {
        event: '*', // INSERT or UPDATE
        schema: schema,
        table: 'confirmations',
        filter: `wallet_address=eq.${walletAddress.toLowerCase()}`
      },
      (payload) => onConfirmation(payload.new as Confirmation)
    )
    .subscribe();

  return () => supabase.removeChannel(channel);
}
```

### Subscribe to Deposits

```typescript
function subscribeToDeposits(
  supabase: SupabaseClient,
  schema: 'testnet' | 'mainnet',
  walletAddress: string,
  onDeposit: (deposit: Deposit) => void
) {
  const channel = supabase
    .channel(`deposits:${walletAddress}`)
    .on(
      'postgres_changes',
      {
        event: 'INSERT',
        schema: schema,
        table: 'deposits',
        filter: `wallet_address=eq.${walletAddress.toLowerCase()}`
      },
      (payload) => onDeposit(payload.new as Deposit)
    )
    .subscribe();

  return () => supabase.removeChannel(channel);
}
```

### Subscribe to Recovery Updates

```typescript
function subscribeToRecovery(
  supabase: SupabaseClient,
  schema: 'testnet' | 'mainnet',
  walletAddress: string,
  onRecoveryChange: (recovery: SocialRecovery) => void,
  onApprovalChange: (approval: RecoveryApproval) => void
) {
  const channel = supabase
    .channel(`recovery:${walletAddress}`)
    .on(
      'postgres_changes',
      {
        event: '*',
        schema: schema,
        table: 'social_recoveries',
        filter: `wallet_address=eq.${walletAddress.toLowerCase()}`
      },
      (payload) => onRecoveryChange(payload.new as SocialRecovery)
    )
    .on(
      'postgres_changes',
      {
        event: '*',
        schema: schema,
        table: 'social_recovery_approvals',
        filter: `wallet_address=eq.${walletAddress.toLowerCase()}`
      },
      (payload) => onApprovalChange(payload.new as RecoveryApproval)
    )
    .subscribe();

  return () => supabase.removeChannel(channel);
}
```

## TypeScript Types

```typescript
interface Wallet {
  id: string;
  address: string;
  name: string | null;
  threshold: number;
  owner_count: number;
  created_at_block: number;
  created_at_tx: string;
  created_at: string;
  updated_at: string;
}

interface WalletOwner {
  id: string;
  wallet_address: string;
  owner_address: string;
  added_at_block: number;
  added_at_tx: string;
  removed_at_block: number | null;
  removed_at_tx: string | null;
  is_active: boolean;
  created_at: string;
}

interface Transaction {
  id: string;
  wallet_address: string;
  tx_hash: string;
  to_address: string;
  value: string; // BigInt as string
  data: string | null;
  transaction_type: string;
  decoded_params: Record<string, unknown> | null;
  status: 'pending' | 'executed' | 'cancelled';
  confirmation_count: number;
  submitted_by: string;
  submitted_at_block: number;
  submitted_at_tx: string;
  executed_at_block: number | null;
  executed_at_tx: string | null;
  cancelled_at_block: number | null;
  cancelled_at_tx: string | null;
  created_at: string;
  updated_at: string;
}

interface Confirmation {
  id: string;
  wallet_address: string;
  tx_hash: string;
  owner_address: string;
  confirmed_at_block: number;
  confirmed_at_tx: string;
  revoked_at_block: number | null;
  revoked_at_tx: string | null;
  is_active: boolean;
  created_at: string;
}

interface Deposit {
  id: string;
  wallet_address: string;
  sender_address: string;
  amount: string; // BigInt as string
  deposited_at_block: number;
  deposited_at_tx: string;
  created_at: string;
}

interface WalletModule {
  id: string;
  wallet_address: string;
  module_address: string;
  enabled_at_block: number;
  enabled_at_tx: string;
  disabled_at_block: number | null;
  disabled_at_tx: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

interface DailyLimitState {
  id: string;
  wallet_address: string;
  daily_limit: string;
  spent_today: string;
  last_reset_day: string;
  updated_at: string;
}

interface WhitelistEntry {
  id: string;
  wallet_address: string;
  whitelisted_address: string;
  limit_amount: string | null;
  added_at_block: number;
  added_at_tx: string | null;
  removed_at_block: number | null;
  removed_at_tx: string | null;
  is_active: boolean;
  created_at: string;
}

interface SocialRecoveryConfig {
  id: string;
  wallet_address: string;
  threshold: number;
  recovery_period: number;
  setup_at_block: number;
  setup_at_tx: string;
  created_at: string;
  updated_at: string;
}

interface SocialRecoveryGuardian {
  id: string;
  wallet_address: string;
  guardian_address: string;
  added_at_block: number;
  added_at_tx: string;
  removed_at_block: number | null;
  removed_at_tx: string | null;
  is_active: boolean;
  created_at: string;
}

interface SocialRecovery {
  id: string;
  wallet_address: string;
  recovery_hash: string;
  new_owners: string[];
  new_threshold: number;
  initiator_address: string;
  approval_count: number;
  required_threshold: number;
  execution_time: number;
  status: 'pending' | 'executed' | 'cancelled';
  initiated_at_block: number;
  initiated_at_tx: string;
  executed_at_block: number | null;
  executed_at_tx: string | null;
  cancelled_at_block: number | null;
  cancelled_at_tx: string | null;
  created_at: string;
  updated_at: string;
}

interface RecoveryApproval {
  id: string;
  wallet_address: string;
  recovery_hash: string;
  guardian_address: string;
  approved_at_block: number;
  approved_at_tx: string;
  revoked_at_block: number | null;
  revoked_at_tx: string | null;
  is_active: boolean;
  created_at: string;
}

interface ModuleTransaction {
  id: string;
  wallet_address: string;
  module_type: string;
  module_address: string;
  to_address: string;
  value: string;
  remaining_limit: string | null;
  executed_at_block: number;
  executed_at_tx: string;
  created_at: string;
}
```

## Transaction Type Decoding

The indexer decodes transaction calldata and stores the type in `transaction_type`:

| Type | Description |
|------|-------------|
| `transfer` | Native QUAI transfer (no calldata) |
| `wallet_admin` | addOwner, removeOwner, changeThreshold, enableModule, disableModule |
| `module_config` | setDailyLimit, addToWhitelist, setupRecovery, etc. |
| `recovery_setup` | Social recovery configuration |
| `external_call` | Generic contract interaction |

Decoded parameters are stored in `decoded_params` as JSON:

```typescript
// Example: addOwner transaction
{
  transaction_type: 'wallet_admin',
  decoded_params: {
    function: 'addOwner',
    args: {
      owner: '0x1234...'
    }
  }
}
```

## React Hook Example

```typescript
import { useEffect, useState } from 'react';
import { useNetwork } from './NetworkContext'; // See NetworkProvider above

function useWalletTransactions(walletAddress: string) {
  const { supabase, network } = useNetwork();
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // Initial fetch
    async function fetchTransactions() {
      const { data } = await supabase
        .from('transactions')
        .select('*')
        .eq('wallet_address', walletAddress.toLowerCase())
        .order('created_at', { ascending: false });

      setTransactions(data ?? []);
      setLoading(false);
    }

    fetchTransactions();

    // Subscribe to changes (use network schema, not 'public')
    const channel = supabase
      .channel(`transactions:${walletAddress}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: network, // 'testnet' or 'mainnet'
          table: 'transactions',
          filter: `wallet_address=eq.${walletAddress.toLowerCase()}`
        },
        (payload) => {
          if (payload.eventType === 'INSERT') {
            setTransactions(prev => [payload.new as Transaction, ...prev]);
          } else if (payload.eventType === 'UPDATE') {
            setTransactions(prev =>
              prev.map(tx =>
                tx.id === (payload.new as Transaction).id
                  ? (payload.new as Transaction)
                  : tx
              )
            );
          }
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [walletAddress, supabase, network]);

  return { transactions, loading };
}
```

## Best Practices

### 1. Normalize Addresses

Always lowercase addresses before querying:

```typescript
const address = walletAddress.toLowerCase();
```

### 2. Handle BigInt Values

The `value` and `amount` fields are stored as strings (PostgreSQL can't store JS BigInt). Parse them as needed:

```typescript
import { formatEther } from 'quais';

const displayAmount = formatEther(transaction.value);
```

### 3. Use Pagination for Large Datasets

```typescript
const PAGE_SIZE = 20;

async function getTransactionsPage(walletAddress: string, page: number) {
  const from = page * PAGE_SIZE;
  const to = from + PAGE_SIZE - 1;

  const { data, error } = await supabase
    .from('transactions')
    .select('*', { count: 'exact' })
    .eq('wallet_address', walletAddress.toLowerCase())
    .order('created_at', { ascending: false })
    .range(from, to);

  return data;
}
```

### 4. Clean Up Subscriptions

Always unsubscribe when components unmount:

```typescript
useEffect(() => {
  const unsubscribe = subscribeToTransactions(walletAddress, ...);
  return () => unsubscribe();
}, [walletAddress]);
```

### 5. Cache Wallet Data

Wallet details change infrequently. Cache them and only refresh on relevant events:

```typescript
const walletCache = new Map<string, Wallet>();

async function getWallet(address: string) {
  if (!walletCache.has(address)) {
    const { data } = await supabase
      .from('wallets')
      .select('*')
      .eq('address', address.toLowerCase())
      .single();
    if (data) walletCache.set(address, data);
  }
  return walletCache.get(address);
}
```

## Error Handling

```typescript
async function safeQuery<T>(
  query: Promise<{ data: T | null; error: Error | null }>
): Promise<T | null> {
  const { data, error } = await query;

  if (error) {
    console.error('Supabase query error:', error);
    // Optionally report to error tracking service
    return null;
  }

  return data;
}

// Usage
const transactions = await safeQuery(
  supabase
    .from('transactions')
    .select('*')
    .eq('wallet_address', address)
);
```

## Indexer Health Check

The indexer exposes a health check endpoint that frontends can use to:
- Check if the indexer is running before making queries
- Display sync status to users
- Show how far behind the chain the indexer is

### Health Check Endpoint

```typescript
const INDEXER_HEALTH_URL = process.env.VITE_INDEXER_URL || 'http://localhost:3000';

interface HealthStatus {
  status: 'healthy' | 'unhealthy';
  timestamp: string;
  checks: {
    quaiRpc: { status: 'pass' | 'fail'; message?: string };
    supabase: { status: 'pass' | 'fail'; message?: string };
    indexer: { status: 'pass' | 'fail'; message?: string };
  };
  details: {
    currentBlock: number | null;
    lastIndexedBlock: number | null;
    blocksBehind: number | null;
    isSyncing: boolean;
    trackedWallets: number;
  };
}

async function getIndexerHealth(): Promise<HealthStatus | null> {
  try {
    const response = await fetch(`${INDEXER_HEALTH_URL}/health`);
    return await response.json();
  } catch {
    return null;
  }
}
```

### Display Sync Status

```typescript
function useSyncStatus() {
  const [status, setStatus] = useState<HealthStatus | null>(null);

  useEffect(() => {
    async function checkHealth() {
      const health = await getIndexerHealth();
      setStatus(health);
    }

    checkHealth();
    const interval = setInterval(checkHealth, 30000); // Check every 30s

    return () => clearInterval(interval);
  }, []);

  return {
    isHealthy: status?.status === 'healthy',
    isSyncing: status?.details.isSyncing ?? false,
    blocksBehind: status?.details.blocksBehind ?? null,
    lastIndexedBlock: status?.details.lastIndexedBlock ?? null,
  };
}
```

### Sync Status Component Example

```tsx
function SyncStatusBadge() {
  const { isHealthy, isSyncing, blocksBehind } = useSyncStatus();

  if (!isHealthy) {
    return <Badge color="red">Indexer Offline</Badge>;
  }

  if (isSyncing) {
    return <Badge color="yellow">Syncing...</Badge>;
  }

  if (blocksBehind && blocksBehind > 10) {
    return <Badge color="yellow">{blocksBehind} blocks behind</Badge>;
  }

  return <Badge color="green">Synced</Badge>;
}
```

## Environment Variables

Frontend `.env`:

```bash
# Supabase connection
VITE_SUPABASE_URL=https://your-project.supabase.co
VITE_SUPABASE_ANON_KEY=your-anon-key

# Network configuration
VITE_NETWORK_SCHEMA=testnet  # 'testnet' or 'mainnet'

# Optional: Indexer health check URL
VITE_INDEXER_URL=http://localhost:3001  # testnet: 3001, mainnet: 3002
```

**Security Notes:**
- **Never expose the service role key in frontend code** - use only the anon key
- The anon key is safe to expose; it only has read access to public data
- The same Supabase project/keys work for both networks (schemas provide isolation)

## Network-Specific Configuration

| Setting | Testnet | Mainnet |
|---------|---------|---------|
| `VITE_NETWORK_SCHEMA` | `testnet` | `mainnet` |
| `VITE_INDEXER_URL` | `http://localhost:3001` | `http://localhost:3002` |
| Quai RPC (for contract calls) | `https://rpc.orchard.quai.network/cyprus1` | `https://rpc.quai.network/cyprus1` |

For production deployments, replace localhost URLs with your actual indexer endpoints.
