import { redirect } from "next/navigation";

import { isAdminAuthenticated } from "@/lib/auth";

export default async function HomePage() {
  if (await isAdminAuthenticated()) {
    redirect("/dashboard");
  }

  redirect("/login");
}
