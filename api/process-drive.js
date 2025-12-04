import { google } from "googleapis";
import OpenAI from "openai";

// ======= GOOGLE DRIVE / DOCS SETUP =======

const saJsonStr = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
if (!saJsonStr) throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON is niet gezet");

const saJson = JSON.parse(saJsonStr);

const auth = new google.auth.GoogleAuth({
  credentials: saJson,
  scopes: [
    "https://www.googleapis.com/auth/drive",
    "https://www.googleapis.com/auth/documents",
  ],
});

const drive = google.drive({ version: "v3", auth });
const docs = google.docs({ version: "v1", auth });

// ======= OPENAI SETUP =======

if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is niet gezet");

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// ======= HELPERS =======

async function listAudioFiles(folderId) {
  const res = await drive.files.list({
    q: `'${folderId}' in parents and mimeType contains 'audio'`,
    fields: "files(id,name)",
  });
  return res.data.files || [];
}

async function downloadFile(fileId) {
  const res = await drive.files.get(
    { fileId, alt: "media" },
    { responseType: "arraybuffer" }
  );
  return Buffer.from(res.data);
}

async function createDoc(title, content) {
  const doc = await docs.documents.create({
    requestBody: { title },
  });

  await docs.documents.batchUpdate({
    documentId: doc.data.documentId,
    requestBody: {
      requests: [
        { insertText: { location: { index: 1 }, text: content } },
      ],
    },
  });

  return doc.data.documentId;
}

async function summarizeText(text) {
  const completion = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      { role: "system", content: "Je bent een assistent die audio samenvat." },
      { role: "user", content: text },
    ],
  });

  return completion.choices[0].message.content;
}

// ======= VERCEL FUNCTION =======

export default async function handler(req, res) {
  try {
    const folderId = process.env.INPUT_FOLDER_ID;
    if (!folderId) throw new Error("INPUT_FOLDER_ID is niet gezet");

    const files = await listAudioFiles(folderId);
    if (!files.length) return res.status(200).json({ message: "No new files" });

    const results = [];

    for (const file of files) {
      const audioBuffer = await downloadFile(file.id);

      // Whisper transcription via OpenAI
      const transcription = await openai.audio.transcriptions.create({
        file: audioBuffer,
        model: "whisper-1",
      });

      const summary = await summarizeText(transcription.text);

      const docId = await createDoc(`${file.name} transcript`, summary);

      results.push({ file: file.name, docId });
    }

    res.status(200).json({ message: "Done", results });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
}
