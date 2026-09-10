import { cn } from "@/lib/utils";

// The two files below are served straight from public/. They used to be
// pointers into an external asset CDN rather than real files in the repo,
// which is why they stopped resolving once that service was removed. Drop the
// real artwork at public/vayam-logo-black.png and public/vayam-logo-white.png
// and it renders exactly as designed.

/**
 * VAYAM Designers wordmark. Swaps automatically between light and dark themes.
 *
 * The height comes from the class the caller passes. The images used to carry a
 * fixed height of their own, which quietly overrode it, so every wordmark in the
 * app rendered the same size whatever the call site asked for.
 */
export function Logo({ className }: { className?: string }) {
  return (
    <span className={cn("inline-flex items-center", className)}>
      <img
        src="/vayam-logo-black.png"
        alt="VAYAM Designers"
        className="h-full w-auto object-contain dark:hidden"
      />
      <img
        src="/vayam-logo-white.png"
        alt="VAYAM Designers"
        className="hidden h-full w-auto object-contain dark:block"
      />
    </span>
  );
}
