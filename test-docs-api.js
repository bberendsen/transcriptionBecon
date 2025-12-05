import 'dotenv/config';
import { getDocsClient, getDriveClient } from './lib/google.js';

async function testCreateDoc() {
  try {
    console.log('Testing Google Docs API...');
    
    const docs = getDocsClient();
    const drive = getDriveClient();
    
    // Get service account email
    const saJson = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
    console.log('Service Account Email:', saJson.client_email);
    
    // Try to create a simple document
    console.log('\n1. Attempting to create a document via Docs API...');
    const doc = await docs.documents.create({ 
      requestBody: { title: 'Test Document - ' + new Date().toISOString() } 
    });
    
    const documentId = doc.data.documentId;
    console.log('✓ Document created successfully!');
    console.log('Document ID:', documentId);
    console.log('Document URL:', `https://docs.google.com/document/d/${documentId}`);
    
    // Try to add some text
    console.log('\n2. Attempting to add text to the document...');
    await docs.documents.batchUpdate({
      documentId,
      requestBody: { 
        requests: [{ 
          insertText: { 
            location: { index: 1 }, 
            text: 'This is a test document created via the API.' 
          } 
        }] 
      },
    });
    console.log('✓ Text added successfully!');
    
    // Try to get document info
    console.log('\n3. Attempting to get document info...');
    const docInfo = await docs.documents.get({
      documentId,
    });
    console.log('✓ Document info retrieved!');
    console.log('Title:', docInfo.data.title);
    
    console.log('\n✅ All tests passed! The service account can create documents.');
    console.log('\nDocument URL:', `https://docs.google.com/document/d/${documentId}`);
    console.log('\nYou can delete this test document if you want.');
    
  } catch (error) {
    console.error('\n❌ Test failed!');
    console.error('Error code:', error.code);
    console.error('Error message:', error.message);
    console.error('Error details:', error.response?.data);
    
    if (error.code === 403) {
      console.error('\n🔍 Permission Error Detected!');
      console.error('This means the service account does not have permission to use Google Docs API.');
      console.error('\nPossible solutions:');
      console.error('1. Check IAM roles in Google Cloud Console');
      console.error('2. Verify Google Docs API is enabled');
      console.error('3. Check if there are organization policies blocking access');
      console.error('4. Try using a different service account that you know works');
    }
    
    process.exit(1);
  }
}

testCreateDoc();

