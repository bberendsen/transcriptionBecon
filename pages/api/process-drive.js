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
  try {
    const res = await drive.files.get(
      { fileId, alt: "media" },
      { responseType: "arraybuffer" }
    );
    return Buffer.from(res.data);
  } catch (error) {
    if (error.code === 403 || error.message.includes('permission')) {
      throw new Error(
        `Permission denied downloading file. The service account needs access to the file.\n` +
        `File ID: ${fileId}\n` +
        `Make sure the file is in a folder that's shared with the service account.`
      );
    }
    throw error;
  }
}

async function createDoc(title, content, outputFolderId = null) {
  const docs = getDocsClient();
  const drive = getDriveClient();
  
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
    console.log(`Creating Google Doc with title: "${title}"`);
    
    let documentId;
    
    // Method 1: Try creating document directly in output folder via Drive API (preferred method)
    // This avoids storage quota issues by creating in a folder the service account has access to
    if (outputFolderId) {
      try {
        console.log(`Attempting to create document in output folder via Drive API...`);
        // Create a Google Doc file directly in the output folder using Drive API
        const fileMetadata = {
          name: title,
          mimeType: 'application/vnd.google-apps.document',
          parents: [outputFolderId]
        };
        
        const driveFile = await drive.files.create({
          requestBody: fileMetadata,
          fields: 'id, name, parents'
        });
        
        documentId = driveFile.data.id;
        console.log(`Google Doc created successfully via Drive API in output folder: ${documentId}`);
      } catch (driveError) {
        console.log(`Drive API creation failed:`, driveError.message);
        console.log(`Falling back to Docs API method...`);
        
        // Method 2: Fallback to creating via Docs API (creates in service account's Drive)
        try {
          const doc = await docs.documents.create({ 
            requestBody: { title } 
          });
          documentId = doc.data.documentId;
          console.log(`Google Doc created successfully via Docs API: ${documentId}`);
          
          // Try to move it to output folder
          if (outputFolderId) {
            try {
              console.log(`Moving document to output folder: ${outputFolderId}`);
              await drive.files.update({
                fileId: documentId,
                addParents: outputFolderId,
                fields: "id, parents",
              });
              console.log(`Document moved to output folder successfully`);
            } catch (moveError) {
              console.warn(`Could not move document to output folder:`, moveError.message);
              // Don't fail - document was created, just not in the right place
            }
          }
        } catch (docsError) {
          console.error(`Docs API creation also failed:`, docsError.message);
          // If both fail, throw the Drive API error (more likely to be the real issue)
          throw new Error(
            `Failed to create document. Drive API error: ${driveError.message}. ` +
            `Docs API error: ${docsError.message}. ` +
            `Make sure the output folder is shared with the service account with Editor access.`
          );
        }
      }
    } else {
      // No output folder provided, use Docs API
      console.log(`No output folder provided, creating via Docs API...`);
      const doc = await docs.documents.create({ 
        requestBody: { title } 
      });
      documentId = doc.data.documentId;
      console.log(`Google Doc created successfully via Docs API: ${documentId}`);
    }
    
    // Verify document is in the output folder (if specified)
    if (outputFolderId && documentId) {
      try {
        // Check current parents
        const file = await drive.files.get({
          fileId: documentId,
          fields: "parents",
        });
        
        const currentParents = file.data.parents || [];
        if (!currentParents.includes(outputFolderId)) {
          console.log(`Document not in output folder, attempting to move...`);
          await drive.files.update({
            fileId: documentId,
            addParents: outputFolderId,
            removeParents: currentParents.join(","),
            fields: "id, parents",
          });
          console.log(`Document moved to output folder successfully`);
        } else {
          console.log(`Document is already in output folder`);
        }
      } catch (moveError) {
        console.warn(`Could not verify/move document to output folder:`, moveError.message);
        // Don't fail - document was created, location is secondary
      }
    }
    
    // Insert the transcription text
    console.log(`Inserting transcription text (${content.length} characters)...`);
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
    
    console.log(`Text inserted successfully into document ${documentId}`);
    return documentId;
  } catch (error) {
    console.error("Error creating Google Doc:", error);
    console.error("Error code:", error.code);
    console.error("Error message:", error.message);
    console.error("Error response:", JSON.stringify(error.response?.data, null, 2));
    console.error("Full error object:", JSON.stringify(error, Object.getOwnPropertyNames(error), 2));
    
    if (error.code === 403 || error.message.includes('permission') || error.message.includes('Permission')) {
      // Check if it's a specific API error
      const errorDetails = error.response?.data?.error || {};
      const reason = errorDetails.message || error.message;
      
      throw new Error(
        `Permission denied creating Google Doc.\n\n` +
        `Error details: ${reason}\n\n` +
        `**Troubleshooting steps:**\n\n` +
        `1. **Verify IAM Roles** (most important):\n` +
        `   - Go to: https://console.cloud.google.com/iam-admin/iam?project=sound-velocity-480119-g8\n` +
        `   - Find: ${serviceAccountEmail}\n` +
        `   - Ensure it has "Editor" or "Owner" role\n\n` +
        `2. **Verify API Enablement:**\n` +
        `   - Docs API: https://console.cloud.google.com/apis/library/docs.googleapis.com?project=sound-velocity-480119-g8\n` +
        `   - Drive API: https://console.cloud.google.com/apis/library/drive.googleapis.com?project=sound-velocity-480119-g8\n\n` +
        `3. **Verify Folder Permissions:**\n` +
        `   - Make sure the output folder is shared with ${serviceAccountEmail}\n` +
        `   - Give it "Editor" access (not just Viewer)\n\n` +
        `4. **Check OAuth Consent Screen:**\n` +
        `   - Go to: https://console.cloud.google.com/apis/credentials/consent?project=sound-velocity-480119-g8\n` +
        `   - Make sure OAuth consent screen is configured (even for service accounts)\n\n` +
        `5. **Try creating a test document manually:**\n` +
        `   - Share a folder with ${serviceAccountEmail}\n` +
        `   - Try creating a document in that folder via the API\n\n` +
        `If all else fails, the service account might need domain-wide delegation (for Workspace accounts) or there may be organization policies blocking API access.`
      );
    }
    
    // Handle other common errors
    if (error.code === 404) {
      throw new Error(`Google Docs API endpoint not found. Make sure Google Docs API is enabled.`);
    }
    
    throw error;
  }
}

async function moveFileToOutputFolder(fileId, outputFolderId) {
  const drive = getDriveClient();
  
  try {
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
  } catch (error) {
    if (error.code === 403 || error.message.includes('permission')) {
      throw new Error(
        `Permission denied moving file to output folder. The service account needs Editor access to:\n` +
        `1. The file being moved\n` +
        `2. The output folder (ID: ${outputFolderId})\n\n` +
        `Make sure:\n` +
        `- The output folder is shared with the service account with Editor access\n` +
        `- The file is in a folder shared with the service account with Editor access`
      );
    }
    throw error;
  }
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
        const docId = await createDoc(docTitle, transcriptionText, outputFolderId);

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
        console.error(`Error stack:`, fileError.stack);
        console.error(`Error code:`, fileError.code);
        
        // Try to identify which step failed based on error message
        let stepInfo = "Unknown step";
        if (fileError.message.includes('download') || fileError.message.includes('Download')) {
          stepInfo = "Step 1: Downloading file";
        } else if (fileError.message.includes('transcribe') || fileError.message.includes('OpenAI') || fileError.message.includes('API key')) {
          stepInfo = "Step 2: Transcribing audio";
        } else if (fileError.message.includes('Doc') || fileError.message.includes('document')) {
          stepInfo = "Step 3: Creating Google Doc";
        } else if (fileError.message.includes('move') || fileError.message.includes('output folder')) {
          stepInfo = "Step 4: Moving file to output folder";
        }
        
        results.push({
          fileName: file.name,
          fileId: file.id,
          status: "error",
          error: fileError.message,
          step: stepInfo,
          errorCode: fileError.code,
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
