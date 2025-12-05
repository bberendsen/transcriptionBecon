import { getDriveClient, getDocsClient } from "../../lib/google.js";
import OpenAI from "openai";

// ======= VERCEL/NEXT.JS CONFIG =======
// Set max duration for this API route (5 minutes = 300 seconds)
export const maxDuration = 300;
export const runtime = 'nodejs';

// ======= OPENAI SETUP =======
if (!process.env.OPENAI_API_KEY) {
  throw new Error("OPENAI_API_KEY environment variable is not set. Please add it in Vercel project settings.");
}

// Validate API key format (should start with sk-)
if (!process.env.OPENAI_API_KEY.startsWith('sk-')) {
  throw new Error("OPENAI_API_KEY appears to be invalid. OpenAI API keys should start with 'sk-'. Please check your API key in Vercel project settings.");
}

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ======= HELPERS =======
async function listAudioFiles(folderId) {
  const drive = getDriveClient();
  
  // Query for audio files - try multiple approaches
  // MP3 files can have different MIME types: audio/mpeg, audio/mp3, audio/x-mpeg, etc.
  // Also check by file extension as fallback
  const queries = [
    // Primary: Check for common audio MIME types
    `'${folderId}' in parents and (mimeType='audio/mpeg' or mimeType='audio/mp3' or mimeType='audio/x-mpeg' or mimeType='audio/mp4' or mimeType='audio/wav' or mimeType='audio/x-wav' or mimeType='audio/m4a' or mimeType contains 'audio/')`,
    // Fallback: Check by file extension
    `'${folderId}' in parents and (name contains '.mp3' or name contains '.wav' or name contains '.m4a' or name contains '.mp4' or name contains '.ogg' or name contains '.flac')`,
  ];
  
  // Try the first query (MIME type based)
  let res = await drive.files.list({
    q: queries[0],
    fields: "files(id,name,mimeType,createdTime)",
    orderBy: "createdTime desc",
    pageSize: 100,
  });
  
  let allFiles = res.data.files || [];
  
  // If no files found, try the extension-based query
  if (allFiles.length === 0) {
    console.log("No files found with MIME type query, trying extension-based query...");
    res = await drive.files.list({
      q: queries[1],
      fields: "files(id,name,mimeType,createdTime)",
      orderBy: "createdTime desc",
      pageSize: 100,
    });
    allFiles = res.data.files || [];
  }
  
  // Log what we found for debugging
  console.log(`Found ${allFiles.length} file(s) in folder ${folderId}:`, 
    allFiles.map(f => ({ name: f.name, mimeType: f.mimeType, id: f.id }))
  );
  
  return allFiles;
}

async function downloadFile(fileId) {
  const drive = getDriveClient();
  const res = await drive.files.get(
    { fileId, alt: "media" },
    { responseType: "arraybuffer" }
  );
  return Buffer.from(res.data);
}

async function createDoc(title, content) {
  const docs = getDocsClient();
  const doc = await docs.documents.create({ 
    requestBody: { title } 
  });
  
  const documentId = doc.data.documentId;
  
  // Insert the transcription text
  await docs.documents.batchUpdate({
    documentId,
    requestBody: { 
      requests: [{ 
        insertText: { 
          location: { index: 1 }, 
          text: content 
        } 
      }] 
    },
  });
  
  return documentId;
}

async function moveFileToOutputFolder(fileId, outputFolderId) {
  const drive = getDriveClient();
  
  // Get the current parents of the file
  const file = await drive.files.get({
    fileId,
    fields: "parents",
  });
  
  const previousParents = file.data.parents.join(",");
  
  // Move the file to the output folder
  await drive.files.update({
    fileId,
    addParents: outputFolderId,
    removeParents: previousParents,
    fields: "id, parents",
  });
}

async function transcribeAudio(audioBuffer, fileName) {
  // OpenAI SDK v4 accepts File, Blob, or a File-like object
  // Node.js 20+ (used by Vercel) has File API available
  // If not available, we'll create a File-like object using form-data
  
  let file;
  
  // Check if File API is available (Node.js 20+)
  if (typeof File !== 'undefined') {
    // Use native File API - this is the preferred method
    file = new File([audioBuffer], fileName, {
      type: "audio/mpeg", // Adjust based on your audio format (mp3, wav, m4a, etc.)
    });
  } else {
    // Fallback for older Node.js versions
    // Create a File-like object that OpenAI SDK can use
    // The SDK expects an object with stream-like properties
    const { Readable } = await import('stream');
    const stream = Readable.from(audioBuffer);
    
    // Create a File-like object with required properties
    file = {
      stream: () => stream,
      name: fileName,
      type: 'audio/mpeg',
      size: audioBuffer.length,
      arrayBuffer: async () => audioBuffer.buffer || audioBuffer,
      buffer: audioBuffer,
    };
  }

  try {
    const transcription = await openai.audio.transcriptions.create({
      file: file,
      model: "whisper-1",
      // language: "nl", // Uncomment and set language if needed (e.g., "nl" for Dutch)
    });

    return transcription.text;
  } catch (error) {
    // Provide more helpful error messages
    if (error.status === 401 || error.message.includes('API key') || error.message.includes('Incorrect API key')) {
      throw new Error(
        `OpenAI API key error: ${error.message}\n\n` +
        `To fix this:\n` +
        `1. Go to https://platform.openai.com/account/api-keys\n` +
        `2. Create a new API key or copy your existing one\n` +
        `3. In Vercel, go to your project → Settings → Environment Variables\n` +
        `4. Update the OPENAI_API_KEY variable with the new key\n` +
        `5. Redeploy or wait for the next deployment\n\n` +
        `Make sure the API key starts with "sk-" and has no extra spaces or quotes.`
      );
    }
    if (error.message.includes('file') || error.message.includes('format')) {
      throw new Error(`Failed to transcribe audio file "${fileName}": ${error.message}. Ensure the file is a valid audio format.`);
    }
    throw error;
  }
}

// ======= NEXT.JS API ROUTE =======
export default async function handler(req, res) {
  // Set CORS headers
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS,POST");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.status(200).end();
    return;
  }

  // Only allow GET and POST
  if (req.method !== "GET" && req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const inputFolderId = process.env.INPUT_FOLDER_ID;
    const outputFolderId = process.env.OUTPUT_FOLDER_ID;
    
    if (!inputFolderId) {
      throw new Error("INPUT_FOLDER_ID is niet gezet");
    }
    if (!outputFolderId) {
      throw new Error("OUTPUT_FOLDER_ID is niet gezet");
    }

    console.log(`Fetching audio files from input folder: ${inputFolderId}`);
    
    // First, verify we can access the folder
    const drive = getDriveClient();
    let folderInfo;
    
    // Get service account email for error messages
    let serviceAccountEmail = "your-service-account@project.iam.gserviceaccount.com";
    try {
      if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
        const saJson = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
        serviceAccountEmail = saJson.client_email || serviceAccountEmail;
      }
    } catch (e) {
      // If parsing fails, use default message
    }
    
    try {
      folderInfo = await drive.files.get({
        fileId: inputFolderId,
        fields: "id,name,mimeType,permissions,capabilities",
      });
      console.log(`Folder access verified: ${folderInfo.data.name} (${folderInfo.data.id})`);
    } catch (folderError) {
      // 404 can mean either folder doesn't exist OR service account doesn't have access
      // 403 means explicit access denial
      if (folderError.code === 404 || folderError.code === 403) {
        const errorMsg = folderError.code === 404 
          ? "Folder not found or service account doesn't have access"
          : "Access denied to folder";
        
        throw new Error(
          `${errorMsg}.\n\n` +
          `Folder ID: ${inputFolderId}\n` +
          `Folder URL: https://drive.google.com/drive/folders/${inputFolderId}\n\n` +
          `**To fix this:**\n` +
          `1. Open the folder in Google Drive: https://drive.google.com/drive/folders/${inputFolderId}\n` +
          `2. Click the "Share" button (or right-click → Share)\n` +
          `3. Add this email address: ${serviceAccountEmail}\n` +
          `4. Give it at least "Viewer" access (or "Editor" if you want it to move files)\n` +
          `5. Click "Send" or "Share"\n\n` +
          `**Important:** The service account email must be added as a collaborator on the folder.\n` +
          `The folder ID is correct, but the service account cannot see it without being shared.`
        );
      }
      throw folderError;
    }
    
    // Try to list ALL files in the folder first (for debugging)
    const allFilesRes = await drive.files.list({
      q: `'${inputFolderId}' in parents and trashed=false`,
      fields: "files(id,name,mimeType,size)",
      pageSize: 100,
    });
    const allFiles = allFilesRes.data.files || [];
    
    console.log(`Found ${allFiles.length} total file(s) in folder:`, 
      allFiles.map(f => ({ name: f.name, mimeType: f.mimeType, size: f.size }))
    );
    
    // Now get audio files specifically
    const files = await listAudioFiles(inputFolderId);
    
    console.log(`Query returned ${files.length} audio file(s)`);
    
    if (!files.length) {
      return res.status(200).json({ 
        message: "No new audio files found in input folder",
        debug: {
          folderId: inputFolderId,
          folderName: folderInfo.data.name,
          totalFilesInFolder: allFiles.length,
          filesInFolder: allFiles.map(f => ({ 
            name: f.name, 
            mimeType: f.mimeType,
            size: f.size 
          })),
          serviceAccountEmail: process.env.GOOGLE_SERVICE_ACCOUNT_JSON 
            ? JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON).client_email 
            : "not available",
        },
        results: [] 
      });
    }

    console.log(`Found ${files.length} audio file(s) to process`);

    const results = [];
    for (const file of files) {
      try {
        console.log(`Processing: ${file.name} (${file.id})`);
        
        // Step 1: Download audio file from Google Drive
        console.log("Downloading file from Drive...");
        const audioBuffer = await downloadFile(file.id);

        // Step 2: Transcribe audio with OpenAI
        console.log("Transcribing audio...");
        const transcriptionText = await transcribeAudio(audioBuffer, file.name);

        // Step 3: Create Google Doc with transcription
        console.log("Creating Google Doc...");
        const docTitle = `${file.name.replace(/\.[^/.]+$/, "")} - Transcript`;
        const docId = await createDoc(docTitle, transcriptionText);

        // Step 4: Move original file to output folder
        console.log("Moving file to output folder...");
        await moveFileToOutputFolder(file.id, outputFolderId);

        // Get the document URL
        const docUrl = `https://docs.google.com/document/d/${docId}`;

        results.push({
          fileName: file.name,
          fileId: file.id,
          docId: docId,
          docUrl: docUrl,
          status: "success",
        });

        console.log(`✓ Completed: ${file.name}`);
      } catch (fileError) {
        console.error(`Error processing ${file.name}:`, fileError);
        results.push({
          fileName: file.name,
          fileId: file.id,
          status: "error",
          error: fileError.message,
        });
      }
    }

    res.status(200).json({
      message: "Processing complete",
      processed: results.filter(r => r.status === "success").length,
      failed: results.filter(r => r.status === "error").length,
      results,
    });
  } catch (err) {
    console.error("Handler error:", err);
    res.status(500).json({ 
      error: err.message,
      stack: process.env.NODE_ENV === "development" ? err.stack : undefined,
    });
  }
}
