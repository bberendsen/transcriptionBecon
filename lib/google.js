// lib/google.js
import { google } from "googleapis";
import { JWT } from "google-auth-library";

let cachedAuth = null;

export function getAuth() {
  if (cachedAuth) return cachedAuth;

  const saJsonStr = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!saJsonStr) {
    throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON environment variable is not set");
  }

  let saJson;
  try {
    saJson = JSON.parse(saJsonStr);
  } catch (e) {
    throw new Error("Failed to parse GOOGLE_SERVICE_ACCOUNT_JSON: " + e.message);
  }

  // Validate required fields
  if (!saJson.client_email) {
    throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON is missing client_email");
  }
  if (!saJson.private_key) {
    throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON is missing private_key");
  }

  // Fix private key - handle multiple escape scenarios
  // When storing JSON in environment variables, newlines are often escaped as \\n
  let privateKey = saJson.private_key;
  
  // Replace escaped newlines with actual newlines
  // Handle both \\n (single backslash + n) and \\\\n (double backslash + n)
  privateKey = privateKey.replace(/\\n/g, "\n");
  
  // Ensure the key has proper line breaks
  // The key should start with -----BEGIN and end with -----END
  if (!privateKey.includes("BEGIN") || !privateKey.includes("END")) {
    throw new Error("Private key format appears to be incorrect. Ensure it includes BEGIN and END markers.");
  }

  // Use JWT client directly instead of GoogleAuth to avoid OpenSSL issues
  // This approach gives us better control over the authentication process
  try {
    cachedAuth = new JWT({
      email: saJson.client_email,
      key: privateKey,
      scopes: [
        "https://www.googleapis.com/auth/drive",
        "https://www.googleapis.com/auth/documents",
        "https://www.googleapis.com/auth/drive.file"
      ],
    });
  } catch (authError) {
    // Provide more helpful error messages
    if (authError.message.includes("DECODER") || authError.message.includes("unsupported")) {
      throw new Error(
        "OpenSSL error: The private key format may be incorrect. " +
        "Ensure your GOOGLE_SERVICE_ACCOUNT_JSON has properly formatted newlines (\\n). " +
        "Original error: " + authError.message
      );
    }
    throw authError;
  }

  return cachedAuth;
}

export function getDriveClient() {
  const auth = getAuth();
  return google.drive({ version: "v3", auth });
}

export function getDocsClient() {
  const auth = getAuth();
  return google.docs({ version: "v1", auth });
}
