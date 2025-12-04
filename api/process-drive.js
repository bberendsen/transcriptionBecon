// pages/api/process-drive.js
import fs from "fs";
import path from "path";
import stream from "stream";
import { promisify } from "util";
import axios from "axios";
import { getDriveClient, getDocsClient } from "../../lib/google";
import OpenAI from "openai";

const pipeline = promisify(stream.pipeline);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const INPUT_FOLDER = process.env.INPUT_FOLDER_ID;
const OUTPUT_FOLDER = process.env.OUTPUT_FOLDER_ID;
const PROCESS_LABEL_KEY = process.env.PROCESS_LABEL_KEY || "processed_by_automation";

/** Helper: list unprocessed mp3 files in folder */
async function listUnprocessedMp3s(drive) {
    // 1. Query alle audio-bestanden (niet alleen exact audio/mpeg)
    const res = await drive.files.list({
        q: `'${INPUT_FOLDER}' in parents`,
        fields: "files(id,name,mimeType,appProperties)"
      });
      console.log("Drive files:", res.data.files);
      
  
    // 3. Filter bestanden die nog niet verwerkt zijn
    const files = res.data.files || [];
    return files.filter(f => !(f.appProperties && f.appProperties[PROCESS_LABEL_KEY] === "true"));
  }
  

/** Helper: download file to buffer */
async function downloadFileToBuffer(drive, fileId) {
  const res = await drive.files.get({ fileId, alt: "media" }, { responseType: "arraybuffer" });
  return Buffer.from(res.data);
}

/** Helper: mark file as processed using appProperties */
async function markFileProcessed(drive, fileId) {
  await drive.files.update({
    fileId,
    requestBody: {
      appProperties: {
        [PROCESS_LABEL_KEY]: "true",
      }
    }
  });
}

/** Helper: upload doc file to drive (we create doc via Docs API then move to folder) */
async function moveFileToFolder(drive, fileId, folderId) {
  // Get existing parents, then add the output folder
  const file = await drive.files.get({ fileId, fields: "parents" });
  const previousParents = file.data.parents ? file.data.parents.join(",") : "";
  await drive.files.update({
    fileId,
    addParents: folderId,
    removeParents: previousParents,
    fields: "id, parents"
  });
}

export default async function handler(req, res) {
  // optional secret check for cron
  /*if (process.env.VERCEL_CRON_SECRET) {
    const secret = req.headers["x-cron-secret"] || req.query.secret;
    if (secret !== process.env.VERCEL_CRON_SECRET) {
      return res.status(403).json({ error: "Forbidden" });
    }
  }*/

  try {
    const drive = getDriveClient();
    const docs = getDocsClient();

    const files = await listUnprocessedMp3s(drive);
    if (!files.length) return res.status(200).json({ message: "No new files" });

    const results = [];
    for (const file of files) {
      const start = Date.now();
      const buffer = await downloadFileToBuffer(drive, file.id);

      // Send to Whisper (OpenAI) - transcription
      // Using createTranscription via OpenAI's "audio" endpoint; we send as multipart/form-data
      const form = new FormData();
      form.append("file", buffer, { filename: file.name, contentType: "audio/mpeg" });
      form.append("model", "whisper-1");

      // openai library doesn't currently support multipart in all versions; we'll use axios to call REST
      const tResp = await axios.post("https://api.openai.com/v1/audio/transcriptions", form, {
        headers: {
          ...form.getHeaders(),
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        },
        maxContentLength: Infinity,
        maxBodyLength: Infinity,
      });

      const transcriptText = tResp.data.text;

      // Summarize with Chat Completion (GPT)
      const prompt = `Vat deze transcript samen in korte bullets (max 8 bullets). Gebruik heldere, zakelijke taal.\n\nTranscript:\n${transcriptText}`;
      const chatResp = await openai.chat.completions.create
        ? await openai.chat.completions.create({
            model: "gpt-4o-mini", // kies een kostenefficient model of "gpt-4.1" als je wilt
            messages: [{ role: "user", content: prompt }],
            max_tokens: 400,
          })
        : await openai.responses.create({
            model: "gpt-4o-mini",
            input: prompt,
            max_tokens: 400
          });

      // different clients return differently — normalize:
      const summary = chatResp?.choices?.[0]?.message?.content || chatResp?.output?.[0]?.content || chatResp?.choices?.[0]?.text || "";

      // Create Google Doc
      const docCreate = await docs.documents.create({
        requestBody: { title: `Transcript - ${file.name}` }
      });
      const documentId = docCreate.data.documentId;

      // Insert text
      const insertText = `Bestand: ${file.name}\n\nSamenvatting:\n${summary}\n\nTranscript:\n${transcriptText}`;
      await docs.documents.batchUpdate({
        documentId,
        requestBody: {
          requests: [
            { insertText: { location: { index: 1 }, text: insertText } }
          ]
        }
      });

      // Move doc to output folder
      await moveFileToFolder(drive, documentId, OUTPUT_FOLDER);

      // Mark original mp3 as processed
      await markFileProcessed(drive, file.id);

      results.push({ file: file.name, documentId, durationMs: Date.now() - start });
    }

    res.status(200).json({ processed: results });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message, stack: err.stack });
  }
}
