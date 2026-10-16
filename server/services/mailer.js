// Mail transport abstraction. Replace `send` with a real provider (SMTP / SES / SendGrid)
// in production. In development the message is printed to the server console.
export async function sendMail({ to, subject, text }) {
  console.log(`\n📧 [mail] to=${to}\n   subject: ${subject}\n   ${text.replace(/\n/g, '\n   ')}\n`);
}
