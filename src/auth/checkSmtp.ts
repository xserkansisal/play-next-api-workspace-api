import { loadEnv } from "../config/env.js";
import { verifySmtpConnection } from "./email.js";

// Checks the SMTP settings without involving a user: it opens the connection and authenticates,
// but sends nothing. Without this, the only way to find out whether the settings are right is to
// ask for a real sign-in code and wait for a mail that may never arrive, with the reason discarded
// by the route that asked for it.
//
// A pass here is not a promise that mail arrives. It proves the host is reachable and the
// credentials are accepted; relaying, sender policy (SPF/DMARC) and recipient filtering are all
// decided later, and only a real send exercises those.
const env = loadEnv();

if (!env.SMTP_HOST || !env.SMTP_FROM) {
  console.error(
    "SMTP is not configured: SMTP_HOST and SMTP_FROM are both required.\n" +
      "Without them the API uses the in-memory sender, which delivers nothing.",
  );
  process.exit(1);
}

const result = await verifySmtpConnection(env);

if (result.ok) {
  console.log(`SMTP connection to ${env.SMTP_HOST}:${env.SMTP_PORT} verified. Sender: ${env.SMTP_FROM}`);
  if (!env.SMTP_USER) {
    console.log("No SMTP_USER is set, so this connected without authenticating.");
  }
  console.log("This does not prove mail is delivered - relaying, SPF/DMARC and recipient filters are checked later.");
} else {
  console.error(`SMTP connection to ${env.SMTP_HOST}:${env.SMTP_PORT} failed: ${result.error}`);
  console.error(
    "Common causes: SMTP_SECURE set for a STARTTLS port (587) or unset for an implicit-TLS port (465),\n" +
      "a host reachable only from inside the network, or credentials the server rejects.",
  );
  process.exit(1);
}
