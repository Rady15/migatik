import { NextResponse } from "next/server";
import { getSession, SessionPayload } from "@/lib/session";

export async function requireAuth(): Promise<{ session: SessionPayload } | { response: NextResponse }> {
  const session = await getSession();
  if (!session) {
    return { response: NextResponse.json({ error: "غير مصرح — يرجى تسجيل الدخول" }, { status: 401 }) };
  }
  return { session };
}

export function badRequest(message: string) {
  return NextResponse.json({ error: message }, { status: 400 });
}

export function serverError(e: unknown) {
  console.error("API error:", e);
  return NextResponse.json({ error: "خطأ في الخادم — أعد المحاولة" }, { status: 500 });
}
