import nodemailer from 'nodemailer';
import type { Config } from './config.js';

export interface Mailer {
  sendOtp(email: string, code: string, ttlMinutes: number): Promise<void>;
}

/** Development fallback: prints the code to the server console. Never used in production (config enforces SMTP). */
export class ConsoleMailer implements Mailer {
  async sendOtp(email: string, code: string, ttlMinutes: number): Promise<void> {
    console.log(`\n[dev mailer] OTP for ${email}: ${code} (valid ${ttlMinutes} min)\n`);
  }
}

/** Test double: remembers what was "sent". */
export class MemoryMailer implements Mailer {
  sent: Array<{ email: string; code: string }> = [];
  async sendOtp(email: string, code: string): Promise<void> {
    this.sent.push({ email, code });
  }
  lastCodeFor(email: string): string | undefined {
    return [...this.sent].reverse().find((m) => m.email === email)?.code;
  }
}

export class SmtpMailer implements Mailer {
  private transport;
  constructor(private cfg: Config) {
    this.transport = nodemailer.createTransport({
      host: cfg.SMTP_HOST,
      port: cfg.SMTP_PORT,
      secure: cfg.SMTP_PORT === 465,
      auth: cfg.SMTP_USER ? { user: cfg.SMTP_USER, pass: cfg.SMTP_PASS } : undefined,
    });
  }
  async sendOtp(email: string, code: string, ttlMinutes: number): Promise<void> {
    await this.transport.sendMail({
      from: this.cfg.MAIL_FROM,
      to: email,
      subject: `Your Home360 login code: ${code}`,
      text: `Your Home360 login code is ${code}.\nIt expires in ${ttlMinutes} minutes. If you did not request it, you can ignore this email.`,
    });
  }
}

/** Development helper: prints the code AND sends the email. */
class TeeMailer implements Mailer {
  constructor(private mailers: Mailer[]) {}
  async sendOtp(email: string, code: string, ttlMinutes: number): Promise<void> {
    for (const m of this.mailers) await m.sendOtp(email, code, ttlMinutes);
  }
}

export function createMailer(cfg: Config): Mailer {
  if (!cfg.SMTP_HOST) return new ConsoleMailer();
  const smtp = new SmtpMailer(cfg);
  return cfg.DEV_LOG_OTP === 'true' ? new TeeMailer([new ConsoleMailer(), smtp]) : smtp;
}
