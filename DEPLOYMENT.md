# QuaiVault Indexer - Deployment Guide

This guide covers deploying the QuaiVault Indexer on a VPS using either Docker or native Ubuntu systemd.

## Table of Contents

- [Prerequisites](#prerequisites)
- [Environment Configuration](#environment-configuration)
- [Docker Deployment](#docker-deployment)
- [Ubuntu Systemd Deployment](#ubuntu-systemd-deployment)
- [Running Multiple Environments](#running-multiple-environments)
- [Monitoring & Health Checks](#monitoring--health-checks)
- [Backfill Operations](#backfill-operations)
- [Troubleshooting](#troubleshooting)

---

## Prerequisites

### System Requirements
- **OS**: Ubuntu 22.04+ or any Linux with Docker support
- **RAM**: 512MB minimum, 1GB recommended
- **Disk**: 1GB for application + logs
- **Node.js**: v18+ (for native deployment)
- **Docker**: v20+ (for Docker deployment)

### Required Services
- **Supabase**: Database with schema deployed (see `supabase/` directory)
- **Quai RPC**: Access to Quai Network RPC endpoint

### Quai Network Endpoints

**Important**: Use base URLs without shard path. The indexer auto-appends `/cyprus1` for direct RPC calls, and uses `usePathing: true` for provider connections.

| Network | RPC URL |
|---------|---------|
| Orchard Testnet | `https://rpc.orchard.quai.network` |
| Mainnet | `https://rpc.quai.network` |

---

## Environment Configuration

### Required Environment Variables

```bash
# Quai Network (use base URL - shard auto-appended)
QUAI_RPC_URL=https://rpc.orchard.quai.network

# Supabase
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_KEY=your-service-role-key
SUPABASE_SCHEMA=testnet           # Database schema (testnet, mainnet, or public)

# Contract Addresses (deploy these first)
QUAIVAULT_FACTORY_ADDRESS=0x...
QUAIVAULT_IMPLEMENTATION_ADDRESS=0x...

# Optional Module and Utility Addresses
SOCIAL_RECOVERY_MODULE_ADDRESS=0x...
MULTISEND_ADDRESS=0x...

# Indexer Settings
START_BLOCK=0                    # Block to start indexing from
BATCH_SIZE=1000                  # Blocks per batch during backfill
POLL_INTERVAL=5000               # Milliseconds between polls
CONFIRMATIONS=2                  # Block confirmations before indexing

# Token Tracking (optional — comma-separated ERC20/ERC721 addresses)
SEED_TOKEN_ADDRESSES=

# CORS (comma-separated allowed origins for health endpoint)
CORS_ALLOWED_ORIGINS=https://testnet.quaivault.org,https://quaivault.org

# Health Check
HEALTH_CHECK_ENABLED=true
HEALTH_CHECK_PORT=8080
HEALTH_MAX_BLOCKS_BEHIND=100

# Logging
LOG_LEVEL=info
LOG_TO_FILE=true
NODE_ENV=production
```

### Environment Files

Copy the appropriate template for your network:

```bash
# For Orchard Testnet
cp .env.testnet.example .env

# For Mainnet
cp .env.mainnet.example .env
```

Then edit `.env` with your actual values.

---

## Docker Deployment

### Quick Start

```bash
# 1. Clone the repository
git clone <repository-url>
cd quaivault-indexer

# 2. Create environment file
cp .env.testnet.example .env
# Edit .env with your values

# 3. Build and start
./scripts/deploy.sh start
```

### Manual Docker Commands

```bash
# Build the image
npm run build
docker build -t quaivault-indexer .

# Start the container
docker compose up -d

# View logs
docker compose logs -f

# Stop
docker compose down
```

### Docker with Custom Network Name

For running multiple instances (testnet + mainnet):

```bash
# Testnet
docker compose -p indexer-testnet --env-file .env.testnet up -d

# Mainnet
docker compose -p indexer-mainnet --env-file .env.mainnet up -d
```

---

## Ubuntu Systemd Deployment

### Installation

```bash
# 1. Install Node.js 20
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# 2. Create application user
sudo useradd -r -s /bin/false quai-indexer

# 3. Create application directory
sudo mkdir -p /opt/quaivault-indexer
sudo chown quai-indexer:quai-indexer /opt/quaivault-indexer

# 4. Clone and build
cd /opt/quaivault-indexer
sudo -u quai-indexer git clone <repository-url> .
sudo -u quai-indexer npm ci --production
sudo -u quai-indexer npm run build

# 5. Create environment file
sudo cp .env.testnet.example .env
sudo chown quai-indexer:quai-indexer .env
sudo chmod 600 .env
# Edit .env with your values

# 6. Install systemd service
sudo cp deploy/quaivault-indexer.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable quaivault-indexer
sudo systemctl start quaivault-indexer
```

### Systemd Commands

```bash
# Start the service
sudo systemctl start quaivault-indexer

# Stop the service
sudo systemctl stop quaivault-indexer

# Restart the service
sudo systemctl restart quaivault-indexer

# View status
sudo systemctl status quaivault-indexer

# View logs
sudo journalctl -u quaivault-indexer -f

# View logs since last hour
sudo journalctl -u quaivault-indexer --since "1 hour ago"
```

### Running Multiple Instances (Testnet + Mainnet)

For running both networks on the same server:

```bash
# Create separate directories
sudo mkdir -p /opt/quaivault-indexer-testnet
sudo mkdir -p /opt/quaivault-indexer-mainnet

# Install in each directory with respective .env files

# Install services
sudo cp deploy/quaivault-indexer@.service /etc/systemd/system/
sudo systemctl daemon-reload

# Enable and start both
sudo systemctl enable quaivault-indexer@testnet
sudo systemctl enable quaivault-indexer@mainnet
sudo systemctl start quaivault-indexer@testnet
sudo systemctl start quaivault-indexer@mainnet
```

---

## Running Multiple Environments

### Directory Structure for Multi-Environment

```
/opt/
├── quaivault-indexer-testnet/
│   ├── .env              # Testnet configuration
│   ├── dist/
│   └── node_modules/
└── quaivault-indexer-mainnet/
    ├── .env              # Mainnet configuration
    ├── dist/
    └── node_modules/
```

### Port Configuration

When running multiple instances, use different health check ports:

```bash
# Testnet .env
HEALTH_CHECK_PORT=8081

# Mainnet .env
HEALTH_CHECK_PORT=8082
```

### Database Schema Configuration

The indexer supports running multiple networks in a **single Supabase project** using PostgreSQL schemas. This provides clean data isolation without requiring separate database projects.

#### Setting Up Network Schemas

1. Open Supabase SQL Editor for your project

2. Run the schema creation function (one-time setup):
   ```sql
   -- Load the schema creation function
   -- (copy contents of supabase/migrations/schema.sql and run it)

   -- Create testnet schema
   SELECT create_quaivault_schema('testnet');

   -- Create mainnet schema
   SELECT create_quaivault_schema('mainnet');
   ```

3. **Expose schemas to the Supabase API** (required):
   ```sql
   -- Allow API access to custom schemas
   ALTER ROLE authenticator SET pgrst.db_schemas TO 'public, graphql_public, testnet, mainnet';

   -- Reload PostgREST configuration
   NOTIFY pgrst, 'reload config';
   ```

   Alternatively, go to **Project Settings → API → Exposed Schemas** in the Supabase dashboard and add `testnet, mainnet`.

4. Configure each indexer instance with the appropriate schema:
   ```bash
   # Testnet .env
   SUPABASE_SCHEMA=testnet

   # Mainnet .env
   SUPABASE_SCHEMA=mainnet
   ```

**Note:** The `create_quaivault_schema()` function automatically:
- Creates all tables, indexes, and triggers
- Sets up Row Level Security policies
- Grants permissions to service_role, authenticated, and anon roles
- Enables Supabase Realtime for frontend subscriptions

#### Database Structure

```
Supabase Project
├── testnet (schema)
│   ├── wallets
│   ├── transactions
│   ├── confirmations
│   └── ... (all tables)
├── mainnet (schema)
│   ├── wallets
│   ├── transactions
│   ├── confirmations
│   └── ... (all tables)
└── public (schema - unused or legacy)
```

#### Benefits of Schema-Based Separation

| Feature | Schema Approach | Separate Projects |
|---------|-----------------|-------------------|
| Cost | Single project billing | 2x project costs |
| Isolation | Logical (same DB) | Complete (separate DBs) |
| Cross-network queries | Possible with schema prefix | Not possible |
| Management | Single dashboard | Two dashboards |
| API Keys | Shared (same project) | Separate keys |

#### Querying Across Networks (Advanced)

If you need to compare data across networks:

```sql
-- Example: Compare wallet counts
SELECT 'testnet' as network, COUNT(*) FROM testnet.wallets
UNION ALL
SELECT 'mainnet' as network, COUNT(*) FROM mainnet.wallets;
```

#### Legacy/Migration Notes

- If using `SUPABASE_SCHEMA=public` (default), the indexer uses the original `public` schema
- Existing deployments can continue using `public` without migration
- New deployments should use network-specific schemas (`testnet`, `mainnet`)

---

## Monitoring & Health Checks

### Health Endpoints

| Endpoint | Purpose | Success Code |
|----------|---------|--------------|
| `/health` | Full health status | 200 (healthy) / 503 (unhealthy) |
| `/ready` | Kubernetes readiness | 200 (ready) / 503 (not ready) |
| `/live` | Kubernetes liveness | 200 (always) |

### Example Health Response

```json
{
  "status": "healthy",
  "timestamp": "2024-01-15T10:30:00.000Z",
  "checks": {
    "quaiRpc": { "status": "pass" },
    "supabase": { "status": "pass" },
    "indexer": { "status": "pass" }
  },
  "details": {
    "currentBlock": 1234567,
    "lastIndexedBlock": 1234565,
    "blocksBehind": 0,
    "isSyncing": false
  }
}
```

### External Monitoring

```bash
# Simple uptime check
curl -f http://localhost:8080/health || echo "Unhealthy"

# With jq for status extraction
curl -s http://localhost:8080/health | jq -r '.status'
```

### Prometheus Integration (Optional)

Add to your Prometheus config:

```yaml
scrape_configs:
  - job_name: 'quai-indexer'
    static_configs:
      - targets: ['localhost:8080']
    metrics_path: /health
```

---

## Backfill Operations

### Running a Backfill

For historical data indexing:

```bash
# Using npm (development)
BACKFILL_FROM=0 BACKFILL_TO=1000000 npm run backfill

# Using Docker
docker compose run --rm indexer node dist/backfill.js

# With custom range
docker compose run --rm -e BACKFILL_FROM=0 -e BACKFILL_TO=500000 indexer node dist/backfill.js
```

### Backfill Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `BACKFILL_FROM` | Starting block number | `START_BLOCK` |
| `BACKFILL_TO` | Ending block number | Current block |

---

## Troubleshooting

### Common Issues

#### 1. RPC Connection Errors

```
Error: RPC error: fetch failed
```

**Solution**: Verify RPC URL is correct and accessible:
```bash
curl -X POST -H "Content-Type: application/json" \
  --data '{"jsonrpc":"2.0","method":"quai_blockNumber","params":[],"id":1}' \
  https://rpc.orchard.quai.network/cyprus1
```

#### 2. Supabase Connection Errors

```
Error: Invalid API key
```

**Solution**: Ensure you're using the **service role** key, not the anon key.

#### 3. Indexer Falling Behind

Check `/health` endpoint for `blocksBehind` value. If consistently high:
- Increase `BATCH_SIZE` for faster processing
- Check RPC rate limits
- Consider running dedicated RPC node

#### 4. Memory Issues

For large numbers of tracked wallets:
```bash
# Increase Node.js memory limit
NODE_OPTIONS="--max-old-space-size=2048" node dist/index.js
```

### Log Locations

| Deployment | Log Location |
|------------|--------------|
| Docker | `docker compose logs -f` |
| Systemd | `journalctl -u quaivault-indexer -f` |
| Development | Console output |

### Useful Commands

```bash
# Check if port is in use
sudo lsof -i :8080

# Check Node.js processes
ps aux | grep node

# Check Docker containers
docker ps -a

# Check systemd service status
systemctl list-units --type=service | grep quai
```

---

## Security Recommendations

1. **Environment Files**: Never commit `.env` files. Use `.env.*.example` templates.
2. **Service Keys**: `SUPABASE_SERVICE_KEY` uses the service_role key which bypasses Row Level Security. The indexer should run in a network-isolated environment (private subnet, VPN, or container network) with no public ingress. For production, consider creating a dedicated Postgres role with only the permissions the indexer needs instead of using the service_role key.
3. **Network**: Run behind a firewall; health check ports should not be public. Configure `HEALTH_CHECK_HOST=127.0.0.1` to bind only to localhost if the health endpoint is accessed via a reverse proxy.
4. **Trusted Proxies**: If running behind a load balancer, set `TRUSTED_PROXIES` to the proxy IPs (comma-separated) so the health endpoint correctly identifies client IPs from `X-Forwarded-For`. Without this, the header is ignored and the socket address is used directly.
5. **Updates**: Regularly update dependencies for security patches.
6. **Backups**: The indexer is stateless; Supabase handles data persistence.

---

## Support

For issues or questions:
- Check logs first for error messages
- Verify environment configuration
- Test RPC connectivity independently
- Open an issue in the repository
