import { redirect } from "next/navigation";

import DashboardClient from "@/components/dashboard-client";
import { isAdminAuthenticated } from "@/lib/auth";

export default async function DashboardPage() {
  if (!(await isAdminAuthenticated())) {
    redirect("/login");
  }

  return <DashboardClient />;
}
