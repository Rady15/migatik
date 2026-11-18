import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import {
  hashEnrollToken,
  isValidEnrollToken,
  makeRateLimiter,
  plainText,
  renderInstallScript,
} from "@/lib/router-enroll";

/**
 * PUBLIC — serves the RouterOS enrollment script (.rsc).
 *
 *   GET /api/onboard/install/<token>
 *
 * The token is the one printed in the dashboard command; it is short-lived
 * (30 min), stored hashed, and stops working after a successful callback.
 * The response carries the generated API password once — deploy behind HTTPS.
 */
export const dynamic = "force-dynamic";
const allow = makeRateLimiter(30);

function pathToken(req: NextRequest): string {
  return req.nextUrl.pathname.split("/").filter(Boolean).pop() ?? "";
}

export async function GET(req: NextRequest) {
  const ip = req.headers.get("x-real-ip") ?? req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "";
  if (!allow(ip)) return plainText("ERROR too-many-requests", 429);

  const token = pathToken(req);
  if (!isValidEnrollToken(token)) return plainText("ERROR invalid-token", 404);

  const enrollment = await db.routerEnrollment.findUnique({ where: { tokenHash: hashEnrollToken(token) } });
  if (!enrollment) return plainText("ERROR invalid-token", 404);
  if (enrollment.status === "installed") return plainText("ERROR already-installed", 410);
  if (enrollment.status !== "pending") return plainText("ERROR canceled-or-expired", 410);
  if (enrollment.expiresAt.getTime() < Date.now()) {
    await db.routerEnrollment.update({ where: { id: enrollment.id }, data: { status: "expired" } }).catch(() => {});
    return plainText("ERROR expired", 410);
  }

  await db.routerEnrollment.update({
    where: { id: enrollment.id },
    data: { installCount: { increment: 1 }, lastInstallAt: new Date() },
  }).catch(() => {});

  const script = renderInstallScript({
    baseUrl: enrollment.platformUrl,
    token,
    apiUsername: enrollment.apiUsername,
    apiPassword: (await import("@/lib/crypto")).decryptSecret(enrollment.apiPasswordEnc),
    hint: enrollment.tokenHint ?? "",
  });

  return new Response(script, {
    status: 200,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
