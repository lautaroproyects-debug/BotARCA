import axios from 'axios';
import dotenv from 'dotenv';
dotenv.config();

const apiKey = process.env.RESEND_API_KEY || '';

async function testResend() {
  console.log('Testing Resend API Key from environment...');
  if (!apiKey) {
    console.error('RESEND_API_KEY is not set in environment.');
    return;
  }
  try {
    const res = await axios.get('https://api.resend.com/api-keys', {
      headers: {
        'Authorization': `Bearer ${apiKey}`
      }
    });
    console.log('Resend API Key status: VALID (HTTP ' + res.status + ')');
    console.log('Key info:', JSON.stringify(res.data, null, 2));
  } catch (err) {
    console.log('API Keys endpoint response:', err.response?.status, err.response?.data || err.message);
  }
}

testResend();
