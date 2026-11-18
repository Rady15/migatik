import { encryptSecret, decryptSecret } from "@/lib/crypto";

/**
 * Advanced voucher authentication modes (v3).
 *
 * user_pass       : username + separate generated password (classic).
 * pin             : ONE generated code used as BOTH username and password.
 * username_only   : passwordless Hotspot login — REAL RouterOS requirement:
 *                   the hotspot user is created with an EMPTY password AND the
 *                   user's hotspot profile must include `http-pap` in login-by
 *                   so the login page can authenticate with the username alone.
 *                   The platform verifies the live profile and reports
 *                   `passwordlessReady` honestly — it never silently omits
 *                   the password and claims passwordless works.
 * scratch         : username + password, but the printed card hides the
 *                   password behind a scratch panel (admin can reveal).
 *
 * Credentials are stored encrypted at rest (AES-256-GCM). The legacy plaintext
 * `password` column is only used as a read fallback for pre-v3 rows.
 */

export type AuthMode = "user_pass" | "pin" | "username_only" | "scratch";

export const AUTH_MODES: Record<AuthMode, {
  labelAr: string; labelEn: string;
  requiresPassword: boolean; hiddenOnPrint: boolean;
  noteAr: string; noteEn: string;
}> = {
  user_pass: {
    labelAr: "اسم مستخدم + كلمة مرور", labelEn: "Username + Password",
    requiresPassword: true, hiddenOnPrint: false,
    noteAr: "دخول بالاسم وكلمة المرور المولّدة", noteEn: "Login with generated username and password",
  },
  pin: {
    labelAr: "رمز PIN واحد", labelEn: "Single PIN",
    requiresPassword: true, hiddenOnPrint: false,
    noteAr: "نفس الرمز يُستخدم كاسم مستخدم وكلمة مرور", noteEn: "The same code is used as both username and password",
  },
  username_only: {
    labelAr: "اسم المستخدم فقط (بدون كلمة مرور)", labelEn: "Username Only (passwordless)",
    requiresPassword: false, hiddenOnPrint: false,
    noteAr: "يتطلب تفعيل http-pap في login-by بروفايل الهوتسبوت — تتحقق المنصة من الإعداد الفعلي",
    noteEn: "Requires http-pap in the hotspot profile login-by — the platform verifies the live config",
  },
  scratch: {
    labelAr: "كلمة مرور مخفية (سكراتش)", labelEn: "Hidden scratch-off password",
    requiresPassword: true, hiddenOnPrint: true,
    noteAr: "كلمة المرور مخفية خلف لوحة سكراتش في الطباعة", noteEn: "Password hidden behind a scratch panel on print",
  },
};

export function isAuthMode(v: unknown): v is AuthMode {
  return typeof v === "string" && ["user_pass", "pin", "username_only", "scratch"].includes(v);
}

/** Resolve the working credential of a voucher (encrypted at rest, legacy fallback). */
export function voucherCredential(v: { passwordEnc?: string | null; password?: string | null }): string {
  if (v.passwordEnc) {
    try { return decryptSecret(v.passwordEnc); } catch { /* fall through */ }
  }
  return v.password ?? "";
}

export interface CodeOptions {
  prefix: string;
  length: number;
  charset: "alnum" | "numeric";
  mode: "random" | "sequential";
  taken: Set<string>;
  startIndex?: number;
}

const ALNUM = "abcdefghjkmnpqrstuvwxyz23456789"; // no ambiguous chars (i,l,o,0,1)
const NUMERIC = "23456789";

/** Generate a unique code (returns undefined if sequential space is exhausted). */
export function generateCode(opts: CodeOptions): string | null {
  const seqNum = opts.startIndex ?? 1;
  const chars = opts.charset === "numeric" ? NUMERIC : ALNUM;
  if (opts.mode === "sequential") {
    let code: string;
    let n = seqNum;
    let attempts = 0;
    do {
      code = `${opts.prefix}${String(n++).padStart(opts.length, "0")}`;
      attempts++;
      if (attempts > 1_000_000) return null;
    } while (opts.taken.has(code));
    opts.taken.add(code);
    return code;
  }
  let code: string;
  let attempts = 0;
  do {
    let out = "";
    for (let i = 0; i < opts.length; i++) out += chars[Math.floor(Math.random() * chars.length)];
    code = `${opts.prefix}${out}`;
    attempts++;
    if (attempts > 100_000) return null; // charset space exhausted
  } while (opts.taken.has(code));
  opts.taken.add(code);
  return code;
}

/** Build the encrypted-at-rest credential record for a voucher row. */
export function credentialRecord(authMode: AuthMode, username: string, password: string): {
  password: string; passwordEnc: string; hiddenOnPrint: boolean;
} {
  const mode = AUTH_MODES[authMode];
  const effectivePassword = mode.requiresPassword ? password : "";
  return {
    // plaintext column left EMPTY for new rows — encrypted copy only
    password: "",
    passwordEnc: encryptSecret(effectivePassword),
    hiddenOnPrint: mode.hiddenOnPrint,
  };
}
