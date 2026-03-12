# Balance Server

Lightning Network backend for the BALANCE art installation.


NOTE: not tested or fully working. See [SatsATM](https://github.com/blankworker1/SatsATM) for latest version 

## Setup

```bash
npm install
cp .env.example .env
# Fill in your Blink API keys in .env
```

## Development

```bash
npm run dev
```

## Deploy to Railway

1. Push this repo to GitHub
2. Connect to Railway — it detects Node.js automatically
3. Add environment variables from `.env.example` in Railway dashboard
4. Railway provides your `BASE_URL` — set it in the env vars

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| POST | /sessions | Create visitor session (entry terminal) |
| GET | /sessions/:token | Get session balance |
| POST | /vouchers/redeem | Redeem ATM voucher |
| POST | /tips | Tip an artwork |
| POST | /withdrawals | Generate LNURL-Withdraw for exit terminal |
| GET | /withdraw/:id | LNURL-Withdraw info (called by wallet) |
| GET | /withdraw/callback | LNURL-Withdraw callback (called by wallet) |
| POST | /donations | Donate balance to artists |
| GET | /artworks | List artworks |
| POST | /artworks | Register artwork (admin) |
| GET | /admin/status | Live reconciliation dashboard |
| GET | /health | Health check |

## Reconciliation

```bash
npm run reconcile
```

## ⚠️ Before Go-Live

- [ ] Phase 0A: Verify Blink voucher redemption API — update `/vouchers/redeem`
- [ ] Restrict `/admin` routes to your IP address
- [ ] Set `CORS` origin to your webapp domain only
- [ ] Test LNURL-Withdraw end-to-end with a real Lightning wallet
- [ ] Run reconciliation script after every test transaction
