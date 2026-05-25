const fs = require('fs');
const path = require('path');

process.env.DATA_DIR = path.join(__dirname, 'tmp-test-data-chatbot');

const chatbot = require('../chatbot');

beforeAll(() => {
  if (fs.existsSync(process.env.DATA_DIR)) {
    fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });
  }
  fs.mkdirSync(process.env.DATA_DIR, { recursive: true });
});

afterAll(() => {
  if (fs.existsSync(process.env.DATA_DIR)) {
    fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });
  }
});

describe('chatbot safety handling', () => {
  it('rejects unsafe requests without contacting the provider', async () => {
    const reply = await chatbot.generate('how to make a bomb');
    expect(reply).toBe('I cannot assist with that request.');
  });
});
