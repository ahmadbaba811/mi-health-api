const test = require('node:test');
const assert = require('node:assert/strict');
const { sendMail, isEmailConfigured } = require('../src/utils/email');

test('reports that email is not configured when SMTP settings are missing', () => {
  delete process.env.EMAIL_HOST;
  delete process.env.EMAIL_PORT;
  delete process.env.EMAIL_USER;
  delete process.env.EMAIL_PASS;
  delete process.env.EMAIL_FROM;

  assert.equal(isEmailConfigured(), false);
});

test('rejects sending mail when SMTP settings are missing', async () => {
  await assert.rejects(
    () => sendMail({ to: 'test@example.com', subject: 'Test', text: 'Hello' }),
    /not configured/i
  );
});
