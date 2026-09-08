import { MongoClient, MongoNetworkError, MongoServerSelectionError } from "mongodb";

// ---------------------------------------------------------------------------
// Connection options — tuned for Atlas / serverless Next.js
// ---------------------------------------------------------------------------
const MONGO_OPTIONS = {
  // Fail fast: 8 s to find a primary instead of the 30 s default.
  // This keeps the upload SSE stream responsive and lets the retry wrapper
  // make a second attempt well within any reasonable request budget.
  serverSelectionTimeoutMS: 8_000,

  // Time allowed to establish a new TCP connection.
  connectTimeoutMS: 10_000,

  // 0 = no socket-level idle timeout (operations drive their own timeouts).
  socketTimeoutMS: 0,

  // Pool size: large enough for parallel embedding batch writes.
  maxPoolSize: 10,
  minPoolSize: 2,

  // Keep connections alive so Atlas doesn't close idle sockets.
  maxIdleTimeMS: 60_000,

  // Atlas requires TLS; the driver enables it automatically from the SRV URI
  // but we force IPv4 to avoid the ERR_SSL_TLSV1_ALERT_INTERNAL_ERROR that
  // can occur when the OS prefers an IPv6 address that Atlas does not serve.
  family: 4,

  // Both default to true in driver v7; explicit for clarity.
  retryWrites: true,
  retryReads: true,
} as const;

// ---------------------------------------------------------------------------
// Singleton client (dev: cached on global to survive HMR; prod: module-level)
// ---------------------------------------------------------------------------
const uri = process.env.MONGODB_URI;

let clientPromise: Promise<MongoClient>;

if (!uri) {
  clientPromise = Promise.reject(
    new Error("MONGODB_URI is not set — add it to .env.local"),
  );
} else if (process.env.NODE_ENV === "development") {
  const g = global as typeof globalThis & {
    _mongoClientPromise?: Promise<MongoClient>;
  };
  if (!g._mongoClientPromise) {
    g._mongoClientPromise = new MongoClient(uri, MONGO_OPTIONS).connect();
  }
  clientPromise = g._mongoClientPromise;
} else {
  // In production one module instance lives for the lifetime of the Lambda /
  // Node.js process; no global caching needed.
  clientPromise = new MongoClient(uri, MONGO_OPTIONS).connect();
}

export const MONGODB_DB_NAME = process.env.MONGODB_DB ?? "deepdoc";

export async function getDb() {
  const client = await clientPromise;
  return client.db(MONGODB_DB_NAME);
}

export default clientPromise;

// ---------------------------------------------------------------------------
// Transient-error retry wrapper
// ---------------------------------------------------------------------------

/** Errors that are safe to retry (network blip, primary election, etc.). */
function isTransient(err: unknown): boolean {
  if (err instanceof MongoServerSelectionError) return true;
  if (err instanceof MongoNetworkError) return true;
  if (err instanceof Error) {
    const msg = err.message.toLowerCase();
    return (
      msg.includes("econnreset") ||
      msg.includes("econnrefused") ||
      msg.includes("etimeout") ||
      msg.includes("connection timed out") ||
      msg.includes("connection closed") ||
      msg.includes("socket") ||
      msg.includes("topology") ||
      msg.includes("replicasetnoprimary") ||
      msg.includes("no primary") ||
      msg.includes("not master") ||
      msg.includes("ssl") ||
      msg.includes("tls")
    );
  }
  return false;
}

const RETRY_DELAYS_MS = [500, 1_500, 4_000]; // 3 attempts, increasing backoff

/**
 * Wraps a MongoDB operation with automatic retry on transient failures.
 *
 * Usage:
 *   const result = await withMongoRetry(() => col.findOne(...));
 */
export async function withMongoRetry<T>(
  fn: () => Promise<T>,
  label = "mongo",
): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isTransient(err) || attempt === RETRY_DELAYS_MS.length) throw err;
      const delay = RETRY_DELAYS_MS[attempt];
      console.warn(
        `[${label}] transient error (attempt ${attempt + 1}), retrying in ${delay}ms —`,
        err instanceof Error ? err.message : err,
      );
      await new Promise<void>((r) => setTimeout(r, delay));
    }
  }
  throw lastErr;
}
