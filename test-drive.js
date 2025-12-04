import 'dotenv/config';
import { google } from 'googleapis';

// Haal de service account JSON uit de env en parse
const saJsonStr = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
if (!saJsonStr) throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON is niet gezet");

const saJson = JSON.parse(saJsonStr);
// Vervang \\n door echte line breaks
saJson.private_key = saJson.private_key.replace(/\\n/g, '\n');

// Maak Google Auth client
const auth = new google.auth.GoogleAuth({
  credentials: saJson,
  scopes: [
    "https://www.googleapis.com/auth/drive",
    "https://www.googleapis.com/auth/documents",
    "https://www.googleapis.com/auth/drive.file"
  ]
});

// Drive client
const drive = google.drive({ version: 'v3', auth });

// ID van je input folder
const INPUT_FOLDER_ID = process.env.INPUT_FOLDER_ID;

async function listMp3Files() {
  try {
    const res = await drive.files.list({
      q: `'${INPUT_FOLDER_ID}' in parents and mimeType contains 'audio'`,
      fields: 'files(id,name,mimeType)'
    });
    console.log('MP3 files in Drive folder:', res.data.files);
  } catch (err) {
    console.error('Error fetching Drive files:', err);
  }
}

// Run
listMp3Files();
