import crypto from "node:crypto";

import { NextResponse } from "next/server";
import { z } from "zod";

import { setAdminSessionCookie } from "@/lib/auth";
import { getServerEnv } from "@/lib/env";

const loginSchema = z.object({
  password: z.string().min(1)
});

function timingSafeEqual(a: string, b: string) {
  const aBuffer = Buffer.from(a);
  const bBuffer = Buffer.from(b);

  if (aBuffer.length !== bBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(aBuffer, bBuffer);
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const parsed = loginSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json({ error: "Invalid payload" }, { status: 400 });
    }

    const env = getServerEnv();
    const valid = timingSafeEqual(parsed.data.password, env.ADMIN_DASHBOARD_PASSWORD);

    if (!valid) {
      return NextResponse.json({ error: "Invalid credentials" }, { status: 401 });
    }

    await setAdminSessionCookie();
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unexpected error" },
      { status: 500 }
    );
  }
}
