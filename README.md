# Commerce Ops MCP — Missing-Delivery Investigation

An MCP server that lets a commerce operations team investigate "my order never
arrived" complaints and resolve them without pulling in an engineer.

The operator works through an AI client in plain language. The AI gathers
evidence through read-only tools, then either issues a refund or files a
human-review escalation. **Every policy decision is made and enforced by this
server, not by the AI client.**

- **Hosted MCP endpoint:** `https://commerce-ops-mcp-production-c298.up.railway.app/mcp`
- **Source:** https://github.com/7vignesh/commerce-ops-mcp

---

## The workflow

One bounded path, end to end:

```
Customer reports a missing delivery
  │
  ├─ lookup_order              find the order from an email, phone, or order ID
  ├─ get_order_details         order state, amounts, line items, prior actions
  ├─ check_shipment_status     carrier evidence — is there a real exception?
  ├─ get_customer_history      risk score and refund history
  │
  └─ issue_refund
       ├─ all six conditions pass  ──▶  refund applied, logged, idempotent
       └─ any condition fails      ──▶  manager-approval escalation
```

`cancel_order` and `reship_order` are deliberately **escalation-only** — see
[Safety model](#safety-model).

---

## Safety model

The MCP consumer is treated as untrusted. An AI client can be confused by a
persuasive customer, retry a call after a dropped connection, or simply
hallucinate an argument. None of that can move money here, because the server
re-derives every decision from the database.

### Refund eligibility

`issue_refund` applies a refund only when **all six** conditions hold:

| # | Condition | Threshold |
|---|-----------|-----------|
| 1 | Refund amount within cap | ≤ $150 |
| 2 | Amount does not exceed what remains refundable | ≤ paid − already refunded |
| 3 | Order is recent | ≤ 30 days old |
| 4 | Customer risk is acceptable | risk score < 70 |
| 5 | Carrier exception verified | shipment is `lost` or `returned` |
| 6 | No existing refund on the order | refunded amount = 0 |

Plus a payment sanity check: the payment must have actually succeeded.

If any condition fails, **the refund is not applied.** The server files a
`pending_approval` escalation recording every failed condition as evidence, so
the reviewer sees why the automation declined. Callers cannot override a
threshold, and the AI is never asked to evaluate one — it only supplies an
order ID, amount, and reason.

Condition 5 is the one that carries the most weight in practice: a customer
saying a parcel never arrived is not evidence. The carrier marking it `lost` or
`returned` is. A parcel that is merely late stays in `in_transit` and will not
qualify for an automatic refund.

### Actions that never execute automatically

`cancel_order` and `reship_order` **always** escalate and never mutate order or
shipment state. Both gather evidence, assign a priority from the order's
current state, and hand off to a human. Cancelling a shipped order or
re-dispatching goods has physical, hard-to-reverse consequences, and unlike a
capped refund there is no bounded blast radius that makes automating it safe.

They still earn their place as tools: they turn a vague "customer wants to
cancel" into a structured, triaged case with the evidence already attached.

### Idempotency

Every mutation derives an idempotency key and is wrapped in a transaction.

Two things matter here, and the second is easy to miss:

1. The replay check runs **before** the eligibility check. Otherwise a retried
   request would see the refund the first call recorded, conclude the order was
   already refunded, and escalate a false duplicate to a manager.
2. `processRefund` takes a `FOR UPDATE` lock on the payment row, so genuinely
   concurrent refunds for one order serialise instead of racing that check. A
   `UNIQUE` constraint on `idempotency_key` is the final backstop.

A retried refund returns the original outcome and leaves the refunded amount
unchanged. Both paths are covered by tests.

### Audit trail

Every mutation and escalation writes to `action_log` with a reason (minimum 10
characters, enforced at the schema level), structured evidence, priority, and
status. `get_order_details` and `get_customer_history` read it back, so an
operator picking up a case sees what was already tried.

---

## Tools

### Read-only

| Tool | Purpose |
|------|---------|
| `lookup_order` | Find orders by order ID, customer email, or phone number |
| `get_order_details` | Full order state: items, amounts, payment, shipment, action history |
| `check_payment_status` | Payment state and failure reason. Evidence only — never mutates |
| `check_shipment_status` | Carrier status, delay calculation, and `hasCarrierException` |
| `get_customer_history` | Orders, spend, refund count, risk score, recent actions |

### Mutating

| Tool | Behaviour |
|------|-----------|
| `issue_refund` | Refunds if all six conditions pass, otherwise escalates. Idempotent |
| `cancel_order` | Always escalates. Never cancels |
| `reship_order` | Always escalates. Never reships |
| `escalate_to_human` | Files a durable escalation with priority, reason, and evidence |

Tool descriptions state these constraints inline, so a client can reason about
what will happen before calling. The server does not depend on it having done so.

---

## Try the workflow

Against the hosted server, ask the AI client:

> "A customer emailed about order ORD-1019 — they say it never arrived. Can you look into it?"

Expect the client to look up the order, find the carrier marked the shipment
`lost`, check the customer's risk, and refund. Then contrast:

| Ask about | Amount | Risk | Age | Outcome |
|-----------|--------|------|-----|---------|
| `ORD-1019` | $73.97 | 15 | 10d | Auto-refund — all conditions pass |
| `ORD-1051` | $229.98 | 18 | 6d | Escalates — refund cap only |
| `ORD-1024` | $23.47 | 12 | 36d | Escalates — order age only |
| `ORD-1021` | $20.48 | 72 | 12d | Escalates — customer risk only |
| `ORD-1012` | — | — | — | No refund — parcel still in transit, no carrier exception |

Each escalating order fails exactly **one** condition, so the reason in the
response maps to a single policy rule. Amounts other than `ORD-1051` shift a
little between seed runs, since most line items are randomised.

Retry an identical `issue_refund` call to see the idempotent path: the response
reports the original action and the refunded amount does not move.

---

## Running locally

Requires Node.js 20+ and a PostgreSQL database.

```bash
npm install
cp .env.example .env     # then set DATABASE_URL
npm run seed             # creates schema and loads synthetic data
npm run dev              # server on http://localhost:3000
```

| Script | |
|--------|--|
| `npm run dev` | Start with hot reload |
| `npm run seed` | Reset schema and reload synthetic data |
| `npm test` | Run the safety and idempotency suite |
| `npm run build` | Compile to `dist/` |

Verify it is up:

```bash
curl http://localhost:3000/health
```

### Connecting an MCP client

Transport is Streamable HTTP at `POST /mcp`. For a client that reads a config
file, pointing at the hosted server:

```json
{
  "mcpServers": {
    "commerce-ops": {
      "url": "https://commerce-ops-mcp-production-c298.up.railway.app/mcp"
    }
  }
}
```

Substitute `http://localhost:3000/mcp` to run against a local instance.

### Deployment note

The database host must be reachable over IPv4. Supabase's direct connection
hostname (`db.<ref>.supabase.co`) resolves to IPv6 only, and Railway containers
have no IPv6 egress — the connection hangs rather than failing cleanly. Use the
**connection pooler** host (`aws-0-<region>.pooler.supabase.com`), which has
IPv4 records. Note the pooler username is `postgres.<project-ref>` rather than
`postgres`.

If the database is unreachable the server still binds its port and `/health`
returns `503` with the underlying error, so the cause is visible rather than
surfacing as a generic platform 502.

---

## Tests

```bash
npm test
```

22 tests run against real PostgreSQL — the guarantees under test are
transactional (row locks, unique constraints, `FOR UPDATE`), and a mocked
database would verify the mocks rather than the behaviour.

Coverage:

- Each of the six refund conditions failing **in isolation**, so one guardrail
  cannot mask another
- The eligible path, including partial refunds
- Retried and concurrent refund requests
- `cancel_order` and `reship_order` leaving state untouched — asserted by
  re-reading the order and shipment rows after the call
- Escalations persisting priority, reason, and evidence

Each test creates fixtures under a unique ID and tears them down afterwards, so
the suite does not disturb the demo data.

---

## Data model

Synthetic data only. No real customer data or production credentials.

```
customers ──< orders ──< payments      (1:1, unique order_id)
                   │
                   ├──< shipments
                   └──< action_log     (unique idempotency_key)
```

**Invariants enforced in the schema:** `refunded_amount` never exceeds `amount`
(enforced in the update predicate); one payment per order; `idempotency_key` is
unique; status values are constrained by `CHECK`; `risk_score` is 0–100.

**Statuses.** Orders: `pending`, `confirmed`, `shipped`, `delivered`,
`cancelled`, `failed`. Payments: `success`, `failed`, `pending`, `refunded`.
Shipments: `processing`, `in_transit`, `out_for_delivery`, `delivered`, `lost`,
`returned`. Only `lost` and `returned` count as carrier exceptions.

The seed covers 51 orders across every status, with 7 lost and 2 returned
shipments, and a risk-score spread that includes three high-risk customers.
Coverage of meaningful states was the goal rather than volume.

---

## Decisions and assumptions

**Scope.** One complaint path — missing delivery, ending in refund or
escalation. Payment failures, item quality, and address changes are out of
scope. A narrow path exercised properly says more about the design than four
half-built ones.

**Refund caps over approval queues.** Bounding what automation may do is
simpler to reason about than modelling multi-step approval, and the escalation
record is where a real approval queue would attach.

**Risk score is stored, not computed.** A real system would derive it from
chargebacks and claim frequency. Modelling that is a separate problem, so the
score is seeded per customer and the server treats it as input.

**No authentication.** Out of scope per the brief and confirmed with the
client. See [Limitations](#limitations).

**PostgreSQL over a lighter store.** The safety guarantees are transactional,
so they need real transactions, row-level locks, and unique constraints.

**Escalations are records, not notifications.** No email or Slack delivery —
a `pending_approval` row is the durable handoff, and a notifier would read from
it.

---

## Limitations

**The `/mcp` endpoint is unauthenticated and publicly reachable, and it exposes
mutating tools.** Anyone with the URL can call `issue_refund`. This is
deliberate for the assignment and confirmed with the client; all data is
synthetic and no production credentials are involved. It would be the first
thing to fix for real use — bearer-token auth on the transport, then an
operator identity threaded into `action_log` so the audit trail records *who*
acted rather than just what happened.

**Refunds are recorded, not settled.** `issue_refund` updates the payment row;
it does not call a payment provider. A real integration needs the provider call
and the local write to agree, which means an outbox or reconciliation job —
the idempotency key is the seam that would hook into.

**Sessions are in memory.** A restart drops active MCP sessions and clients
must reinitialise. Fine for one instance; horizontal scaling needs shared
session state.

**No approval workflow.** Escalations are queryable rows. Nothing yet lets a
manager approve or reject one, which is the obvious next increment.

**Thresholds are compile-time constants.** The cap, age limit, and risk
threshold live in `src/guards/safety.ts`. Real operations would want them
configurable without a redeploy.

**`get_customer_history` takes a customer ID,** which the AI has to obtain from
an order lookup first. Accepting an email directly would remove a step.

---

## Layout

```
src/
  server.ts          MCP server, Streamable HTTP transport, session handling
  db/index.ts        Pool, schema, transaction helper
  data/seed.ts       Synthetic data
  guards/safety.ts   Eligibility rules, refund application, escalation
  tools/             One file per tool
tests/
  safety.test.ts     Safety and idempotency verification
```

Policy lives in `guards/safety.ts` rather than in the tool handlers, so the
rules are readable in one place and cannot drift between call sites.
