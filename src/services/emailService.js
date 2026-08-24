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
    <div style="
      margin:0;
      padding:0;
      background-color:#0a1e33;
      font-family:Arial,Helvetica,sans-serif;
    ">
      <div style="max-width:600px; margin:0 auto; padding:60px 20px;">
        <div style="
          background:rgba(15,42,64,0.55);
          border:1px solid rgba(148,197,214,0.18);
          border-radius:20px;
          padding:45px 40px;
          box-shadow:0 8px 30px rgba(0,0,0,0.35);
        ">
          <div style="text-align:center; margin-bottom:30px;">
            <table role="presentation" align="center" style="margin:0 auto;">
              <tr>
                <td style="vertical-align:middle; padding-right:8px;">
                  <span style="
                    display:inline-block;
                    width:26px;
                    height:26px;
                    border:1.5px solid #7dd3c0;
                    border-radius:50%;
                    color:#7dd3c0;
                    font-size:14px;
                    line-height:23px;
                    text-align:center;
                  ">🌐</span>
                </td>
                <td style="vertical-align:middle;">
                  <span style="color:#f1f5f9; font-size:20px; font-weight:700; letter-spacing:0.3px;">
                    BlueMind
                  </span>
                </td>
              </tr>
            </table>
            <p style="margin:8px 0 0; color:#94a3b8; font-size:14px;">
              Making a cleaner ocean, together.
            </p>
          </div>
          <h2 style="margin:0 0 16px; font-size:22px; color:#f8fafc; font-weight:600;">
            ${greeting}
          </h2>
          <p style="font-size:16px; line-height:1.6; margin:0 0 16px; color:#cbd5e1;">
            Thanks for joining <strong style="color:#f1f5f9;">BlueMind</strong>! We're excited to have you as part of our community.
          </p>
          <p style="font-size:16px; line-height:1.6; margin:0 0 24px; color:#cbd5e1;">
            To activate your account and get started, please verify your email address by clicking the button below.
          </p>
          <div style="text-align:center; margin:30px 0;">
            <table role="presentation" align="center" style="margin:0 auto;">
              <tr>
                <td style="background:linear-gradient(90deg, #2dd4bf, #5eead4); border-radius:10px;">
                  <a
                    href="${verificationUrl}"
                    style="display:inline-block; color:#062a29; text-decoration:none; font-size:15px; font-weight:700; letter-spacing:0.3px; padding:14px 34px;"
                  >
                    Verify Account &nbsp;&#8594;
                  </a>
                </td>
              </tr>
            </table>
          </div>
          <div style="border-top:1px solid rgba(148,163,184,0.2); padding-top:20px;">
            <p style="font-size:13px; line-height:1.6; color:#94a3b8; margin:0;">
              If you didn't create a BlueMind account, you can safely ignore this email. No action is required.
            </p>
          </div>
        </div>
      </div>
    </div>
  `;

  return { subject: 'Verify your BlueMind account', text, html };
}

function buildPasswordResetEmail({ firstName, resetUrl }) {
  const greeting = firstName ? `Hi ${firstName},` : 'Hi there,';
  const text = [
    greeting,
    '',
    'We received a request to reset your BlueMind password.',
    'Use the link below to choose a new password:',
    resetUrl,
    '',
    'This link expires in 1 hour and can only be used once.',
    'If you did not request a password reset, you can ignore this message.'
  ].join('\n');

  const html = `
    <div style="
      margin:0;
      padding:0;
      background-color:#0a1e33;
      font-family:Arial,Helvetica,sans-serif;
    ">
      <div style="max-width:600px; margin:0 auto; padding:60px 20px;">
        <div style="
          background:rgba(15,42,64,0.55);
          border:1px solid rgba(148,197,214,0.18);
          border-radius:20px;
          padding:45px 40px;
          box-shadow:0 8px 30px rgba(0,0,0,0.35);
        ">
          <div style="text-align:center; margin-bottom:30px;">
            <table role="presentation" align="center" style="margin:0 auto;">
              <tr>
                <td style="vertical-align:middle; padding-right:8px;">
                  <span style="
                    display:inline-block;
                    width:26px;
                    height:26px;
                    border:1.5px solid #7dd3c0;
                    border-radius:50%;
                    color:#7dd3c0;
                    font-size:14px;
                    line-height:23px;
                    text-align:center;
                  ">🌐</span>
                </td>
                <td style="vertical-align:middle;">
                  <span style="color:#f1f5f9; font-size:20px; font-weight:700; letter-spacing:0.3px;">
                    BlueMind
                  </span>
                </td>
              </tr>
            </table>
            <p style="margin:8px 0 0; color:#94a3b8; font-size:14px;">
              Protecting access, one reset at a time.
            </p>
          </div>
          <h2 style="margin:0 0 16px; font-size:22px; color:#f8fafc; font-weight:600;">
            ${greeting}
          </h2>
          <p style="font-size:16px; line-height:1.6; margin:0 0 16px; color:#cbd5e1;">
            We received a request to reset the password for your <strong style="color:#f1f5f9;">BlueMind</strong> account.
          </p>
          <p style="font-size:16px; line-height:1.6; margin:0 0 24px; color:#cbd5e1;">
            Click the button below to open a secure page where you can choose a new password.
          </p>
          <div style="text-align:center; margin:30px 0;">
            <table role="presentation" align="center" style="margin:0 auto;">
              <tr>
                <td style="background:linear-gradient(90deg, #2dd4bf, #5eead4); border-radius:10px;">
                  <a
                    href="${resetUrl}"
                    style="display:inline-block; color:#062a29; text-decoration:none; font-size:15px; font-weight:700; letter-spacing:0.3px; padding:14px 34px;"
                  >
                    Reset Password &nbsp;&#8594;
                  </a>
                </td>
              </tr>
            </table>
          </div>
          <div style="border-top:1px solid rgba(148,163,184,0.2); padding-top:20px;">
            <p style="font-size:13px; line-height:1.6; color:#94a3b8; margin:0;">
              This link expires in 1 hour and can only be used once. If you did not request this reset, you can safely ignore this email.
            </p>
          </div>
        </div>
      </div>
    </div>
  `;

  return { subject: 'Reset your BlueMind password', text, html };
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

export async function sendPasswordResetEmail({ to, firstName, resetUrl }) {
  const message = buildPasswordResetEmail({ firstName, resetUrl });

  if (env.emailProvider === 'gmail') {
    return sendViaGmail({
      to,
      subject: message.subject,
      text: message.text,
      html: message.html
    });
  }

  console.info('[emailService] Password reset email (console mode) :- ', {
    to,
    subject: message.subject,
    resetUrl
  });

  return { delivered: false, mode: 'console', resetUrl };
}

export default {
  sendVerificationEmail,
  sendPasswordResetEmail
};
