import type { Request } from "express";

/**
 * Who is on the other end of a request — for the "View as" session record (services/impersonationService.ts) and
 * the sign-in history (services/activityService.ts).
 */

// Loopback, private, link-local and carrier-grade NAT (100.64.0.0/10) — where our own proxy or load balancer speaks from.
const PROXY_HOP = /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|::1$|fc|fd|fe80:)/i;

/**
 * The caller's IP, as our side saw it. Behind our own proxy (the socket is a local or private address) it is the
 * last X-Forwarded-For hop — the one that proxy added; earlier hops are whatever the client sent and are not
 * believed (a refused sign-in must not get to name its own address) — or, from a proxy that sends no
 * X-Forwarded-For, its X-Real-IP. Reached directly, it is the socket's address and the headers are ignored.
 */
export function clientIp(req: Request): string {
  const socket = String(req.socket?.remoteAddress ?? req.ip ?? "").replace(/^::ffff:/, "");
  const header = (name: string) => {
    const v = req.headers[name];
    return (Array.isArray(v) ? v.join(",") : v ?? "").split(",").map((h) => h.trim()).filter(Boolean);
  };
  let ip = socket;
  if (PROXY_HOP.test(socket)) {
    const hops = header("x-forwarded-for");
    ip = hops.length ? hops[hops.length - 1]! : header("x-real-ip")[0] ?? socket;
  }
  return ip.replace(/^::ffff:/, "").slice(0, 64);
}

export type DeviceType = "desktop" | "mobile" | "tablet" | "app" | "unknown";

/** "Chrome on Windows", "Safari on iOS", "Android app" — from the User-Agent. */
export function describeDevice(userAgent: string | undefined): { label: string; type: DeviceType } {
  const ua = userAgent ?? "";
  if (!ua) return { label: "Unknown device", type: "unknown" };
  if (/okhttp|Dalvik/i.test(ua)) return { label: "Android app", type: "app" };
  if (/Expo|ReactNative|CFNetwork/i.test(ua)) return { label: "Mobile app", type: "app" };

  const os = /Windows NT/.test(ua)
    ? "Windows"
    : /iPhone|iPad|iPod/.test(ua)
      ? "iOS"
      : /Android/.test(ua)
        ? "Android"
        : /CrOS/.test(ua)
          ? "ChromeOS"
          : /Mac OS X|Macintosh/.test(ua)
            ? "macOS"
            : /Linux/.test(ua)
              ? "Linux"
              : "";
  const browser = /Edg(e|A|iOS)?\//.test(ua)
    ? "Edge"
    : /OPR\/|Opera/.test(ua)
      ? "Opera"
      : /SamsungBrowser/.test(ua)
        ? "Samsung Internet"
        : /Firefox\/|FxiOS/.test(ua)
          ? "Firefox"
          : /Chrome\/|CriOS/.test(ua)
            ? "Chrome"
            : /Safari\//.test(ua)
              ? "Safari"
              : /curl\//i.test(ua)
                ? "curl"
                : "";
  const type: DeviceType =
    /iPad|Tablet/.test(ua) || (/Android/.test(ua) && !/Mobile/.test(ua))
      ? "tablet"
      : /Mobi|iPhone|Android/.test(ua)
        ? "mobile"
        : browser === "curl"
          ? "unknown"
          : "desktop";
  const label = browser && os ? `${browser} on ${os}` : browser || os || "Unknown device";
  return { label, type };
}
