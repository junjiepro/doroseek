import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// Unique ID for this specific Doroseek relay server instance.
// Useful for inter-instance communication to identify message origins
// or to prevent an instance from processing its own broadcast messages.
export const RELAY_INSTANCE_ID = crypto.randomUUID();
