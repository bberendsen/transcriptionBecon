// lib/google.js
import { google } from "googleapis";

export function getAuth() {
    const saJsonStr = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
    if (!saJsonStr) throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON is niet gezet");
  
    // vervang \\n met echte newlines
    const saJson = JSON.parse(saJsonStr.replace(/\\n/g, "\n"));
  
    return new google.auth.GoogleAuth({
      credentials: saJson,
      scopes: [
        "https://www.googleapis.com/auth/drive",
        "https://www.googleapis.com/auth/documents",
        "https://www.googleapis.com/auth/drive.file"
      ],
    });
  }
  

export function getDriveClient() {
  return google.drive({ version: "v3", auth: getAuth() });
}

export function getDocsClient() {
  return google.docs({ version: "v1", auth: getAuth() });
}
