# Transcription Beacon

Automated workflow to transcribe audio files from Google Drive using OpenAI Whisper API and create Google Docs.

## Workflow

1. **Get file from Google Drive folder** - Fetches audio files from the input folder
2. **Convert audio to text** - Uses OpenAI Whisper API for transcription
3. **Create Google Doc** - Creates a new Google Doc with the transcription
4. **Move to output folder** - Moves the processed file to the output folder

## Setup

### Prerequisites

- Node.js 20.x
- Google Cloud Service Account with Drive and Docs API enabled
- OpenAI API key
- Two Google Drive folders (input and output)

### Environment Variables

Set these in your Vercel project settings or `.env.local` file:

```
GOOGLE_SERVICE_ACCOUNT_JSON='{"type":"service_account","project_id":"...","private_key_id":"...","private_key":"-----BEGIN PRIVATE KEY-----\\n...\\n-----END PRIVATE KEY-----\\n","client_email":"...","client_id":"...","auth_uri":"...","token_uri":"...","auth_provider_x509_cert_url":"...","client_x509_cert_url":"..."}'
INPUT_FOLDER_ID=your_input_folder_id
OUTPUT_FOLDER_ID=your_output_folder_id
OPENAI_API_KEY=your_openai_api_key
```

**Important**: When setting `GOOGLE_SERVICE_ACCOUNT_JSON` in Vercel:
- Paste the entire JSON as a single-line string
- Ensure `\\n` sequences in the private_key are preserved (they will be converted to actual newlines)
- The JSON should be wrapped in single quotes if setting via CLI, or entered directly in Vercel's dashboard

### Google Drive Setup

1. Create a Google Cloud Project
2. Enable Google Drive API and Google Docs API
3. Create a Service Account
4. Download the service account JSON key
5. Share your input and output Drive folders with the service account email (found in `client_email`)

## Deployment

### Vercel

1. Push your code to GitHub
2. Import the project in Vercel
3. Add all environment variables in Vercel project settings
4. Deploy

The API endpoint will be available at: `https://your-domain.vercel.app/api/process-drive`

### Local Development

```bash
npm install
npm run dev
```

Then visit `http://localhost:3000/api/process-drive` to trigger the workflow.

## API Usage

### Endpoint

`GET` or `POST` `/api/process-drive`

### Response

```json
{
  "message": "Processing complete",
  "processed": 2,
  "failed": 0,
  "results": [
    {
      "fileName": "audio.mp3",
      "fileId": "drive_file_id",
      "docId": "google_doc_id",
      "docUrl": "https://docs.google.com/document/d/...",
      "status": "success"
    }
  ]
}
```

## Troubleshooting

### OpenSSL Error

If you encounter `error:1E08010C:DECODER routines::unsupported`:

1. Ensure your `GOOGLE_SERVICE_ACCOUNT_JSON` has properly escaped newlines (`\\n`)
2. Verify the private key includes `-----BEGIN PRIVATE KEY-----` and `-----END PRIVATE KEY-----`
3. Check that you're using Node.js 20.x (not 24.x)

### File Not Found

- Ensure the service account email has access to both input and output folders
- Verify the folder IDs are correct

### Transcription Errors

- Check your OpenAI API key is valid
- Ensure you have sufficient OpenAI credits
- Verify the audio file format is supported (mp3, wav, m4a, etc.)

## Project Structure

```
├── pages/
│   ├── api/
│   │   └── process-drive.js  # Main API endpoint
│   └── index.js
├── lib/
│   └── google.js            # Google Auth helpers
├── vercel.json              # Vercel configuration
├── next.config.js           # Next.js configuration
└── package.json
```

