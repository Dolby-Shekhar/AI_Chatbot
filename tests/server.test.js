const fs = require('fs');
const path = require('path');

process.env.DATA_DIR = path.join(__dirname, 'tmp-test-data');

const request = require('supertest');
const { app } = require('../server');

const testDataDir = process.env.DATA_DIR;

beforeAll(() => {
  if (fs.existsSync(testDataDir)) {
    fs.rmSync(testDataDir, { recursive: true, force: true });
  }
  fs.mkdirSync(testDataDir, { recursive: true });
});

afterAll(() => {
  if (fs.existsSync(testDataDir)) {
    fs.rmSync(testDataDir, { recursive: true, force: true });
  }
});

describe('API endpoints', () => {
  const header = { 'X-User-Id': 'test-user' };

  it('should return health status', async () => {
    const res = await request(app).get('/api/health');
    expect(res.statusCode).toBe(200);
    expect(res.body).toHaveProperty('status', 'ok');
  });

  it('should create and list sessions', async () => {
    const res1 = await request(app)
      .post('/api/sessions/new')
      .set(header)
      .send();

    expect(res1.statusCode).toBe(200);
    expect(res1.body).toHaveProperty('sessionId');
    expect(res1.body).toHaveProperty('active', res1.body.sessionId);

    const res2 = await request(app)
      .get('/api/sessions')
      .set(header);

    expect(res2.statusCode).toBe(200);
    expect(res2.body).toHaveProperty('sessions');
    expect(res2.body.sessions).toContain(res1.body.sessionId);
    expect(res2.body).toHaveProperty('active', res1.body.sessionId);
  });

  it('should activate an existing session', async () => {
    const create = await request(app)
      .post('/api/sessions/new')
      .set(header)
      .send();

    const res = await request(app)
      .post(`/api/sessions/${create.body.sessionId}/activate`)
      .set(header)
      .send();

    expect(res.statusCode).toBe(200);
    expect(res.body).toHaveProperty('success', true);
    expect(res.body).toHaveProperty('active', create.body.sessionId);
  });

  it('should create a chat message via REST endpoint', async () => {
    const res = await request(app)
      .post('/api/chat')
      .set(header)
      .send({ msg: 'Hello chatbot' });

    expect(res.statusCode).toBe(200);
    expect(res.body).toHaveProperty('message');
    expect(res.body).toHaveProperty('sessionId');
  });
});
