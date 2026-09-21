import { cookies } from "next/headers";
import { findUser } from "./db";

export async function getLocale() {
  const c = await cookies();
  return c.get("locale")?.value === "en" ? "en" : "ar";
}

export async function getUser() {
  const c = await cookies();
  const id = c.get("uid")?.value;
  return id ? findUser(id) || null : null;
}
