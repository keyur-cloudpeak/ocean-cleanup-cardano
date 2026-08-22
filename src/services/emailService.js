import nodemailer from 'nodemailer';
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
    <div style="margin:0; padding:0; background-color:#f3f7f5; font-family:Arial,Helvetica,sans-serif; color:#1f2937;"> <div style="max-width:600px; margin:0 auto; padding:40px 20px;">
      <div style="background:#ffffff; border-radius:12px; padding:40px 35px; box-shadow:0 2px 10px rgba(0,0,0,0.06);">
        <div style="text-align:center; margin-bottom:30px;">
          <h1 style="margin:0; color:#0f766e; font-size:28px; font-weight:700;">
            BlueMind
          </h1>
          <p style="margin:8px 0 0; color:#6b7280; font-size:14px;">
            Making a cleaner ocean, together.
          </p>
        </div>
        <h2 style="margin:0 0 16px; font-size:22px; color:#111827;">
          ${greeting}
        </h2>
        <p style="font-size:16px; line-height:1.6; margin:0 0 16px;">
          Thanks for joining <strong>BlueMind</strong>! We're excited to have you as part of our community.
        </p>
        <p style="font-size:16px; line-height:1.6; margin:0 0 24px;">
          To activate your account and get started, please verify your email address by clicking the button below.
        </p>
        <div style="text-align:center; margin:30px 0;">
          <a
            href="${verificationUrl}"
            style="display:inline-block; background:#0f766e; color:#ffffff; text-decoration:none; font-size:16px; font-weight:600; padding:14px 30px; border-radius:8px;"
          >
            Verify Account
          </a>
        </div>
        <div style="border-top:1px solid #e5e7eb; padding-top:20px;">
          <p style="font-size:13px; line-height:1.6; color:#6b7280; margin:0;">
            If you didn't create an BlueMind account, you can safely ignore this email. No action is required.
          </p>
        </div>
      </div>
      </div> </div>
  `;

  return { subject: 'Verify your BlueMind account', text, html };
}

async function sendViaGmail({ to, subject, text, html }) {
  const gmailAppPassword = env.gmailAppPassword.replace(/\s+/g, '');
  if (!env.gmailUser || !gmailAppPassword) {
    throw new Error('GMAIL_USER and GMAIL_APP_PASSWORD are required for Gmail email delivery');
  }

  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: env.gmailUser,
      pass: gmailAppPassword
    }
  });

  return transporter.sendMail({
    from: env.gmailUser,
    to,
    subject,
    text,
    html
  });
}

export async function sendVerificationEmail({ to, firstName, verificationUrl }) {
  const message = buildVerificationEmail({ firstName, verificationUrl });

  if (env.emailProvider === 'gmail') {
    return sendViaGmail({
      to,
      subject: message.subject,
      text: message.text,
      html: message.html
    });
  }

  console.info('[emailService] Verification email (console mode) :- ', {
    to,
    subject: message.subject,
    verificationUrl
  });

  return { delivered: false, mode: 'console', verificationUrl };
}

export default {
  sendVerificationEmail
};
