import * as nodemailer from "nodemailer";
import type * as SMTPTransport from 'nodemailer/lib/smtp-transport';
import "dotenv/config";
import { catchError, logError } from "./Helpers.js";

// Email HTML template
const emailTemplate = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>[subject]</title>
    <style>
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
            line-height: 1.6;
            color: #333;
            max-width: 600px;
            margin: 0 auto;
            padding: 20px;
        }
        .container {
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            padding: 40px;
            border-radius: 10px;
            color: white;
        }
        .content {
            background: white;
            padding: 30px;
            margin-top: -10px;
            border-radius: 0 0 10px 10px;
            color: #333;
        }
        .button {
            display: inline-block;
            padding: 12px 24px;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            text-decoration: none;
            border-radius: 5px;
            margin-top: 20px;
        }
        .footer {
            text-align: center;
            margin-top: 30px;
            font-size: 12px;
            color: #999;
        }
    </style>
</head>
<body>
    <div class="container">
        <h1 style="margin: 0; font-size: 24px;">🎮 Shard</h1>
        <p style="margin: 10px 0 0 0; opacity: 0.9;">Level Up Your Life</p>
    </div>
    <div class="content">
        <h2 style="color: #667eea; margin-top: 0;">[subject]</h2>
        <p style="line-height: 1.8;">[message]</p>
        <a href="#" class="button">View Details</a>
    </div>
    <div class="footer">
        <p>© 2024 Shard. All rights reserved.</p>
        <p>You're receiving this because you have an account with Shard.</p>
    </div>
</body>
</html>
`;
const smtpConfig: SMTPTransport.Options = {
	host: process.env.SMTP_HOST,
	port: +(process.env.SMTP_PORT || 465),
	secure: process.env.SMTP_SECURE === "true", // false for 587, true for 465
	requireTLS: true, // Force STARTTLS
	tls: {
		rejectUnauthorized: false, // Allow self-signed certificates
		ciphers: 'SSLv3'
	},
	auth: {
		user: process.env.SMTP_USER,
		pass: process.env.SMTP_PASS,
	},
	connectionTimeout: 60000, // 60 seconds
	greetingTimeout: 30000, // 30 seconds
	debug: true, // Enable debug output
	logger: true, // Enable logging
};

const transporter = nodemailer.createTransport(smtpConfig);


type MailInput = {
	recipients: string;
	subject: string;
	message: string;
};

// Test SMTP connection
async function testSMTPConnection() {
	try {
		await transporter.verify();
		console.log('✅ SMTP connection verified successfully');
		return true;
	} catch (error) {
		console.log('❌ SMTP connection failed:', error);
		return false;
	}
}

// async..await is not allowed in global scope, must use a wrapper
async function SendMail(input: MailInput) {
	// Test connection first
	const isConnected = await testSMTPConnection();
	if (!isConnected) {
		console.log('SMTP connection test failed, aborting email send');
		return false;
	}

	// Generate HTML email content
	const htmlContent = emailTemplate
		.replace(/\[message\]/g, input.message)
		.replace(/\[subject\]/g, input.subject);

	// send mail with defined transport object
	const obj = {
		from: `${process.env.SMTP_NAME || "Shard"} <${process.env.SMTP_USER}>`,
		to: input.recipients,
		subject: input.subject,
		html: htmlContent,
	};

	console.log('Attempting to send email to:', input.recipients);
	const [error, info] = await catchError(transporter.sendMail(obj));
	if (error) {
		console.log('Email send error:', error);
		logError('SendMail', error);
		return false;
	}

	return true;
}

export default SendMail;
