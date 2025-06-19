const { OpenAI } = require('openai');
require('dotenv').config();
const axios = require('axios');
const fs = require('fs');
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

/**
 * Generates a voiceover script for a video using OpenAI
 * @param {string} summary - The summary of the video
 * @param {string} visualDescription - The visual description or shot/frame description
 * @param {number} duration - The desired duration of the voiceover in seconds
 * @returns {Promise<string>} - The generated voiceover script
 */
async function generateVoiceOver(summary, shots, duration) {
    
    const visualDescription=shots.map(shot => shot.description).join('\n');

  const prompt = `You are a professional text generator for voiceovers on videos. Write a compelling, natural-sounding voiceover script for a video.\n\nVideo Summary: ${summary}\nVisual Description: ${visualDescription}.Focus mainly on the summary and donot include scene descriptions.\n\nThe voiceover should match the visuals and be engaging for viewers. The total voiceover should be suitable for a video of about ${duration} seconds.\n\nRespond ONLY with the script, do not include any other text or explanation.`;

  const completion = await openai.chat.completions.create({
    model: "gpt-4",
    messages: [
      { role: "system", content: "You are a helpful assistant for video voiceover generation." },
      { role: "user", content: prompt }
    ],
    max_tokens: 400,
    temperature: 0.7
  });
  console.log('Voice Over:',completion.choices[0].message.content.trim());
  return completion.choices[0].message.content.trim();
}

async function convertTextToSpeech(text, voice) {
    try {
      const response = await axios.post(
        'https://api.openai.com/v1/audio/speech',
        {
          model: "tts-1", // or "tts-1-hd"
          input: text,
          voice: "alloy"
        },
        {
          headers: {
            'Authorization': `Bearer ${OPENAI_API_KEY}`,
            'Content-Type': 'application/json'
          },
          responseType: 'arraybuffer' // Needed to receive audio data
        }
      );
  
      fs.writeFileSync('output.mp3', response.data);
      console.log('✅ Audio saved as output.mp3');
    } catch (error) {
      if (error.response?.data) {
        const errorText = Buffer.from(error.response.data).toString('utf-8');
        try {
          const errorJson = JSON.parse(errorText);
          console.error('❌ Error:', errorJson);
        } catch (parseErr) {
          console.error('❌ Error (non-JSON):', errorText);
        }
      } else {
        console.error('❌ Error:', error.message);
      }
    }
  }

module.exports = {
  generateVoiceOver,
  convertTextToSpeech
};
