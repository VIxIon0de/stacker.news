/* eslint-env jest */

import { sendPayment } from './lnc'
import { WalletPaymentRejectedError } from '@/wallets/client/errors'
import { bolt11Msats } from '../../../lib/bolt11'

// the invoice amount only matters here for the default fee budget, and hand-rolling
// signed invoices to vary it would test light-bolt11-decoder, not this adapter
jest.mock('../../../lib/bolt11', () => ({ bolt11Msats: jest.fn() }))

const SEND_PAYMENT_V2 = 'routerrpc.Router.SendPaymentV2'
const SEND_PAYMENT_SYNC = 'lnrpc.Lightning.SendPaymentSync'

const BOLT11 = 'lnbc1pexample'
const PREIMAGE = 'a'.repeat(64)
const CREDENTIALS = { pairingPhrase: 'phrase' }

// The adapter reuses one LNC instance parked on window, so a fake placed there is
// what connection.connect() hands to sendPayment — no lnc-web, no mailbox.
function useFakeLnc ({ perms, payment, syncResult }) {
  const calls = { v2: [], sync: [] }

  global.window.snLnc = {
    isConnected: true,
    credentials: { credentials: {} },
    hasPerms: uri => perms.includes(uri),
    lnd: {
      router: {
        sendPaymentV2: (request, onData, onError) => {
          calls.v2.push(request)
          queueMicrotask(() => (payment instanceof Error ? onError(payment) : onData(payment)))
        }
      },
      lightning: {
        sendPaymentSync: request => {
          calls.sync.push(request)
          return Promise.resolve(syncResult)
        }
      }
    }
  }
  global.window.snLncCredentials = { ...CREDENTIALS }

  return calls
}

beforeEach(() => {
  global.window = { addEventListener: () => {} }
  bolt11Msats.mockReturnValue(1_000_000n)
})

afterEach(() => {
  clearTimeout(global.window?.snLncKillerTimeout)
  delete global.window
})

describe('sendPayment over SendPaymentV2', () => {
  test('sends the payment and returns the proof', async () => {
    const calls = useFakeLnc({
      perms: [SEND_PAYMENT_V2],
      payment: { status: 'SUCCEEDED', paymentPreimage: PREIMAGE, feeMsat: '1234' }
    })

    const result = await sendPayment(BOLT11, CREDENTIALS, { maxFee: 21 })

    expect(calls.sync).toHaveLength(0)
    expect(calls.v2).toHaveLength(1)
    expect(calls.v2[0]).toEqual({
      paymentRequest: BOLT11,
      timeoutSeconds: 30,
      // in-flight updates would resolve the call on the first HTLC attempt
      noInflightUpdates: true,
      // int64 field, so a string rather than a number
      feeLimitSat: '21'
    })
    expect(result).toEqual({ status: 'SETTLED', preimage: PREIMAGE, actualFeeMsats: 1234n })
  })

  test('never sends both fee limit fields', async () => {
    const calls = useFakeLnc({
      perms: [SEND_PAYMENT_V2],
      payment: { status: 'SUCCEEDED', paymentPreimage: PREIMAGE }
    })

    await sendPayment(BOLT11, CREDENTIALS, { maxFee: 21 })

    expect(calls.v2[0]).not.toHaveProperty('feeLimitMsat')
  })

  // SendPaymentV2 considers only zero-fee routes when no limit is set, so a send
  // with no caller maxFee has to carry the budget lnrpc used to apply itself
  test('falls back to lnd\'s own default budget: 100% of a small payment', async () => {
    const calls = useFakeLnc({
      perms: [SEND_PAYMENT_V2],
      payment: { status: 'SUCCEEDED', paymentPreimage: PREIMAGE }
    })
    bolt11Msats.mockReturnValue(1_000_000n) // 1k sat

    await sendPayment(BOLT11, CREDENTIALS, {})

    expect(calls.v2[0].feeLimitMsat).toBe('1000000')
    expect(calls.v2[0]).not.toHaveProperty('feeLimitSat')
  })

  test('and 5% of a larger one', async () => {
    const calls = useFakeLnc({
      perms: [SEND_PAYMENT_V2],
      payment: { status: 'SUCCEEDED', paymentPreimage: PREIMAGE }
    })
    bolt11Msats.mockReturnValue(100_000_000n) // 100k sat

    await sendPayment(BOLT11, CREDENTIALS, {})

    expect(calls.v2[0].feeLimitMsat).toBe('5000000')
  })

  test('but sets no budget it cannot derive, for an amountless invoice', async () => {
    const calls = useFakeLnc({
      perms: [SEND_PAYMENT_V2],
      payment: { status: 'SUCCEEDED', paymentPreimage: PREIMAGE }
    })
    bolt11Msats.mockReturnValue(null)

    await sendPayment(BOLT11, CREDENTIALS, {})

    expect(calls.v2[0]).not.toHaveProperty('feeLimitMsat')
  })

  test('rejects a failed payment with the reason lnd gave', async () => {
    useFakeLnc({
      perms: [SEND_PAYMENT_V2],
      payment: { status: 'FAILED', failureReason: 'FAILURE_REASON_NO_ROUTE' }
    })

    await expect(sendPayment(BOLT11, CREDENTIALS, {}))
      .rejects.toThrow(new WalletPaymentRejectedError('FAILURE_REASON_NO_ROUTE'))
  })

  test('treats a non-terminal update as unknown rather than settled or failed', async () => {
    useFakeLnc({
      perms: [SEND_PAYMENT_V2],
      payment: { status: 'IN_FLIGHT' }
    })

    const result = await sendPayment(BOLT11, CREDENTIALS, {})

    expect(result.status).toBe('UNKNOWN')
  })

  test('reads lnd numeric status enums too', async () => {
    useFakeLnc({
      perms: [SEND_PAYMENT_V2],
      payment: { status: 2, paymentPreimage: PREIMAGE }
    })

    expect((await sendPayment(BOLT11, CREDENTIALS, {})).status).toBe('SETTLED')
  })

  test('rejects an invalid maxFee before sending anything', async () => {
    const calls = useFakeLnc({ perms: [SEND_PAYMENT_V2], payment: {} })

    await expect(sendPayment(BOLT11, CREDENTIALS, { maxFee: -1 })).rejects.toThrow('invalid maxFee')
    expect(calls.v2).toHaveLength(0)
  })
})

describe('sessions minted before SendPaymentV2', () => {
  test('fall back to SendPaymentSync', async () => {
    const calls = useFakeLnc({
      perms: [SEND_PAYMENT_SYNC],
      syncResult: { paymentPreimage: Buffer.from(PREIMAGE, 'hex').toString('base64'), feeMsat: '7' }
    })

    const result = await sendPayment(BOLT11, CREDENTIALS, { maxFee: 21 })

    expect(calls.v2).toHaveLength(0)
    expect(calls.sync).toEqual([{ paymentRequest: BOLT11, feeLimit: { fixed: '21' } }])
    expect(result).toEqual({ status: 'SETTLED', preimage: PREIMAGE, actualFeeMsats: 7n })
  })

  test('but a session holding both permissions uses SendPaymentV2', async () => {
    const calls = useFakeLnc({
      perms: [SEND_PAYMENT_SYNC, SEND_PAYMENT_V2],
      payment: { status: 'SUCCEEDED', paymentPreimage: PREIMAGE },
      syncResult: {}
    })

    await sendPayment(BOLT11, CREDENTIALS, {})

    expect(calls.v2).toHaveLength(1)
    expect(calls.sync).toHaveLength(0)
  })
})
