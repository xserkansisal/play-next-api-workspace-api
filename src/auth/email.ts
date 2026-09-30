import nodemailer, { type Transporter } from "nodemailer";
import type { Env } from "../config/env.js";

export interface EmailCodeMessage {
  to: string;
  code: string;
  expiresAt: string;
}

export interface EmailCodeSender {
  sendCode(message: EmailCodeMessage): Promise<void>;
}

/** Volatile sink used in tests and local development; never writes or logs the code. */
export class MemoryEmailCodeSender implements EmailCodeSender {
  private readonly messages = new Map<string, EmailCodeMessage>();

  async sendCode(message: EmailCodeMessage): Promise<void> {
    this.messages.set(message.to, { ...message });
  }

  getMessage(email: string): EmailCodeMessage | undefined {
    const message = this.messages.get(email.toLowerCase());
    return message ? { ...message } : undefined;
  }
}

export class SmtpEmailCodeSender implements EmailCodeSender {
  private readonly transporter: Transporter;

  constructor(private readonly env: Pick<Env, "SMTP_HOST" | "SMTP_PORT" | "SMTP_SECURE" | "SMTP_USER" | "SMTP_PASSWORD" | "SMTP_FROM">) {
    if (!env.SMTP_HOST || !env.SMTP_FROM) throw new Error("SMTP host and sender are required");
    this.transporter = nodemailer.createTransport({
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      secure: env.SMTP_SECURE,
      ...(env.SMTP_USER && env.SMTP_PASSWORD ? { auth: { user: env.SMTP_USER, pass: env.SMTP_PASSWORD } } : {}),
    });
  }

  async sendCode(message: EmailCodeMessage): Promise<void> {
    await this.transporter.sendMail({
      from: this.env.SMTP_FROM,
      to: message.to,
      subject: "Your Play Next sign-in code",
      text: `Your sign-in code is ${message.code}. It expires at ${message.expiresAt}. If you did not request this code, you can ignore this message.`,
    });
  }
}
