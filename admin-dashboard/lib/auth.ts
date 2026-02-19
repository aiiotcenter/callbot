import "server-only";

import crypto from "node:crypto";
import { cookies } from "next/headers";

import { getServerEnv } from "./env";

const SESSION_COOKIE_NAME = "callbot_admin_session";
const SESSION_TTL_SECONDS = 60 * 60 * 8;

function toBase64Url(value: string) {
  return Buffer.from(value, "utf8").toString("base64url");
}

function fromBase64Url(value: string) {
  return Buffer.from(value, "base64url").toString("utf8");
}

function signPayload(payloadBase64: string, secret: string) {
  return crypto.createHmac("sha256", secret).update(payloadBase64).digest("base64url");
}

function timingSafeEqual(a: string, b: string) {
  const aBuffer = Buffer.from(a);
  const bBuffer = Buffer.from(b);

  if (aBuffer.length !== bBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(aBuffer, bBuffer);
}

export function createSessionToken() {
  const env = getServerEnv();
  const payload = {
    exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS,
    nonce: crypto.randomUUID()
  };

  const payloadBase64 = toBase64Url(JSON.stringify(payload));
  const signature = signPayload(payloadBase64, env.ADMIN_SESSION_SECRET);
  return `${payloadBase64}.${signature}`;
}

export function verifySessionToken(token: string) {
  const env = getServerEnv();
  const [payloadBase64, signature] = token.split(".");

  if (!payloadBase64 || !signature) {
    return false;
  }

  const expectedSignature = signPayload(payloadBase64, env.ADMIN_SESSION_SECRET);
  if (!timingSafeEqual(signature, expectedSignature)) {
    return false;
  }

  try {
    const parsed = JSON.parse(fromBase64Url(payloadBase64)) as { exp?: number };
    if (!parsed.exp || parsed.exp < Math.floor(Date.now() / 1000)) {
      return false;
    }

    return true;
  } catch {
    return false;
  }
}

export async function isAdminAuthenticated() {
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE_NAME)?.value;

  if (!token) {
    return false;
  }

  return verifySessionToken(token);
}

export async function setAdminSessionCookie() {
  const cookieStore = await cookies();
  cookieStore.set({
    name: SESSION_COOKIE_NAME,
    value: createSessionToken(),
    httpOnly: true,
    sameSite: "strict",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: SESSION_TTL_SECONDS
  });
}

export async function clearAdminSessionCookie() {
  const cookieStore = await cookies();
  cookieStore.set({
    name: SESSION_COOKIE_NAME,
    value: "",
    httpOnly: true,
    sameSite: "strict",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 0
  });
}

export async function requireAdminAuth() {
  const ok = await isAdminAuthenticated();
  return ok;
}
