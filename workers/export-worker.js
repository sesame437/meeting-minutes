require("dotenv").config();
const PDFDocument = require("pdfkit");
const { receiveMessages, deleteMessage } = require("../services/sqs");
const { getFile, uploadFile } = require("../services/s3");
const { ses } = require("../services/ses");
const { docClient } = require("../db/dynamodb");
const { UpdateCommand } = require("@aws-sdk/lib-dynamodb");
const { SendRawEmailCommand } = require("@aws-sdk/client-ses");

const QUEUE_URL = process.env.SQS_EXPORT_QUEUE;
const TABLE = process.env.DYNAMODB_TABLE;
const POLL_INTERVAL = 5000;

/* ─── helpers ─────────────────────────────────────────── */

async function streamToString(stream) {
  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString("utf-8");
}

function fmtDate(iso) {
  if (!iso) return "-";
  const d = new Date(iso);
  return isNaN(d) ? iso : d.toLocaleDateString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit" });
}

function nowISO() {
  return new Date().toISOString();
}

function nowCN() {
  return new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" });
}

/* ─── PDF generation (pdfkit) ─────────────────────────── */

function generatePdf(report) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 50, bufferPages: true });
    const buffers = [];
    doc.on("data", (b) => buffers.push(b));
    doc.on("end", () => resolve(Buffer.concat(buffers)));
    doc.on("error", reject);

    const FONT = "fonts/NotoSansSC-Regular.ttf";
    let hasCustomFont = false;
    try {
      require("fs").accessSync(require("path").resolve(__dirname, "..", FONT));
      doc.registerFont("CN", require("path").resolve(__dirname, "..", FONT));
      hasCustomFont = true;
    } catch {
      // fallback: Helvetica (CJK may render as boxes; log warning)
      console.warn("CJK font not found at", FONT, "– PDF will use Helvetica fallback");
    }
    const font = hasCustomFont ? "CN" : "Helvetica";

    const meetingType = report.meetingType || "会议";
    const date = report.date || fmtDate(nowISO());

    // ── Title
    doc.font(font).fontSize(20).text(`会议纪要 — ${meetingType}`, { align: "center" });
    doc.fontSize(11).fillColor("#666").text(date, { align: "center" });
    doc.moveDown(1.2);

    // ── Summary
    if (report.summary) {
      doc.fillColor("#000").fontSize(14).text("📝 Summary");
      doc.moveTo(50, doc.y).lineTo(545, doc.y).strokeColor("#ccc").stroke();
      doc.moveDown(0.4);
      doc.fontSize(10).text(report.summary);
      doc.moveDown(1);
    }

    // ── Highlights
    if (report.highlights && report.highlights.length) {
      doc.fontSize(14).text("📌 Highlights");
      doc.moveTo(50, doc.y).lineTo(545, doc.y).strokeColor("#ccc").stroke();
      doc.moveDown(0.4);
      for (const h of report.highlights) {
        doc.fontSize(10).text(`• ${h.point}`, { continued: h.detail ? true : false });
        if (h.detail) doc.fillColor("#555").text(` — ${h.detail}`);
        doc.fillColor("#000");
      }
      doc.moveDown(1);
    }

    // ── Lowlights
    if (report.lowlights && report.lowlights.length) {
      doc.fontSize(14).text("⚠️ Lowlights");
      doc.moveTo(50, doc.y).lineTo(545, doc.y).strokeColor("#ccc").stroke();
      doc.moveDown(0.4);
      for (const l of report.lowlights) {
        doc.fontSize(10).text(`• ${l.point}`, { continued: l.detail ? true : false });
        if (l.detail) doc.fillColor("#555").text(` — ${l.detail}`);
        doc.fillColor("#000");
      }
      doc.moveDown(1);
    }

    // ── Follow-up Actions
    if (report.actions && report.actions.length) {
      doc.fontSize(14).text("✅ Follow-up Actions");
      doc.moveTo(50, doc.y).lineTo(545, doc.y).strokeColor("#ccc").stroke();
      doc.moveDown(0.4);
      for (const a of report.actions) {
        const priority = (a.priority || "medium").toUpperCase();
        doc.fontSize(10).text(
          `• [${priority}] ${a.task}  |  负责人: ${a.owner || "-"}  |  截止: ${a.deadline || "-"}`
        );
      }
      doc.moveDown(1);
    }

    // ── Participants / Duration
    if (report.participants && report.participants.length) {
      doc.fontSize(10).fillColor("#444").text(`参会人: ${report.participants.join("、")}`);
    }
    if (report.duration) {
      doc.fontSize(10).fillColor("#444").text(`会议时长: ${report.duration}`);
    }

    // ── Footer on every page
    const pages = doc.bufferedPageRange();
    for (let i = 0; i < pages.count; i++) {
      doc.switchToPage(i);
      doc.fontSize(8).fillColor("#aaa").text(
        `Generated: ${nowCN()}`,
        50,
        doc.page.height - 40,
        { align: "center", width: doc.page.width - 100 }
      );
    }

    doc.end();
  });
}

/* ─── HTML email body ─────────────────────────────────── */

function buildHtmlBody(report) {
  const meetingType = report.meetingType || "会议";
  const date = report.date || fmtDate(nowISO());

  const esc = (s) => String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  const sectionStyle = `margin-bottom:24px;`;
  const h2Style = `font-size:16px;color:#1a1a1a;border-bottom:2px solid #e5e5e5;padding-bottom:6px;margin-bottom:12px;`;
  const liStyle = `margin-bottom:6px;line-height:1.6;`;

  let html = `<!DOCTYPE html><html><head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background-color:#f5f5f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f5;padding:24px 0;">
<tr><td align="center">
<table width="640" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:8px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,0.08);">

<!-- Header -->
<tr><td style="background:linear-gradient(135deg,#1e3a5f,#2c5282);padding:28px 32px;color:#fff;">
  <h1 style="margin:0;font-size:22px;font-weight:600;">会议纪要</h1>
  <p style="margin:6px 0 0;opacity:0.85;font-size:14px;">${esc(meetingType)} — ${esc(date)}</p>
</td></tr>

<!-- Body -->
<tr><td style="padding:28px 32px;color:#333;font-size:14px;">`;

  // Summary
  if (report.summary) {
    html += `<div style="${sectionStyle}">
  <h2 style="${h2Style}">📝 Summary</h2>
  <p style="line-height:1.7;color:#444;">${esc(report.summary)}</p>
</div>`;
  }

  // Highlights
  if (report.highlights && report.highlights.length) {
    html += `<div style="${sectionStyle}">
  <h2 style="${h2Style}">📌 Highlights</h2>
  <ul style="padding-left:20px;margin:0;">`;
    for (const h of report.highlights) {
      html += `<li style="${liStyle}"><strong>${esc(h.point)}</strong>`;
      if (h.detail) html += `<br><span style="color:#666;">${esc(h.detail)}</span>`;
      html += `</li>`;
    }
    html += `</ul></div>`;
  }

  // Lowlights
  if (report.lowlights && report.lowlights.length) {
    html += `<div style="${sectionStyle}">
  <h2 style="${h2Style}">⚠️ Lowlights</h2>
  <ul style="padding-left:20px;margin:0;">`;
    for (const l of report.lowlights) {
      html += `<li style="${liStyle}"><strong>${esc(l.point)}</strong>`;
      if (l.detail) html += `<br><span style="color:#666;">${esc(l.detail)}</span>`;
      html += `</li>`;
    }
    html += `</ul></div>`;
  }

  // Actions table
  if (report.actions && report.actions.length) {
    const thStyle = `padding:10px 12px;background:#f8f9fa;border-bottom:2px solid #dee2e6;text-align:left;font-size:13px;color:#495057;`;
    const tdStyle = `padding:10px 12px;border-bottom:1px solid #eee;font-size:13px;`;
    const priorityColor = { high: "#dc3545", medium: "#fd7e14", low: "#28a745" };

    html += `<div style="${sectionStyle}">
  <h2 style="${h2Style}">✅ Follow-up Actions</h2>
  <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
  <tr><th style="${thStyle}">任务</th><th style="${thStyle}">负责人</th><th style="${thStyle}">截止</th><th style="${thStyle}">优先级</th></tr>`;
    for (const a of report.actions) {
      const p = (a.priority || "medium").toLowerCase();
      const color = priorityColor[p] || "#666";
      html += `<tr>
  <td style="${tdStyle}">${esc(a.task)}</td>
  <td style="${tdStyle}">${esc(a.owner || "-")}</td>
  <td style="${tdStyle}">${esc(a.deadline || "-")}</td>
  <td style="${tdStyle}"><span style="color:${color};font-weight:600;">${esc(p.toUpperCase())}</span></td>
</tr>`;
    }
    html += `</table></div>`;
  }

  // Meta info
  const meta = [];
  if (report.participants && report.participants.length) meta.push(`参会人: ${report.participants.map(esc).join("、")}`);
  if (report.duration) meta.push(`会议时长: ${esc(report.duration)}`);
  if (meta.length) {
    html += `<div style="margin-top:16px;padding:12px 16px;background:#f8f9fa;border-radius:6px;font-size:13px;color:#666;">
  ${meta.join("&nbsp;&nbsp;|&nbsp;&nbsp;")}
</div>`;
  }

  html += `</td></tr>

<!-- Footer -->
<tr><td style="padding:16px 32px;background:#fafafa;border-top:1px solid #eee;text-align:center;font-size:12px;color:#999;">
  Generated: ${esc(nowCN())} &nbsp;|&nbsp; Meeting Minutes System
</td></tr>

</table>
</td></tr></table>
</body></html>`;

  return html;
}

/* ─── SES raw email with attachment ───────────────────── */

async function sendEmailWithAttachment({ to, subject, htmlBody, pdfBuffer, pdfFilename }) {
  const toAddresses = Array.isArray(to) ? to : [to];
  const from = process.env.SES_FROM_EMAIL;
  const boundary = `----=_Part_${Date.now().toString(36)}`;

  const raw = [
    `From: ${from}`,
    `To: ${toAddresses.join(", ")}`,
    `Subject: =?UTF-8?B?${Buffer.from(subject).toString("base64")}?=`,
    `MIME-Version: 1.0`,
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    ``,
    `--${boundary}`,
    `Content-Type: text/html; charset=UTF-8`,
    `Content-Transfer-Encoding: base64`,
    ``,
    Buffer.from(htmlBody).toString("base64").replace(/(.{76})/g, "$1\n"),
    ``,
    `--${boundary}`,
    `Content-Type: application/pdf; name="${pdfFilename}"`,
    `Content-Transfer-Encoding: base64`,
    `Content-Disposition: attachment; filename="${pdfFilename}"`,
    ``,
    pdfBuffer.toString("base64").replace(/(.{76})/g, "$1\n"),
    ``,
    `--${boundary}--`,
  ].join("\n");

  await ses.send(new SendRawEmailCommand({
    RawMessage: { Data: Buffer.from(raw) },
  }));
}

/* ─── main processing ─────────────────────────────────── */

async function processMessage(message) {
  const body = JSON.parse(message.Body);
  const { meetingId, reportKey } = body;
  console.log(`[export-worker] Processing meeting ${meetingId}`);

  // 1. Read report from S3
  const reportStream = await getFile(reportKey);
  const report = JSON.parse(await streamToString(reportStream));
  console.log(`[export-worker] Report loaded for ${meetingId}`);

  // 2. Generate PDF
  const pdfBuffer = await generatePdf(report);
  console.log(`[export-worker] PDF generated (${(pdfBuffer.length / 1024).toFixed(1)} KB)`);

  // 3. Upload PDF to S3
  const pdfKey = `exports/${meetingId}/report.pdf`;
  const fullPdfKey = await uploadFile(pdfKey, pdfBuffer, "application/pdf");
  console.log(`[export-worker] PDF uploaded to ${fullPdfKey}`);

  // 4. Send email via SES
  const meetingType = report.meetingType || "会议";
  const date = report.date || fmtDate(nowISO());
  const subject = `【会议纪要】${meetingType} - ${date}`;
  const htmlBody = buildHtmlBody(report);

  const toEmail = process.env.SES_TO_EMAIL;
  if (toEmail) {
    await sendEmailWithAttachment({
      to: toEmail,
      subject,
      htmlBody,
      pdfBuffer,
      pdfFilename: `meeting-minutes-${meetingId}.pdf`,
    });
    console.log(`[export-worker] Email sent to ${toEmail}`);
  } else {
    console.warn("[export-worker] SES_TO_EMAIL not set, skipping email");
  }

  // 5. Update DynamoDB status to "completed"
  await docClient.send(new UpdateCommand({
    TableName: TABLE,
    Key: { meetingId },
    UpdateExpression: "SET #s = :s, pdfKey = :pk, exportedAt = :ea, updatedAt = :u",
    ExpressionAttributeNames: { "#s": "status" },
    ExpressionAttributeValues: {
      ":s": "completed",
      ":pk": fullPdfKey,
      ":ea": nowISO(),
      ":u": nowISO(),
    },
  }));
  console.log(`[export-worker] Meeting ${meetingId} marked as completed`);
}

/* ─── polling loop ────────────────────────────────────── */

async function poll() {
  console.log("[export-worker] Started, polling mm-export-queue...");
  while (true) {
    try {
      const messages = await receiveMessages(QUEUE_URL);
      for (const msg of messages) {
        try {
          await processMessage(msg);
          await deleteMessage(QUEUE_URL, msg.ReceiptHandle);
        } catch (err) {
          console.error(`[export-worker] Failed to process message:`, err);
        }
      }
    } catch (err) {
      console.error("[export-worker] Poll error:", err);
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL));
  }
}

poll();
