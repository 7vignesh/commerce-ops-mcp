import pg from "pg";

const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || "postgresql://postgres:postgres@localhost:5432/commerce_ops",
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
  ssl: process.env.DATABASE_URL?.includes("supabase") ? { rejectUnauthorized: false } : undefined,
});

// Test connection on startup
pool.on("error", (err) => {
  console.error("Unexpected PostgreSQL pool error:", err);
});

export async function query<T = any>(text: string, params?: any[]): Promise<T[]> {
  const result = await pool.query(text, params);
  return result.rows as T[];
}

export async function queryOne<T = any>(text: string, params?: any[]): Promise<T | null> {
  const result = await pool.query(text, params);
  return (result.rows[0] as T) || null;
}

export async function execute(text: string, params?: any[]): Promise<number> {
  const result = await pool.query(text, params);
  return result.rowCount ?? 0;
}

export async function transaction<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function initializeDatabase(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS customers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      phone TEXT NOT NULL UNIQUE,
      risk_score INTEGER NOT NULL DEFAULT 0 CHECK(risk_score >= 0 AND risk_score <= 100),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS orders (
      id TEXT PRIMARY KEY,
      customer_id TEXT NOT NULL REFERENCES customers(id),
      items JSONB NOT NULL,
      total_amount NUMERIC(10,2) NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('pending', 'confirmed', 'shipped', 'delivered', 'cancelled', 'failed')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS payments (
      id TEXT PRIMARY KEY,
      order_id TEXT NOT NULL UNIQUE REFERENCES orders(id),
      method TEXT NOT NULL CHECK(method IN ('upi', 'card', 'cod', 'netbanking')),
      status TEXT NOT NULL CHECK(status IN ('success', 'failed', 'pending', 'refunded')),
      amount NUMERIC(10,2) NOT NULL,
      failure_reason TEXT,
      refunded_amount NUMERIC(10,2) NOT NULL DEFAULT 0,
      refunded_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS shipments (
      id TEXT PRIMARY KEY,
      order_id TEXT NOT NULL REFERENCES orders(id),
      carrier TEXT NOT NULL,
      tracking_number TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('processing', 'in_transit', 'out_for_delivery', 'delivered', 'lost', 'returned')),
      estimated_delivery TIMESTAMPTZ NOT NULL,
      actual_delivery TIMESTAMPTZ,
      last_update TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS action_log (
      id TEXT PRIMARY KEY,
      order_id TEXT NOT NULL REFERENCES orders(id),
      action TEXT NOT NULL,
      reason TEXT NOT NULL,
      details JSONB,
      idempotency_key TEXT UNIQUE,
      status TEXT NOT NULL DEFAULT 'completed' CHECK(status IN ('completed', 'pending_approval', 'approved', 'rejected')),
      priority TEXT CHECK(priority IN ('low', 'medium', 'high', 'critical')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_orders_customer_id ON orders(customer_id);
    CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
    CREATE INDEX IF NOT EXISTS idx_payments_order_id ON payments(order_id);
    CREATE INDEX IF NOT EXISTS idx_shipments_order_id ON shipments(order_id);
    CREATE INDEX IF NOT EXISTS idx_action_log_order_id ON action_log(order_id);
    CREATE INDEX IF NOT EXISTS idx_action_log_idempotency ON action_log(idempotency_key);
  `);

  console.log("✅ Database schema initialized");
}

export default pool;
