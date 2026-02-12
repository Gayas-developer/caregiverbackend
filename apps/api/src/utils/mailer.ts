import nodemailer from 'nodemailer';

const requireEnv = (key: string) => {
  const value = process.env[key];
  if (!value) {
    throw Object.assign(new Error(`${key} is not configured`), { status: 500 });
  }
  return value;
};

let transporter: nodemailer.Transporter | null = null;

function getTransporter() {
  if (transporter) return transporter;

  const host = requireEnv('EMAIL_HOST');
  const port = Number(requireEnv('EMAIL_PORT'));
  const user = requireEnv('EMAIL_USER');
  const pass = requireEnv('EMAIL_PASS');
  const secure =
    process.env.EMAIL_SECURE != null
      ? process.env.EMAIL_SECURE === 'true'
      : port === 465;

  transporter = nodemailer.createTransport({
    host,
    port,
    secure,
    auth: { user, pass },
  });

  return transporter;
}

export async function sendPasswordResetOtpEmail(params: {
  to: string;
  otp: string;
}) {
  const from = requireEnv('EMAIL_FROM');
  const transport = getTransporter();

  await transport.sendMail({
    from,
    to: params.to,
    subject: 'Your MyHomeCare password reset OTP',
    text: `Your OTP is ${params.otp}. It expires in 10 minutes.`,
    html: `<p>Your OTP is <b>${params.otp}</b>.</p><p>This code expires in 10 minutes.</p>`,
  });
}
