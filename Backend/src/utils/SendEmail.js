import nodemailer from "nodemailer";

export const sendEmail = async (options) => {
  try {
    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: process.env.SMTP_PORT,
      secure: false,
      auth: {
        user: process.env.SMTP_MAIL,
        pass: process.env.SMTP_PASSWORD,
      },
    });

    const mailOptions = {
      from: `NexaCommand System <${process.env.SMTP_MAIL}>`, 
      to: options.email, 
      subject: options.subject, 
      text: options.message, 

    };

    const mailResponse = await transporter.sendMail(mailOptions);
    
    return mailResponse;

  } catch (error) {
    console.error("Email Dispatcher Failed:", error.message);
    throw new Error(error.message);
  }
};