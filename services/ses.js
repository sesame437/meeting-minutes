const { SESClient, SendEmailCommand } = require("@aws-sdk/client-ses");

const ses = new SESClient({ region: process.env.AWS_REGION });

async function sendEmail({ to, subject, htmlBody }) {
  await ses.send(new SendEmailCommand({
    Source: process.env.SES_FROM_EMAIL,
    Destination: { ToAddresses: Array.isArray(to) ? to : [to] },
    Message: {
      Subject: { Data: subject },
      Body: { Html: { Data: htmlBody } },
    },
  }));
}

module.exports = { ses, sendEmail };
