import { z } from "zod";

const envSchema = z.object({
  PORT: z.string().default("5000"),
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  MONGODB_URI: z.string().min(1, "MONGODB_URI is required"),
  JWT_SECRET: z.string().min(1, "JWT_SECRET is required"),
  JWT_EXPIRES_IN: z.string().default("7d"),
  JWT_REFRESH_SECRET: z.string().min(1, "JWT_REFRESH_SECRET is required"),
  JWT_REFRESH_EXPIRES_IN: z.string().default("30d"),

  /* The shared secret the Root portal presents when it asks this CRM about
     its roles or its people. Unset means those endpoints are off, rather
     than open — a deployment that has not been told about the portal must
     not expose its whole user list by default. Must match the portal's
     DRAW_SSO_SECRET. */
  ROOT_ERP_SECRET: z.string().default(""),
  SUPER_ADMIN_NAME: z.string().default("Super Admin"),
  SUPER_ADMIN_EMAIL: z.string().email().default("superadmin@crm.com"),
  SUPER_ADMIN_PASSWORD: z.string().default("SuperAdmin@123"),
  CLIENT_URL: z.string().default("http://localhost:3000"),
  VAPID_PUBLIC_KEY:    z.string().default(""),
  VAPID_PRIVATE_KEY:   z.string().default(""),
  VAPID_SUBJECT:       z.string().default("mailto:admin@carltoncrm.com"),
  GEMINI_API_KEY:      z.string().default(""),
  TELEGRAM_BOT_TOKEN:  z.string().default(""),
  TELEGRAM_CHAT_ID:    z.string().default(""),
  // LMS mentor calendar integration; empty settings keep the feature disabled.
  LMS_API_URL: z.string().default(""),
  LMS_SERVICE_SECRET: z.string().default(""),
  LMS_REMOTE_ORG_ID: z.string().default(""),

  /*
   * Delta Finance, where a closed lead becomes an invoice.
   *
   * The same organization the Delta sales CRM bills into, not a separate
   * one of Draw's own — FINANCE_ORG_ID should be set to that org's id, and
   * FINANCE_CLIENT_ID / FINANCE_INTEGRATION_SECRET to the very same values
   * the Delta CRM holds. Finance recognises one signed caller for its whole
   * integration surface, not a caller per system, so there is no separate
   * credential to issue here — this is not a shortcut, it is the only
   * credential that exists. Enrolments are told apart by the source field instead:
   * this CRM sends "draw-crm", Delta's sends "crm".
   *
   * All four empty means the handover is off: the CRM works exactly as it
   * did, students are created, and nothing is queued. A half-configured
   * integration is the dangerous state — it would queue enrolments nobody
   * is delivering — so it is on only when every field is set.
   */
  FINANCE_API_URL:            z.string().default(""),
  FINANCE_CLIENT_ID:          z.string().default(""),
  FINANCE_INTEGRATION_SECRET: z.string().default(""),
  FINANCE_ORG_ID:             z.string().default(""),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error("❌ Invalid environment variables:", parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;
