import { NextResponse } from "next/server";
import { db } from "@/lib/db";

/**
 * Lightweight readiness probe for deployment debugging (Vercel, Docker...).
 * Returns only connectivity/table existence — never credentials or row data.
 *
 *   GET /api/health?debug=1
 */
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const debug = new URL(req.url).searchParams.get("debug") === "1";
  let dbConnected = false;
  let adminTable = false;
  let message: string | undefined;

  try {
    // Use Unsafe here: Supabase transaction pooler (pgbouncer) does not support
    // named prepared statements reused across pooled connections (error 42P05).
    await db.$executeRawUnsafe("SELECT 1");
    dbConnected = true;
  } catch (e) {
    message = String((e as Error).message ?? e);
  }

  if (dbConnected) {
    try {
      // A real query against AdminUser — if the table was never migrated this fails.
      await db.adminUser.count();
      adminTable = true;
    } catch (e) {
      message = String((e as Error).message ?? e);
    }
  }

  // Strip connection strings / hosts from Prisma messages before exposing them.
  if (debug && message) {
    message = message
      .replace(/[a-z][a-z0-9+.-]*:\/\/[^ "'<>]+/gi, "[connection-string-redacted]")
      .slice(0, 300);
  } else {
    message = undefined;
  }

  const ready = dbConnected && adminTable;
  return NextResponse.json(
    {
      ok: ready,
      status: ready ? "ready" : dbConnected ? "schema-missing" : "db-unreachable",
      dbConnected,
      adminTable,
      ...(debug ? { message } : {}),
    },
    { status: ready ? 200 : 503 },
  );
}
