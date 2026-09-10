import { cn } from "@/lib/utils";

// The two files below are served straight from public/. They used to be
// pointers into an external asset CDN rather than real files in the repo,
// which is why they stopped resolving once that service was removed. Drop the
// real artwork at public/vayam-logo-black.png and public/vayam-logo-white.png
// and it renders exactly as designed.

/** VAYAM Designers wordmark. Swaps automatically between light and dark themes. */
export function Logo({ className }: { className?: string }) {
  return (
    <span className={cn("inline-flex items-center", className)}>
      <img
        src="/vayam-logo-black.png"
        alt="VAYAM Designers"
        className="h-8 w-auto object-contain dark:hidden"
      />
      <img
        src="/vayam-logo-white.png"
        alt="VAYAM Designers"
        className="hidden h-8 w-auto object-contain dark:block"
      />
    </span>
  );
}
