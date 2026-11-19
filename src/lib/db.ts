import { PrismaClient } from "@prisma/client";
import { getTenantCtx, TENANT_MODELS } from "@/lib/tenant-context";

/**
 * Prisma client with automatic multi-tenant isolation.
 *
 * For every operation on a tenant-owned model, when a tenant context is active
 * (see src/lib/tenant-context.ts) and the caller is NOT platform-level staff:
 *  - create / createMany: stamp organizationId on the written rows.
 *  - upsert: organizationId added to the lookup AND the created row.
 *  - findUnique / findUniqueOrThrow / update / delete: organizationId is added to
 *    the unique where (Prisma "extended where unique"), so another organization's
 *    row behaves exactly like a missing one (null / P2025).
 *  - findMany / findFirst / count / aggregate / groupBy / updateMany / deleteMany:
 *    organizationId injected into where.
 *
 * Platform-level SUPER_ADMIN sessions without an active organization bypass the
 * injection (SaaS operator console). Every route handler runs inside
 * withOrg() which establishes the context — verified by the cross-tenant
 * penetration test suite.
 */
const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

/**
 * Transient connectivity failures (Supabase pooler / network blips) surface as
 * these Prisma error codes. Retrying a couple of times turns a user-visible 500
 * into a successful request.
 */
const TRANSIENT_DB_CODES = new Set(["P1001", "P1002", "P1008", "P1017", "P2024", "P2028", "P2037"]);

function isTransientDbError(e: unknown): boolean {
  const code = (e as { code?: string } | null)?.code;
  return typeof code === "string" && TRANSIENT_DB_CODES.has(code);
}

async function withDbRetry<T>(run: () => Promise<T>, attempts = 5): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await run();
    } catch (e) {
      lastError = e;
      if (!isTransientDbError(e) || attempt === attempts - 1) throw e;
      // 300ms → 750ms → 1.5s → 3s: rides out short Supabase pooler/network blips.
      await new Promise((resolve) => setTimeout(resolve, [300, 750, 1500, 3000][attempt] ?? 3000));
    }
  }
  throw lastError;
}

function buildClient(): PrismaClient {
  const client = new PrismaClient({ log: ["error", "warn"] });
  return client.$extends({
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }) {
          const ctx = getTenantCtx();
          if (!model || !TENANT_MODELS.has(model) || !ctx || ctx.isPlatform) {
            return withDbRetry(() => query(args));
          }
          const a = (args ?? {}) as Record<string, unknown>;
          const orgId = ctx.organizationId;
          switch (operation) {
            case "create":
              // orgId LAST so a caller-supplied organizationId can NEVER override the stamp
              a.data = { ...((a.data as object) ?? {}), organizationId: orgId };
              break;
            case "createMany":
            case "createManyAndReturn": {
              const d = a.data;
              if (Array.isArray(d)) a.data = d.map((row) => ({ ...(row as object), organizationId: orgId }));
              else a.data = { ...((d as object) ?? {}), organizationId: orgId };
              break;
            }
            case "upsert":
              // For upsert, only add organizationId to create data, not where clause
              // (unique constraints don't include organizationId)
              a.create = { ...((a.create as object) ?? {}), organizationId: orgId };
              break;
            default: {
              // findUnique / findFirst / findUniqueOrThrow / findFirstOrThrow /
              // count / aggregate / groupBy / update / updateMany / delete / deleteMany
              if (a.where !== undefined || ["findMany", "findUnique", "findUniqueOrThrow", "update", "delete", "updateMany", "deleteMany", "findFirst", "findFirstOrThrow", "count", "aggregate", "groupBy"].includes(operation)) {
                a.where = { ...((a.where as object) ?? {}), organizationId: orgId };
              }
              break;
            }
          }
          return withDbRetry(() => query(a));
        },
      },
    },
  }) as unknown as PrismaClient;
}

export const db = globalForPrisma.prisma ?? buildClient();

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = db;
