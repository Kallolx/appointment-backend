const nodemailer = require('nodemailer');
require('dotenv').config();

// Create transporter with SMTP configuration from environment variables
const createTransporter = () => {
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT),
    secure: process.env.SMTP_SECURE === 'true', // true for 465, false for other ports
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
    // Additional options for better compatibility
    tls: {
      rejectUnauthorized: false // Accept self-signed certificates if needed
    }
  });
};

// Test email connection
async function testEmailConnection() {
  try {
    const transporter = createTransporter();
    await transporter.verify();
    console.log('✅ SMTP connection successful');
    return { success: true, message: 'SMTP connection verified' };
  } catch (error) {
    console.error('❌ SMTP connection failed:', error);
    return { success: false, message: 'SMTP connection failed', error: error.message };
  }
}

// Send appointment confirmation email
async function sendAppointmentConfirmation(appointmentData) {
  try {
    const transporter = createTransporter();
    
    const {
      customer_email,
      customer_name,
      service_name,
      appointment_date,
      appointment_time,
      address,
      total_amount,
      payment_method,
      appointment_id
    } = appointmentData;

    const mailOptions = {
      from: `"${process.env.SMTP_FROM_NAME}" <${process.env.SMTP_FROM_EMAIL}>`,
      to: customer_email,
      subject: `Appointment Confirmation - ${service_name}`,
      html: `
        <!DOCTYPE html>
        <html>
        <head>
          <meta charset="utf-8">
          <title>Appointment Confirmation</title>
          <style>
            * { margin: 0; padding: 0; box-sizing: border-box; }
            body { 
              font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; 
              line-height: 1.6; 
              color: #333; 
              background-color: #f8fafc;
            }
            .email-container { 
              max-width: 600px; 
              margin: 0 auto; 
              background-color: #ffffff;
              border-radius: 12px;
              overflow: hidden;
              box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
            }
            .header { 
              background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
              color: white; 
              padding: 40px 30px;
              text-align: center;
              position: relative;
            }
            .header::before {
              content: '';
              position: absolute;
              top: 0;
              left: 0;
              right: 0;
              bottom: 0;
              background: url('data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><defs><pattern id="grain" width="100" height="100" patternUnits="userSpaceOnUse"><circle cx="25" cy="25" r="1" fill="rgba(255,255,255,0.1)"/><circle cx="75" cy="75" r="1" fill="rgba(255,255,255,0.1)"/><circle cx="50" cy="10" r="0.5" fill="rgba(255,255,255,0.1)"/><circle cx="10" cy="60" r="0.5" fill="rgba(255,255,255,0.1)"/><circle cx="90" cy="40" r="0.5" fill="rgba(255,255,255,0.1)"/></pattern></defs><rect width="100" height="100" fill="url(%23grain)"/></svg>');
              opacity: 0.3;
            }
            .header h1 { 
              font-size: 28px; 
              font-weight: 700; 
              margin-bottom: 8px;
              position: relative;
              z-index: 1;
            }
            .header .subtitle {
              font-size: 16px;
              opacity: 0.9;
              position: relative;
              z-index: 1;
            }
            .success-icon {
              width: 60px;
              height: 60px;
              background-color: #10b981;
              border-radius: 50%;
              display: inline-flex;
              align-items: center;
              justify-content: center;
              margin-bottom: 20px;
              position: relative;
              z-index: 1;
            }
            .content { 
              padding: 40px 30px;
              background-color: #ffffff;
            }
            .greeting {
              font-size: 18px;
              color: #374151;
              margin-bottom: 20px;
              font-weight: 500;
            }
            .intro-text {
              color: #6b7280;
              margin-bottom: 30px;
              font-size: 16px;
            }
            .appointment-card { 
              background: linear-gradient(135deg, #f8fafc 0%, #e2e8f0 100%);
              border: 1px solid #e5e7eb;
              border-radius: 12px;
              padding: 25px;
              margin: 25px 0;
              position: relative;
              overflow: hidden;
            }
            .appointment-card::before {
              content: '';
              position: absolute;
              top: 0;
              left: 0;
              width: 4px;
              height: 100%;
              background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            }
            .appointment-card h3 {
              color: #1f2937;
              font-size: 20px;
              font-weight: 600;
              margin-bottom: 20px;
              display: flex;
              align-items: center;
            }
            .appointment-card h3::before {
              content: '📅';
              margin-right: 10px;
              font-size: 24px;
            }
            .detail-row {
              display: flex;
              justify-content: space-between;
              align-items: center;
              padding: 12px 0;
              border-bottom: 1px solid #e5e7eb;
            }
            .detail-row:last-child {
              border-bottom: none;
              font-weight: 600;
              background: linear-gradient(135deg, #ecfdf5 0%, #d1fae5 100%);
              margin: 15px -15px -15px -15px;
              padding: 15px;
              border-radius: 8px;
            }
            .detail-label {
              font-weight: 600;
              color: #374151;
              font-size: 14px;
            }
            .detail-value {
              color: #1f2937;
              font-size: 14px;
              text-align: right;
              max-width: 60%;
            }
            .total-amount {
              color: #059669 !important;
              font-size: 18px !important;
              font-weight: 700 !important;
            }
            .booking-id {
              color: #7c3aed !important;
              font-weight: 600 !important;
            }
            .instructions {
              background-color: #fef3c7;
              border: 1px solid #fbbf24;
              border-radius: 8px;
              padding: 20px;
              margin: 25px 0;
              color: #92400e;
            }
            .instructions-title {
              font-weight: 600;
              margin-bottom: 8px;
              display: flex;
              align-items: center;
            }
            .instructions-title::before {
              content: '⚠️';
              margin-right: 8px;
            }
            .cta-section {
              text-align: center;
              margin: 30px 0;
            }
            .cta-button { 
              background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
              color: white; 
              padding: 15px 30px; 
              text-decoration: none; 
              border-radius: 8px; 
              display: inline-block; 
              font-weight: 600;
              font-size: 16px;
              box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
              transition: all 0.3s ease;
            }
            .cta-button:hover {
              transform: translateY(-2px);
              box-shadow: 0 6px 12px rgba(0, 0, 0, 0.15);
            }
            .footer { 
              background: linear-gradient(135deg, #1f2937 0%, #374151 100%);
              color: #e5e7eb;
              text-align: center; 
              padding: 30px;
            }
            .footer-title {
              font-size: 18px;
              font-weight: 600;
              margin-bottom: 8px;
              color: #ffffff;
            }
            .footer-text {
              opacity: 0.8;
              font-size: 14px;
            }
            .company-info {
              margin-top: 20px;
              padding-top: 20px;
              border-top: 1px solid #4b5563;
              opacity: 0.7;
              font-size: 12px;
            }
          </style>
        </head>
        <body>
          <div class="email-container">
            <div class="header">
              <div class="success-icon">✓</div>
              <h1>Booking Confirmed!</h1>
              <div class="subtitle">Your appointment has been successfully scheduled</div>
            </div>
            
            <div class="content">
              <div class="greeting">Hello ${customer_name},</div>
              <div class="intro-text">
                Great news! Your service appointment has been confirmed. We're excited to serve you and provide you with our best-in-class service.
              </div>
              
              <div class="appointment-card">
                <h3>Appointment Details</h3>
                <div class="detail-row">
                  <span class="detail-label">🏠 Service</span>
                  <span class="detail-value">${service_name}</span>
                </div>
                <div class="detail-row">
                  <span class="detail-label">📅 Date</span>
                  <span class="detail-value">${appointment_date}</span>
                </div>
                <div class="detail-row">
                  <span class="detail-label">🕐 Time</span>
                  <span class="detail-value">${appointment_time}</span>
                </div>
                <div class="detail-row">
                  <span class="detail-label">📍 Address</span>
                  <span class="detail-value">${address}</span>
                </div>
                <div class="detail-row">
                  <span class="detail-label">💳 Payment</span>
                  <span class="detail-value">${payment_method}</span>
                </div>
                <div class="detail-row">
                  <span class="detail-label">💰 Total Amount</span>
                  <span class="detail-value total-amount">AED ${total_amount}</span>
                </div>
                <div class="detail-row">
                  <span class="detail-label">🎫 Booking ID</span>
                  <span class="detail-value booking-id">#${appointment_id}</span>
                </div>
              </div>
              
              <div class="instructions">
                <div class="instructions-title">Important Instructions</div>
                <div>Please ensure someone is available at the location during the scheduled time. Our professional service team will arrive promptly and provide you with excellent service.</div>
              </div>
              
              <div class="cta-section">
                <a href="tel:+971501234567" class="cta-button">📞 Call Us: +971 50 123 4567</a>
              </div>
              
              <div style="color: #6b7280; font-size: 14px; text-align: center; margin-top: 20px;">
                Need to make changes? Contact us immediately and we'll be happy to help!
              </div>
            </div>
            
            <div class="footer">
              <div class="footer-title">Thank you for choosing AppointPro Dubai!</div>
              <div class="footer-text">We're committed to providing you with exceptional service</div>
              <div class="company-info">
                AppointPro Dubai - Your Trusted Service Partner<br>
                📧 tutor@gsmarena1.com | 📞 +971 50 123 4567
              </div>
            </div>
          </div>
        </body>
        </html>
      `
    };

    const result = await transporter.sendMail(mailOptions);
    console.log('✅ Appointment confirmation email sent:', result.messageId);
    
    return {
      success: true,
      message: 'Appointment confirmation email sent successfully',
      messageId: result.messageId
    };
  } catch (error) {
    console.error('❌ Error sending appointment confirmation email:', error);
    return {
      success: false,
      message: 'Failed to send appointment confirmation email',
      error: error.message
    };
  }
}

// Send appointment reminder email
async function sendAppointmentReminder(appointmentData) {
  try {
    const transporter = createTransporter();
    
    const {
      customer_email,
      customer_name,
      service_name,
      appointment_date,
      appointment_time,
      address,
      appointment_id
    } = appointmentData;

    const mailOptions = {
      from: `"${process.env.SMTP_FROM_NAME}" <${process.env.SMTP_FROM_EMAIL}>`,
      to: customer_email,
      subject: `Appointment Reminder - Tomorrow at ${appointment_time}`,
      html: `
        <!DOCTYPE html>
        <html>
        <head>
          <meta charset="utf-8">
          <title>Appointment Reminder</title>
          <style>
            * { margin: 0; padding: 0; box-sizing: border-box; }
            body { 
              font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; 
              line-height: 1.6; 
              color: #333; 
              background-color: #f8fafc;
            }
            .email-container { 
              max-width: 600px; 
              margin: 0 auto; 
              background-color: #ffffff;
              border-radius: 12px;
              overflow: hidden;
              box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
            }
            .header { 
              background: linear-gradient(135deg, #f59e0b 0%, #d97706 100%);
              color: white; 
              padding: 35px 30px;
              text-align: center;
              position: relative;
            }
            .header::before {
              content: '';
              position: absolute;
              top: 0;
              left: 0;
              right: 0;
              bottom: 0;
              background: url('data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><defs><pattern id="reminderGrain" width="80" height="80" patternUnits="userSpaceOnUse"><circle cx="20" cy="20" r="1" fill="rgba(255,255,255,0.1)"/><circle cx="60" cy="60" r="1" fill="rgba(255,255,255,0.1)"/><circle cx="40" cy="10" r="0.5" fill="rgba(255,255,255,0.1)"/><circle cx="10" cy="50" r="0.5" fill="rgba(255,255,255,0.1)"/><circle cx="70" cy="30" r="0.5" fill="rgba(255,255,255,0.1)"/></pattern></defs><rect width="100" height="100" fill="url(%23reminderGrain)"/></svg>');
              opacity: 0.3;
            }
            .clock-icon {
              width: 70px;
              height: 70px;
              background-color: rgba(255, 255, 255, 0.2);
              border-radius: 50%;
              display: inline-flex;
              align-items: center;
              justify-content: center;
              margin-bottom: 15px;
              font-size: 30px;
              position: relative;
              z-index: 1;
              animation: pulse 2s infinite;
            }
            @keyframes pulse {
              0% { transform: scale(1); }
              50% { transform: scale(1.05); }
              100% { transform: scale(1); }
            }
            .header h1 { 
              font-size: 28px; 
              font-weight: 700; 
              margin-bottom: 8px;
              position: relative;
              z-index: 1;
            }
            .header .subtitle {
              font-size: 16px;
              opacity: 0.9;
              position: relative;
              z-index: 1;
              font-weight: 500;
            }
            .content { 
              padding: 35px 30px;
              background-color: #ffffff;
            }
            .greeting {
              font-size: 18px;
              color: #374151;
              margin-bottom: 20px;
              font-weight: 500;
            }
            .reminder-message {
              background: linear-gradient(135deg, #fef3c7 0%, #fbbf24 20%);
              border: 2px solid #f59e0b;
              border-radius: 12px;
              padding: 25px;
              margin: 25px 0;
              text-align: center;
              position: relative;
            }
            .reminder-message::before {
              content: '⏰';
              font-size: 24px;
              position: absolute;
              top: -12px;
              left: 50%;
              transform: translateX(-50%);
              background: #f59e0b;
              width: 24px;
              height: 24px;
              border-radius: 50%;
              display: flex;
              align-items: center;
              justify-content: center;
              padding: 20px;
            }
            .reminder-title {
              font-size: 20px;
              font-weight: 700;
              color: #92400e;
              margin-bottom: 10px;
              margin-top: 10px;
            }
            .reminder-text {
              color: #b45309;
              font-size: 16px;
              font-weight: 500;
            }
            .appointment-card { 
              background: linear-gradient(135deg, #f0f9ff 0%, #e0f2fe 100%);
              border: 2px solid #0ea5e9;
              border-radius: 12px;
              padding: 25px;
              margin: 25px 0;
              position: relative;
            }
            .appointment-card::before {
              content: '';
              position: absolute;
              top: 0;
              left: 0;
              width: 4px;
              height: 100%;
              background: linear-gradient(135deg, #0ea5e9 0%, #0284c7 100%);
              border-radius: 0 2px 2px 0;
            }
            .appointment-card h3 {
              color: #0c4a6e;
              font-size: 20px;
              font-weight: 600;
              margin-bottom: 20px;
              display: flex;
              align-items: center;
            }
            .appointment-card h3::before {
              content: '📅';
              margin-right: 10px;
              font-size: 24px;
            }
            .detail-row {
              display: flex;
              justify-content: space-between;
              align-items: center;
              padding: 12px 0;
              border-bottom: 1px solid #bae6fd;
            }
            .detail-row:last-child {
              border-bottom: none;
              margin-top: 10px;
            }
            .detail-label {
              font-weight: 600;
              color: #0c4a6e;
              font-size: 14px;
            }
            .detail-value {
              color: #164e63;
              font-size: 14px;
              font-weight: 500;
              text-align: right;
              max-width: 60%;
            }
            .highlight-time {
              background: linear-gradient(135deg, #dcfce7 0%, #bbf7d0 100%);
              border: 1px solid #16a34a;
              border-radius: 8px;
              padding: 15px;
              margin: 10px -10px;
              text-align: center;
            }
            .highlight-time .time-label {
              font-size: 12px;
              color: #15803d;
              font-weight: 600;
              text-transform: uppercase;
              letter-spacing: 0.5px;
              margin-bottom: 5px;
            }
            .highlight-time .time-value {
              font-size: 24px;
              font-weight: 700;
              color: #166534;
            }
            .instructions {
              background: linear-gradient(135deg, #fef2f2 0%, #fecaca 100%);
              border: 1px solid #f87171;
              border-radius: 10px;
              padding: 20px;
              margin: 25px 0;
              color: #991b1b;
            }
            .instructions-title {
              font-weight: 600;
              margin-bottom: 10px;
              display: flex;
              align-items: center;
              font-size: 16px;
            }
            .instructions-title::before {
              content: '📝';
              margin-right: 8px;
              font-size: 18px;
            }
            .cta-section {
              text-align: center;
              margin: 30px 0;
            }
            .cta-buttons {
              display: flex;
              gap: 15px;
              justify-content: center;
              flex-wrap: wrap;
            }
            .cta-button { 
              padding: 15px 25px; 
              text-decoration: none; 
              border-radius: 8px; 
              display: inline-flex;
              align-items: center;
              gap: 8px;
              font-weight: 600;
              font-size: 14px;
              transition: all 0.3s ease;
            }
            .btn-primary {
              background: linear-gradient(135deg, #f59e0b 0%, #d97706 100%);
              color: white;
              box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
            }
            .btn-secondary {
              background: white;
              color: #374151;
              border: 2px solid #d1d5db;
            }
            .footer { 
              background: linear-gradient(135deg, #1f2937 0%, #374151 100%);
              color: #e5e7eb;
              text-align: center; 
              padding: 30px;
            }
            .footer-title {
              font-size: 18px;
              font-weight: 600;
              margin-bottom: 8px;
              color: #ffffff;
            }
            .footer-text {
              opacity: 0.8;
              font-size: 14px;
            }
            @media (max-width: 600px) {
              .cta-buttons {
                flex-direction: column;
              }
              .detail-row {
                flex-direction: column;
                align-items: flex-start;
                gap: 5px;
              }
              .detail-value {
                text-align: left;
                max-width: 100%;
              }
            }
          </style>
        </head>
        <body>
          <div class="email-container">
            <div class="header">
              <div class="clock-icon">⏰</div>
              <h1>Appointment Reminder</h1>
              <div class="subtitle">Don't forget your upcoming service appointment!</div>
            </div>
            
            <div class="content">
              <div class="greeting">Hello ${customer_name},</div>
              
              <div class="reminder-message">
                <div class="reminder-title">Tomorrow's Appointment</div>
                <div class="reminder-text">We're excited to serve you tomorrow! Here's a friendly reminder about your scheduled appointment.</div>
              </div>
              
              <div class="appointment-card">
                <h3>Appointment Summary</h3>
                <div class="detail-row">
                  <span class="detail-label">🏠 Service</span>
                  <span class="detail-value">${service_name}</span>
                </div>
                <div class="detail-row">
                  <span class="detail-label">📅 Date</span>
                  <span class="detail-value">${appointment_date}</span>
                </div>
                <div class="detail-row">
                  <span class="detail-label">📍 Address</span>
                  <span class="detail-value">${address}</span>
                </div>
                <div class="detail-row">
                  <span class="detail-label">🎫 Booking ID</span>
                  <span class="detail-value">#${appointment_id}</span>
                </div>
                
                <div class="highlight-time">
                  <div class="time-label">Appointment Time</div>
                  <div class="time-value">${appointment_time}</div>
                </div>
              </div>
              
              <div class="instructions">
                <div class="instructions-title">Preparation Checklist</div>
                <div>
                  ✅ Ensure someone is available at the location<br>
                  ✅ Clear the service area if needed<br>
                  ✅ Have your booking ID ready<br>
                  ✅ Keep your phone accessible for our team
                </div>
              </div>
              
              <div class="cta-section">
                <div class="cta-buttons">
                  <a href="tel:+971501234567" class="cta-button btn-primary">
                    📞 Call Us
                  </a>
                  <a href="#" class="cta-button btn-secondary">
                    ✏️ Reschedule
                  </a>
                </div>
              </div>
              
              <div style="color: #6b7280; font-size: 14px; text-align: center; margin-top: 20px; padding: 15px; background: #f9fafb; border-radius: 8px;">
                <strong>Need to make changes?</strong><br>
                Contact us as soon as possible and we'll accommodate your request!
              </div>
            </div>
            
            <div class="footer">
              <div class="footer-title">We look forward to serving you!</div>
              <div class="footer-text">AppointPro Dubai - Your trusted service partner</div>
            </div>
          </div>
        </body>
        </html>
      `
    };

    const result = await transporter.sendMail(mailOptions);
    console.log('✅ Appointment reminder email sent:', result.messageId);
    
    return {
      success: true,
      message: 'Appointment reminder email sent successfully',
      messageId: result.messageId
    };
  } catch (error) {
    console.error('❌ Error sending appointment reminder email:', error);
    return {
      success: false,
      message: 'Failed to send appointment reminder email',
      error: error.message
    };
  }
}

// Send admin notification email
async function sendAdminNotification(appointmentData) {
  try {
    const transporter = createTransporter();
    
    const {
      customer_email,
      customer_name,
      customer_phone,
      service_name,
      appointment_date,
      appointment_time,
      address,
      total_amount,
      payment_method,
      appointment_id,
      notes
    } = appointmentData;

    const mailOptions = {
      from: `"${process.env.SMTP_FROM_NAME}" <${process.env.SMTP_FROM_EMAIL}>`,
      to: process.env.SMTP_FROM_EMAIL, // Send to admin email
      subject: `New Appointment Booking - ${service_name} (#${appointment_id})`,
      html: `
        <!DOCTYPE html>
        <html>
        <head>
          <meta charset="utf-8">
          <title>New Appointment Booking</title>
          <style>
            * { margin: 0; padding: 0; box-sizing: border-box; }
            body { 
              font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; 
              line-height: 1.6; 
              color: #333; 
              background-color: #f8fafc;
            }
            .email-container { 
              max-width: 650px; 
              margin: 0 auto; 
              background-color: #ffffff;
              border-radius: 12px;
              overflow: hidden;
              box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
            }
            .header { 
              background: linear-gradient(135deg, #10b981 0%, #059669 100%);
              color: white; 
              padding: 30px;
              text-align: center;
              position: relative;
            }
            .header::before {
              content: '';
              position: absolute;
              top: 0;
              left: 0;
              right: 0;
              bottom: 0;
              background: url('data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><defs><pattern id="adminGrain" width="50" height="50" patternUnits="userSpaceOnUse"><circle cx="25" cy="25" r="1" fill="rgba(255,255,255,0.1)"/><circle cx="40" cy="10" r="0.5" fill="rgba(255,255,255,0.1)"/><circle cx="10" cy="40" r="0.5" fill="rgba(255,255,255,0.1)"/></pattern></defs><rect width="100" height="100" fill="url(%23adminGrain)"/></svg>');
              opacity: 0.3;
            }
            .notification-icon {
              width: 60px;
              height: 60px;
              background-color: rgba(255, 255, 255, 0.2);
              border-radius: 50%;
              display: inline-flex;
              align-items: center;
              justify-content: center;
              margin-bottom: 15px;
              font-size: 24px;
              position: relative;
              z-index: 1;
            }
            .header h1 { 
              font-size: 26px; 
              font-weight: 700; 
              margin-bottom: 8px;
              position: relative;
              z-index: 1;
            }
            .header .subtitle {
              font-size: 15px;
              opacity: 0.9;
              position: relative;
              z-index: 1;
            }
            .content { 
              padding: 30px;
              background-color: #ffffff;
            }
            .alert-message {
              background: linear-gradient(135deg, #fef3c7 0%, #fbbf24 20%);
              border: 1px solid #f59e0b;
              border-radius: 8px;
              padding: 20px;
              margin-bottom: 25px;
              color: #92400e;
              font-weight: 600;
              text-align: center;
            }
            .section-card {
              background: #f8fafc;
              border: 1px solid #e5e7eb;
              border-radius: 10px;
              padding: 20px;
              margin: 20px 0;
              position: relative;
            }
            .section-card.customer {
              border-left: 4px solid #3b82f6;
            }
            .section-card.appointment {
              border-left: 4px solid #10b981;
            }
            .section-title {
              font-size: 18px;
              font-weight: 600;
              color: #1f2937;
              margin-bottom: 15px;
              display: flex;
              align-items: center;
            }
            .customer .section-title::before {
              content: '👤';
              margin-right: 10px;
              font-size: 20px;
            }
            .appointment .section-title::before {
              content: '📋';
              margin-right: 10px;
              font-size: 20px;
            }
            .info-grid {
              display: grid;
              grid-template-columns: 1fr 1fr;
              gap: 15px;
            }
            .info-item {
              background: white;
              padding: 12px;
              border-radius: 6px;
              border: 1px solid #e5e7eb;
            }
            .info-label {
              font-size: 12px;
              color: #6b7280;
              font-weight: 600;
              text-transform: uppercase;
              letter-spacing: 0.5px;
              margin-bottom: 4px;
            }
            .info-value {
              color: #1f2937;
              font-weight: 500;
              font-size: 14px;
            }
            .info-item.highlight .info-value {
              color: #059669;
              font-weight: 600;
              font-size: 16px;
            }
            .info-item.id .info-value {
              color: #7c3aed;
              font-weight: 600;
            }
            .full-width {
              grid-column: 1 / -1;
            }
            .address-item {
              background: #ecfdf5;
              border: 1px solid #d1fae5;
            }
            .action-section {
              background: linear-gradient(135deg, #ede9fe 0%, #c7d2fe 100%);
              border: 1px solid #a78bfa;
              border-radius: 10px;
              padding: 25px;
              margin: 25px 0;
              text-align: center;
            }
            .action-title {
              font-size: 18px;
              font-weight: 600;
              color: #5b21b6;
              margin-bottom: 10px;
            }
            .action-text {
              color: #6d28d9;
              margin-bottom: 20px;
            }
            .action-buttons {
              display: flex;
              gap: 15px;
              justify-content: center;
              flex-wrap: wrap;
            }
            .action-button {
              padding: 12px 25px;
              border-radius: 8px;
              text-decoration: none;
              font-weight: 600;
              font-size: 14px;
              transition: all 0.3s ease;
              display: inline-flex;
              align-items: center;
              gap: 8px;
            }
            .btn-primary {
              background: linear-gradient(135deg, #3b82f6 0%, #1d4ed8 100%);
              color: white;
            }
            .btn-secondary {
              background: white;
              color: #374151;
              border: 2px solid #d1d5db;
            }
            .footer { 
              background: linear-gradient(135deg, #374151 0%, #1f2937 100%);
              color: #e5e7eb;
              text-align: center; 
              padding: 25px;
            }
            .footer-title {
              font-size: 16px;
              font-weight: 600;
              margin-bottom: 5px;
              color: #ffffff;
            }
            .footer-text {
              opacity: 0.8;
              font-size: 13px;
            }
            @media (max-width: 600px) {
              .info-grid {
                grid-template-columns: 1fr;
              }
              .action-buttons {
                flex-direction: column;
              }
            }
          </style>
        </head>
        <body>
          <div class="email-container">
            <div class="header">
              <div class="notification-icon">🔔</div>
              <h1>New Booking Alert!</h1>
              <div class="subtitle">A customer has just booked an appointment</div>
            </div>
            
            <div class="content">
              <div class="alert-message">
                ⚡ Immediate Action Required - New appointment booking needs your attention!
              </div>
              
              <div class="section-card customer">
                <div class="section-title">Customer Information</div>
                <div class="info-grid">
                  <div class="info-item">
                    <div class="info-label">Full Name</div>
                    <div class="info-value">${customer_name}</div>
                  </div>
                  <div class="info-item">
                    <div class="info-label">Email Address</div>
                    <div class="info-value">${customer_email}</div>
                  </div>
                  <div class="info-item">
                    <div class="info-label">Phone Number</div>
                    <div class="info-value">${customer_phone}</div>
                  </div>
                  <div class="info-item id">
                    <div class="info-label">Booking ID</div>
                    <div class="info-value">#${appointment_id}</div>
                  </div>
                </div>
              </div>
              
              <div class="section-card appointment">
                <div class="section-title">Appointment Details</div>
                <div class="info-grid">
                  <div class="info-item">
                    <div class="info-label">Service Type</div>
                    <div class="info-value">${service_name}</div>
                  </div>
                  <div class="info-item">
                    <div class="info-label">Date & Time</div>
                    <div class="info-value">${appointment_date} at ${appointment_time}</div>
                  </div>
                  <div class="info-item">
                    <div class="info-label">Payment Method</div>
                    <div class="info-value">${payment_method}</div>
                  </div>
                  <div class="info-item highlight">
                    <div class="info-label">Total Amount</div>
                    <div class="info-value">AED ${total_amount}</div>
                  </div>
                  <div class="info-item address-item full-width">
                    <div class="info-label">Service Address</div>
                    <div class="info-value">${address}</div>
                  </div>
                  ${notes ? `
                  <div class="info-item full-width">
                    <div class="info-label">Special Notes</div>
                    <div class="info-value">${notes}</div>
                  </div>
                  ` : ''}
                </div>
              </div>
              
              <div class="action-section">
                <div class="action-title">Next Steps Required</div>
                <div class="action-text">
                  Please assign a service provider and confirm this appointment in your admin panel.
                </div>
                <div class="action-buttons">
                  <a href="#" class="action-button btn-primary">
                    📋 Manage Booking
                  </a>
                  <a href="tel:${customer_phone}" class="action-button btn-secondary">
                    📞 Call Customer
                  </a>
                </div>
              </div>
            </div>
            
            <div class="footer">
              <div class="footer-title">AppointPro Dubai Admin System</div>
              <div class="footer-text">Automated booking notification system</div>
            </div>
          </div>
        </body>
        </html>
      `
    };

    const result = await transporter.sendMail(mailOptions);
    console.log('✅ Admin notification email sent:', result.messageId);
    
    return {
      success: true,
      message: 'Admin notification email sent successfully',
      messageId: result.messageId
    };
  } catch (error) {
    console.error('❌ Error sending admin notification email:', error);
    return {
      success: false,
      message: 'Failed to send admin notification email',
      error: error.message
    };
  }
}

// Send generic email
async function sendEmail(to, subject, htmlContent, textContent = null) {
  try {
    const transporter = createTransporter();
    
    const mailOptions = {
      from: `"${process.env.SMTP_FROM_NAME}" <${process.env.SMTP_FROM_EMAIL}>`,
      to: to,
      subject: subject,
      html: htmlContent,
      text: textContent || htmlContent.replace(/<[^>]*>/g, '') // Strip HTML for text version
    };

    const result = await transporter.sendMail(mailOptions);
    console.log('✅ Email sent successfully:', result.messageId);
    
    return {
      success: true,
      message: 'Email sent successfully',
      messageId: result.messageId
    };
  } catch (error) {
    console.error('❌ Error sending email:', error);
    return {
      success: false,
      message: 'Failed to send email',
      error: error.message
    };
  }
}

module.exports = {
  testEmailConnection,
  sendAppointmentConfirmation,
  sendAppointmentReminder,
  sendAdminNotification,
  sendEmail
};