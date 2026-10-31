import type { LucideIcon } from "lucide-react";
import { Mail } from "lucide-react";

import { routes } from "@/utils/routes";

export interface LogsSidebarItem {
  id: string;
  label: string;
  href: string;
  icon: LucideIcon;
}

export const LOGS_SIDEBAR: LogsSidebarItem[] = [
  { id: "emails", label: "Emails", href: routes.logs.emails, icon: Mail },
];
