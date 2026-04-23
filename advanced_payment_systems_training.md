# Payment Systems Training Document (Advanced)

## 1. Understanding the Payment Journey

A payment is not a single event. It is a journey through multiple systems, each of which can fail. Every point is a potential place where money can disappear.

**Example:** Wunmi buys a ₦45,000 generator. Network is slow. She clicks "Pay" multiple times. Before any kobo touches your PSP, every payment must be scored to prevent fraud and card testing attacks.

## 2. Fraud Prevention and 3DS Liability Shift

- Always trigger 3DS on card payments.
- Liability shift protects your platform from chargebacks.
- Fraud scoring must be instantaneous and transparent to the customer.

## 3. Idempotency

- Every request must carry a unique key.
- Prevent multiple charges for duplicate requests.
- Apply idempotency to payments, refunds, webhooks, payouts, and wallet operations.

## 4. PSP Redundancy

- Never rely on a single PSP.
- Use routers to balance between PSPs.
- Handle PSP downtime gracefully.

## 5. Webhooks

- Verify HMAC signatures.
- Deduplicate by event ID.
- Acknowledge immediately; process asynchronously.

## 6. Transaction State Machine

- Every state is explicit; transitions are intentional.
- Implement cleanup jobs for stuck transactions.
- States example: `PROCESSING`, `SUCCESS`, `FAILED`, `ABANDONED`.

## 7. Wallets and Race Conditions

- Lock wallets before reading balances.
- Perform atomic debit/credit operations.
- Release lock after completion.

## 8. Retry Logic & Decline Codes

- Handle soft declines with retries.
- Respect hard declines; do not retry.
- Implement exponential backoff and route to backup PSP if needed.

## 9. Refunds & Chargebacks

- Provide easy refund flow to prevent chargebacks.
- Record all refunds in the ledger.
- Monitor chargeback ratios to protect your merchant account.

## 10. Payouts & Withdrawals

- Validate accounts and perform AML checks.
- Reverse wallet debit if payout fails.
- Track payouts through multiple states.

## 11. Reconciliation

- Match internal transactions against PSP reports.
- Investigate mismatches immediately.
- Do not ignore unmatched transactions.

## 12. Recurring Payments & Dunning

- Retry failed subscription charges intelligently.
- Implement notification sequence before suspending accounts.

## 13. KYC, AML & Compliance

- Enforce transaction limits based on KYC tiers.
- Screen all counterparties against OFAC, UN, and CBN watchlists.
- Never log raw card numbers.

## 14. Advanced Layers

### 14.1 Ledger System

- Implement a double-entry ledger.
- Ledger is the single source of truth.
- Wallets are derived from ledger balances.

### 14.2 Settlement vs Authorization

- Track authorization, capture, settlement, and payout separately.
- Prevent money inconsistencies due to delays.

### 14.3 Fee Accounting

- Track gross amount, PSP fee, platform fee, and net amount.
- Maintain traceability for reconciliation and merchant payouts.

### 14.4 Multi-Currency Handling

- Use a currency field on every transaction.
- Track FX rates to avoid silent losses.

### 14.5 Rate Limiting & Abuse Protection

- Rate limit payment attempts per user/IP.
- Prevent card testing and brute-force attacks.

### 14.6 Queue Infrastructure

- Use job queues for async processing.
- Implement retry policies and dead-letter queues.

### 14.7 Observability

- Monitor success rate, PSP latency, and decline codes.
- Alert on system anomalies and mismatches.
- Use structured logs per transaction.

### 14.8 Access Control & Escrow Logic

- Separate available, held, and pending settlement funds.
- Prevent withdrawal of disputed funds.

### 14.9 Disaster Recovery

- Transactional DB writes.
- Retry-safe operations.
- Daily backups and restore testing.

### 14.10 PSP Dispute Handling Workflow

- Track disputes from webhook to resolution.
- Maintain evidence submission records.
- Lifecycle management for disputes.

### 14.11 Manual Admin Tools

- Manual refund trigger.
- Transaction search and override.
- Audit logs for every action.

## 15. Financial System Design (Deep Dive)

### 15.1 System Invariants

- **Money Conservation:** Total debits = total credits.
- **Ledger Immutability:** Ledger entries are append-only.
- **Balance Derivation:** Balances are calculated from ledger, not stored independently.
- **Single Source of Truth:** Ledger > Wallet.
- **Idempotent External Effects:** Repeating actions does not change outcome.

### 15.2 Failure Domains

- Ledger domain (strong consistency)
- Payments domain (eventual consistency)
- UX domain (best effort)

### 15.3 Saga Pattern

- Use forward + compensating actions for distributed transactions.
- Example: Debit wallet → Call PSP → Success/Fail → Compensate if fail.

### 15.4 Ledger Architecture

- **User Ledger:** deposits, purchases, refunds.
- **System Ledger:** fees, platform revenue.
- **Escrow Ledger:** held funds, pending payouts.

### 15.5 Time as First-Class Citizen

- Track `created_at`, `updated_at`, `processed_at`, `expires_at`.
- Never trust arrival order; rely on timestamps.

### 15.6 Event-Driven Architecture

- Commands → Events → State
- Enables replay, debugging, and auditability.

### 15.7 Continuous Reconciliation

- Detect mismatches in real-time.
- Classify and resolve automatically or manually.

### 15.8 Consistency Models

- Strong consistency for ledger and balances.
- Eventual consistency for UI, notifications, analytics.

### 15.9 Trust Boundaries

- Validate every external input.
- Never trust client or PSP IDs blindly.

### 15.10 Attack Surface Awareness

- Protect against double spending, race conditions, replay attacks, webhook spoofing.

### 15.11 Financial Observability

- Monitor invariants continuously.
- Detect drift and alert in real-time.

### 15.12 System Evolution

- Version APIs, events, schemas.
- Ensure backward compatibility and migration safety.

### 15.13 Mental Model Shift

- Treat every transaction as a sequence of states, backed by ledger entries, validated by invariants, and recoverable via events.
- You are building a **financial state machine over time**.

---

# 🔚 Conclusion

By following this guide, you achieve:
- Financial correctness (no lost money)
- Auditability (full traceability)
- Resilience (failures don’t corrupt state)
- Scalability (system survives growth)

You are now designing a **financial system with correctness guarantees under failure**, not just a payment feature.

