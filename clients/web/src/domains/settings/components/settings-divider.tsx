import { cn } from "@mycadet/design-library";

export function SettingsDivider({ className }: { className?: string }) {
  return (
    <div
      role="presentation"
      className={cn("h-px w-full bg-[var(--border-base)]", className)}
    />
  );
}
