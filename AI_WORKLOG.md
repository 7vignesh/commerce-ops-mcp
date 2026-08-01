# AI Worklog

## Tools and Models Used

- **Primary coding assistant:** Claude (via Pi coding agent CLI) — used for all implementation, debugging, testing, and documentation
- **Model selection rationale:** Claude was chosen for its strong TypeScript fluency, ability to hold architectural context across a long session, and reliable code generation that compiles on first pass most of the time

## How AI Was Used to Plan and Break Down Work

- The assignment was broken into communication phases (6 emails) and implementation phases before any code was written
- AI proposed the workflow scope (order investigation → refund or escalation), MCP tool design, and data model — then refined all three based on client feedback
- Each implementation phase had an explicit plan with file creation order and dependencies identified before coding began

## Division of Responsibilities

**Human decisions:**
- Chose the deployment platform (Railway) and database host (Supabase)
- Managed all client communication and sent emails
- Handled Railway dashboard configuration and environment variables
- Made the call on commit granularity ("split into smaller commits")
- Decided when to proceed vs. wait for client feedback

**AI responsibilities:**
- All code implementation (server, tools, schema, seed, tests, safety guards)
- Database schema design and synthetic data generation
- Debugging deployment failures (IPv6 issue, startup ordering)
- Writing tests that verified real transactional behaviour
- Drafting all email communication
- README and documentation

## Important Prompts and Context Supplied

- The full assignment brief was provided upfront
- Client email replies were pasted verbatim into the conversation, allowing the AI to adjust implementation to match their specific constraints (e.g., "$150 cap", "customer risk below 70", "do not trust the MCP consumer")
- "Plan it first and implement it accordingly" — forced structured planning before coding
- "Multiple commits" — led to rewriting git history into logical, reviewable chunks

## AI Suggestions Corrected or Rejected

1. **SQLite → PostgreSQL:** The initial implementation used SQLite. The client required PostgreSQL with specific transactional guarantees. The AI had to discard the working SQLite layer and rebuild with `pg`.

2. **Refund idempotency bug:** The AI's initial `issue_refund` implementation checked eligibility before idempotency. Tests caught that a retried request would see its own prior refund and escalate a false duplicate to a manager. The fix (replay check first, plus row-level locking) was non-trivial and emerged from the test suite, not from the AI getting it right initially.

3. **SSL detection:** The AI initially gated SSL on `connectionString.includes("supabase")` — a provider-specific hack. Corrected to detect localhost vs. non-localhost, so any managed database gets TLS without naming the provider.

4. **Startup ordering:** The AI placed `await initializeDatabase()` at module scope, blocking `app.listen()`. This went undetected until Railway returned 502. Needed a fundamental restructure: bind port first, let database connect asynchronously, report state on `/health`.

5. **PORT advice:** Initially said "don't set PORT on Railway." Had to correct this when Railway's domain dialog required an explicit port number.

6. **Seed data quality:** ORD-1024 was commented as "low risk, age only" but assigned to a customer with risk score 85, making it fail two conditions. The AI didn't catch this until explicitly querying the seeded data and seeing the overlap. Each guardrail demo order now fails on exactly one condition.

## How AI-Generated Work Was Verified

- **TypeScript compiler:** `npx tsc --noEmit` run after every change — zero tolerance for type errors
- **22 PostgreSQL-backed integration tests:** Testing real transactional behaviour (row locks, unique constraints, concurrent requests) rather than mocking
- **Manual curl verification:** Full MCP handshake + tool calls tested against both local and hosted servers
- **Data verification queries:** Confirmed refunded amounts, action log counts, and fixture cleanup after each test run
- **Hosted endpoint verification:** Health check, MCP session, lookup, refund, escalation, and idempotent replay all confirmed working against the Railway deployment

## Remaining Risks and Unfinished Work

- **No authentication** on the public `/mcp` endpoint — documented as a known limitation, confirmed acceptable by the client for this assignment
- **Sessions are in-memory** — a restart drops active sessions; horizontal scaling would need shared session state
- **Refunds are recorded, not settled** — no payment provider integration; the idempotency key is the seam where that would attach
- **No approval workflow** — escalations are durable records but nothing yet lets a manager approve or reject them
- **Thresholds are compile-time constants** — real operations would want runtime configuration
- **Test suite is slow (~40s)** due to network round-trips to Supabase in Australia — acceptable for a small suite, would need a local test database for a larger one
