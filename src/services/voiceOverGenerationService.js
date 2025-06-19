const { OpenAI } = require('openai');
require('dotenv').config();

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

  const prompt = `You are a professional scriptwriter. Write a compelling, natural-sounding voiceover script for a video.\n\nVideo Summary: ${summary}\nVisual Description: ${visualDescription}\n\nThe voiceover should match the visuals and be engaging for viewers. The total voiceover should be suitable for a video of about ${duration} seconds.\n\nRespond ONLY with the script, do not include any other text or explanation.`;

  const completion = await openai.chat.completions.create({
    model: "gpt-4",
    messages: [
      { role: "system", content: "You are a helpful assistant for video scriptwriting." },
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
          voice: voice
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
      console.error('❌ Error:', error.response?.data || error.message);
    }
  }

module.exports = {
  generateVoiceOver,
  convertTextToSpeech
};
