/** Transactional email through Brevo (same provider as verification / reset emails). */
export async function sendEmail(opts: { to: string; toName?: string | null; subject: string; text: string; html?: string }) {
  const apiKey = process.env.BREVO_API_KEY;
  if (!apiKey) {
    if (process.env.NODE_ENV !== "production") {
      console.log(`[email:dev] to=${opts.to} subject="${opts.subject}"`);
      return { delivered: false };
    }
    throw Object.assign(new Error("Email is not configured on the API"), { status: 503 });
  }
  const senderEmail = process.env.BREVO_SENDER_EMAIL || "noreply@academicall.site";
  const response = await fetch("https://api.brevo.com/v3/smtp/email", {
    method: "POST",
    headers: { accept: "application/json", "api-key": apiKey, "content-type": "application/json" },
    body: JSON.stringify({
      sender: { name: "Academicall", email: senderEmail },
      replyTo: { email: process.env.BREVO_REPLY_TO_EMAIL || senderEmail },
      to: [{ email: opts.to, name: opts.toName || opts.to }],
      subject: opts.subject,
      textContent: opts.text,
      ...(opts.html ? { htmlContent: opts.html } : {}),
    }),
  });
  if (!response.ok) throw Object.assign(new Error("Email provider error"), { status: 502 });
  return { delivered: true };
}
