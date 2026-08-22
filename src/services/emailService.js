import { env } from '../config/env.js';

function buildVerificationEmail({ firstName, verificationUrl }) {
  const greeting = firstName ? `Hi ${firstName},` : 'Hi there,';
  const text = [
    greeting,
    '',
    'Thanks for joining Ocean Cleanup.',
    'Please verify your email address to activate your account:',
    verificationUrl,
    '',
    'If you did not create this account, you can ignore this message.'
  ].join('\n');

  const html = `
    <div style="font-family: Arial, sans-serif; line-height: 1.5; color: #1f2937;">
      <p>${greeting}</p>
      <p>Thanks for joining Ocean Cleanup.</p>
      <p>Please verify your email address to activate your account:</p>
      <p><a href="${verificationUrl}">${verificationUrl}</a></p>
      <p>If you did not create this account, you can ignore this message.</p>
    </div>
  `;

  return { subject: 'Verify your Ocean Cleanup account', text, html };
}

async function sendViaResend({ to, subject, text, html }) {
  if (!env.resendApiKey) {
    throw new Error('RESEND_API_KEY is not configured');
  }

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${env.resendApiKey}`
    },
    body: JSON.stringify({
      from: env.emailFrom,
      to,
      subject,
      text,
      html
    })
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => '');
    throw new Error(`Resend request failed: ${response.status} ${errorText}`.trim());
  }

  return response.json().catch(() => ({}));
}

export async function sendVerificationEmail({ to, firstName, verificationUrl }) {
  const message = buildVerificationEmail({ firstName, verificationUrl });

  if (env.emailProvider === 'resend') {
    return sendViaResend({
      to,
      subject: message.subject,
      text: message.text,
      html: message.html
    });
  }

  console.info('[emailService] Verification email (console mode)', {
    to,
    subject: message.subject,
    verificationUrl
  });

  return { delivered: false, mode: 'console', verificationUrl };
}

export default {
  sendVerificationEmail
};
