function buildEmailHtml({html, now}) {
    const logoUrl = 'https://mihealth.ng/images/mihealthlogo-1-no-bg.png';
    const logoAlt = 'MiHealth logo';
    const year = new Date().getFullYear();


    return `
    <!DOCTYPE html>
    <html lang="en">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>Welcome to MiHealth</title>
      </head>
    <body style="margin:0; padding:0; background-color:#f4f7fb; font-family:Arial, Helvetica, sans-serif; color:#14213d;">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background-color:#f4f7fb;">
          <tr>
            <td align="center" style="padding:24px;">
              <table role="presentation" width="600" cellspacing="0" cellpadding="0" border="0" style="width:100%; max-width:600px; background-color:#ffffff; border-radius:8px;">
                <tr>
                  <td style="background-color:#14213d; padding:28px 32px; text-align:center;">
                    <img src="${logoUrl}" alt="${logoAlt}" width="180" style="max-width:180px; height:auto; display:block; margin:0 auto 10px;" />
                    <div style="font-size:28px; font-weight:700; color:#ffffff; letter-spacing:0.5px;">MiHealth NG</div>
                    <div style="margin-top:6px; font-size:14px; color:#cbd5e1;">Care that feels personal</div>
                  </td>
                </tr>
                <tr>
                  <td style="padding:36px 32px;">
                   
                    ${html}
                  </td>
                </tr>
                <tr>
                  <td style="background-color:#f8fafc; padding:20px 32px; font-size:13px; color:#64748b; text-align:center; border-top:1px solid #e2e8f0;">
                    This email was sent by MiHealth. If you have any questions, contact our support team.
                    <div> Email: support@mihealth.ng ${"      "} Website: https://mihealth.ng
                    </div>
                    <p>© ${now} MiHealth.</p>
                    <p>Connecting care, anytime.</p>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
        </table>
      </body>
    </html>
  `;
}

module.exports = {
    buildEmailHtml,
};
