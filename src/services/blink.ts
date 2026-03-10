import axios from 'axios';

// ── Blink GraphQL client ──────────────────────────────────────────────────────
// All Blink API calls go through here. Two separate clients for ATM and Treasury
// wallets — each uses its own API key so they are fully isolated.

const BLINK_URL = process.env.BLINK_API_URL || 'https://api.blink.sv/graphql';

function blinkClient(apiKey: string) {
  return axios.create({
    baseURL: BLINK_URL,
    headers: {
      'Content-Type': 'application/json',
      'X-API-KEY': apiKey,
    },
    timeout: 15000,
  });
}

export const atmClient     = () => blinkClient(process.env.BLINK_ATM_API_KEY!);
export const treasuryClient = () => blinkClient(process.env.BLINK_TREASURY_API_KEY!);

// ── Shared GraphQL helper ─────────────────────────────────────────────────────

async function gql(client: ReturnType<typeof blinkClient>, query: string, variables: object = {}) {
  const res = await client.post('', { query, variables });
  if (res.data.errors) {
    throw new Error(`Blink API error: ${JSON.stringify(res.data.errors)}`);
  }
  return res.data.data;
}

// ── Wallet balance check ──────────────────────────────────────────────────────

export async function getWalletBalance(walletId: string, apiKey: string): Promise<number> {
  const client = blinkClient(apiKey);
  const data = await gql(client, `
    query WalletBalance($walletId: WalletId!) {
      me {
        defaultAccount {
          wallets {
            id
            balance
          }
        }
      }
    }
  `, { walletId });

  const wallets = data.me.defaultAccount.wallets;
  const wallet = wallets.find((w: any) => w.id === walletId);
  if (!wallet) throw new Error(`Wallet ${walletId} not found`);
  return wallet.balance;
}

// ── Pay to Lightning address (Treasury → Artwork) ─────────────────────────────

export async function payLightningAddress(
  lightningAddress: string,
  amountSats: number,
  memo: string
): Promise<string> {
  const data = await gql(treasuryClient(), `
    mutation LnAddressPaymentSend($input: LnAddressPaymentSendInput!) {
      lnAddressPaymentSend(input: $input) {
        status
        transaction {
          id
        }
        errors {
          message
        }
      }
    }
  `, {
    input: {
      walletId: process.env.BLINK_TREASURY_WALLET_ID,
      lnAddress: lightningAddress,
      amount: amountSats,
      memo,
    }
  });

  const result = data.lnAddressPaymentSend;
  if (result.errors?.length) {
    throw new Error(`Payment failed: ${result.errors[0].message}`);
  }
  if (result.status !== 'SUCCESS') {
    throw new Error(`Payment status: ${result.status}`);
  }
  return result.transaction.id;
}

// ── Pay a Lightning invoice (Treasury → Visitor wallet via LNURL callback) ────

export async function payLightningInvoice(
  paymentRequest: string
): Promise<string> {
  const data = await gql(treasuryClient(), `
    mutation LnInvoicePaymentSend($input: LnInvoicePaymentInput!) {
      lnInvoicePaymentSend(input: $input) {
        status
        transaction {
          id
        }
        errors {
          message
        }
      }
    }
  `, {
    input: {
      walletId: process.env.BLINK_TREASURY_WALLET_ID,
      paymentRequest,
      memo: 'Art installation withdrawal',
    }
  });

  const result = data.lnInvoicePaymentSend;
  if (result.errors?.length) {
    throw new Error(`Invoice payment failed: ${result.errors[0].message}`);
  }
  if (result.status !== 'SUCCESS') {
    throw new Error(`Invoice payment status: ${result.status}`);
  }
  return result.transaction.id;
}

// ── BTC/EUR price ─────────────────────────────────────────────────────────────

export async function fetchBtcEurPrice(): Promise<number> {
  // Using a simple public price API — not Blink-specific
  const res = await axios.get('https://api.coingecko.com/api/v3/simple/price', {
    params: { ids: 'bitcoin', vs_currencies: 'eur' },
    timeout: 8000,
  });
  const btcEur: number = res.data.bitcoin.eur;
  // Convert BTC/EUR to sats/EUR: 1 BTC = 100,000,000 sats
  return 100_000_000 / btcEur;
}
