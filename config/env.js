import { config } from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load .env file from server directory (preferred)
config({ path: path.join(__dirname, "../.env") });

// Fallback to .env.development for backward compatibility
if (!process.env.DB_URI) {
  config({ path: path.join(__dirname, "../.env.development") });
}

// Use MONGODB_URI if DB_URI is not set (for backward compatibility)
const DB_URI_FINAL = process.env.DB_URI

export const {
  JWT_SECRET,
  JWT_EXPIRE,
  SMTP_HOST,
  SMTP_PORT,
  SMTP_USER,
  SMTP_PASS,
  SMTP_FROM,
  NODE_ENV,
} = process.env;

/**
 * HTTP listen port. Prefer SERVER_PORT in .env so a machine-wide `PORT` (common on Windows)
 * does not shadow your API port. Falls back to `PORT` for PaaS (e.g. Render/Heroku).
 */
export const PORT = process.env.SERVER_PORT || process.env.PORT || "5001";

export const DB_URI = DB_URI_FINAL;